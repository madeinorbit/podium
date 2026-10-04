/**
 * POD-4554 (L3b) — the receipts stream: the server's yes or no for each
 * pending write, keyed by transaction id, and the {@link WriteTransport} the
 * phase-c arms send through (write contract W2, W7, W9, W11;
 * `docs/plans/pod-4545-round-three-write-contract.md`).
 *
 * WHERE THE ANSWERS COME FROM. The runtime's outbox outcome seam
 * (`ClientRuntime.subscribeOutboxOutcomes`), which reports each queue entry's
 * outcome under its mutation id, after the kernel's own handling:
 *
 * - `accepted` is the outbox `applied` event: the Authority applied it. It is
 *   NOT the echo. The wire change row carries no mutation id
 *   (`replica/feed/frames.ts`), so an echo cannot name its transaction; the
 *   arm's pending log recognises echoes by value (W7).
 * - `rejected` is a definitive refusal (parked or discarded), or the enqueue
 *   itself failing inside {@link createWriteTransport}'s `send`.
 * - `superseded` is the outbox collapsing a still-queued entry into a later
 *   one (POD-785; among slice edits only mark-read).
 *
 * WHAT IT NEVER READS: the folded snapshot arrays, the optimism ledger's
 * overlays, or the awaiting-truth `retired` event (W12). `pending()` reads the
 * queue's own entries.
 *
 * ONE OUTCOME PER TRANSACTION. Each subscription delivers at most one event per
 * txId; a later outcome for the same id (a recovery-surface retry that then
 * applies, a post-enqueue failure racing the drain) is dropped. The arm's log
 * treats a late or unknown txId as a no-op anyway (S4); this makes the stream
 * say so itself.
 *
 * OWNERSHIP. Additive, round three (POD-4545).
 */

import type { EngineOutbox, OutboxOutcome } from '@podium/client-core/engine'
import type { OutboxEntry } from '@podium/client-core/outbox'
import type {
  FieldValues,
  KernelCommand,
  OutboxPendingWrite,
  TxId,
  WriteError,
  WriteTransport,
} from './write-contract'

/** What the stream needs from a `ClientRuntime`: its outcome seam, its
 *  queue and its own pending entries. */
export interface ReceiptsRuntime {
  subscribeOutboxOutcomes(listener: (outcome: OutboxOutcome) => void): () => void
  readonly outbox: Pick<EngineOutbox, 'enqueue' | 'pending' | 'awaiting'>
}

/**
 * One outcome for one transaction. `kind` is the outbox kind (`issueUpdate`,
 * `issueMarkRead`, …) and `id` the entity id in its input. A superseded entry
 * the queue could no longer see carries neither. Assignable to the write
 * contract's `WriteEvent`.
 */
export type ReceiptEvent =
  | {
      readonly type: 'accepted'
      readonly txId: TxId
      readonly kind: string
      readonly id: string | undefined
    }
  | {
      readonly type: 'rejected'
      readonly txId: TxId
      readonly kind: string
      readonly id: string | undefined
      readonly error: WriteError
    }
  | {
      readonly type: 'superseded'
      readonly txId: TxId
      readonly kind: string | undefined
      readonly id: string | undefined
    }

function targetId(input: unknown): string | undefined {
  const id = (input as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

function toReceipt(outcome: OutboxOutcome): ReceiptEvent {
  switch (outcome.type) {
    case 'applied':
      return {
        type: 'accepted',
        txId: outcome.mutationId,
        kind: outcome.entry.kind,
        id: targetId(outcome.entry.input),
      }
    case 'rejected': {
      const code = outcome.reason?.code
      return {
        type: 'rejected',
        txId: outcome.mutationId,
        kind: outcome.entry.kind,
        id: targetId(outcome.entry.input),
        error: {
          message: `${outcome.entry.kind} refused${code === undefined ? '' : ` (${code})`}`,
          ...(code === undefined ? {} : { code }),
          parked: outcome.parked,
        },
      }
    }
    case 'superseded':
      return {
        type: 'superseded',
        txId: outcome.mutationId,
        kind: outcome.entry?.kind,
        id: targetId(outcome.entry?.input),
      }
  }
}

type Source = (listener: (event: ReceiptEvent) => void) => () => void

/** Merge sources and deliver each txId's FIRST outcome only. */
function once(sources: readonly Source[], listener: (event: ReceiptEvent) => void): () => void {
  const answered = new Set<string>()
  const deliver = (event: ReceiptEvent): void => {
    if (answered.has(event.txId)) return
    answered.add(event.txId)
    listener(event)
  }
  const offs = sources.map((source) => source(deliver))
  return () => {
    for (const off of offs) off()
  }
}

const kernelSource =
  (runtime: ReceiptsRuntime): Source =>
  (listener) =>
    runtime.subscribeOutboxOutcomes((outcome) => listener(toReceipt(outcome)))

/**
 * The kernel's outcome for every queued write, keyed by its outbox mutation id
 * (the transaction id), at most once per id. Returns the unsubscribe.
 */
export function subscribeReceipts(
  runtime: ReceiptsRuntime,
  listener: (event: ReceiptEvent) => void,
): () => void {
  return once([kernelSource(runtime)], listener)
}

/**
 * The enqueue-time server values of the fields an entry patches, read from the
 * queue entry's own `baseline` (the replica row fingerprinted at enqueue). The
 * kernel queue keeps it in memory only, so an entry restored by a reload has
 * none, and neither does one enqueued before its row was known.
 *
 * Exported for the phase-c gate adapter (`gen/arm-edits.ts`), which rebuilds
 * `OutboxPendingWrite`s for a re-created arm after a reload (POD-4574).
 */
export function baseOf(entry: OutboxEntry): FieldValues<'issue'> | undefined {
  if (entry.baseline === undefined) return undefined
  let row: Record<string, unknown>
  try {
    const parsed = JSON.parse(entry.baseline) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    row = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  if (entry.kind === 'issueMarkRead') return { readAt: text(row.readAt) }
  if (entry.kind === 'issueUpdate') {
    const patch = (entry.input as { patch?: Record<string, unknown> }).patch ?? {}
    const base: { title?: string; stage?: string } = {}
    if ('title' in patch && typeof row.title === 'string') base.title = row.title
    if ('stage' in patch && typeof row.stage === 'string') base.stage = row.stage
    return Object.keys(base).length === 0 ? undefined : base
  }
  return undefined
}

function pendingWrite(entry: OutboxEntry, acked: boolean): OutboxPendingWrite {
  const base = baseOf(entry)
  return {
    txId: entry.mutationId,
    kind: entry.kind,
    input: entry.input,
    queuedAt: entry.queuedAt,
    acked,
    ...(base === undefined ? {} : { base }),
  }
}

/** A {@link WriteTransport} whose events carry the outbox kind and target id.
 *  Assignable to `WriteTransport`: every {@link ReceiptEvent} is a `WriteEvent`. */
export interface ReceiptTransport extends Omit<WriteTransport, 'subscribe'> {
  subscribe(listener: (event: ReceiptEvent) => void): () => void
}

/**
 * The {@link WriteTransport} a phase-c arm sends through (W2): `send` enqueues
 * under the arm's txId into the outbox; `subscribe`
 * is {@link subscribeReceipts} plus a `rejected` for an enqueue that failed;
 * `pending` lists queued then awaiting-truth entries in queue order (W11).
 */
export function createWriteTransport(runtime: ReceiptsRuntime): ReceiptTransport {
  const failures = new Set<(event: ReceiptEvent) => void>()
  const failureSource: Source = (listener) => {
    failures.add(listener)
    return () => failures.delete(listener)
  }
  const inQueue = (txId: TxId): boolean =>
    runtime.outbox.pending().some((e) => e.mutationId === txId) ||
    runtime.outbox.awaiting().some((e) => e.mutationId === txId)

  return {
    send(txId, command: KernelCommand) {
      const opts = { mutationId: txId }
      const enqueued =
        command.kind === 'issueUpdate'
          ? runtime.outbox.enqueue('issueUpdate', command.input, opts)
          : runtime.outbox.enqueue('issueMarkRead', command.input, opts)
      enqueued.catch((error: unknown) => {
        // The throw came after the entry reached the queue: the kernel still
        // owes it an outcome, and will report it.
        if (inQueue(txId)) return
        const event: ReceiptEvent = {
          type: 'rejected',
          txId,
          kind: command.kind,
          id: command.input.id,
          error: { message: error instanceof Error ? error.message : String(error), parked: false },
        }
        for (const listener of [...failures]) listener(event)
      })
    },
    subscribe(listener) {
      return once([kernelSource(runtime), failureSource], listener)
    },
    pending() {
      return [
        ...runtime.outbox.pending().map((e) => pendingWrite(e, false)),
        ...runtime.outbox.awaiting().map((e) => pendingWrite(e, true)),
      ]
    },
  }
}
