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

import type { OutboxEntry } from '@podium/client-core/outbox'
import type { Replica } from '@podium/client-core/replica'
import type { EngineOutbox, OutboxOutcome } from '@podium/client-core/runtime-root'
import { parseIssueUserStateRowId } from '@podium/model'
import type {
  FieldValues,
  KernelCommand,
  OutboxPendingWrite,
  TxId,
  WriteError,
  WriteTransport,
} from './write-contract'

/** What the stream needs from a `ClientRuntime`: its outcome seam, its
 *  queue and its own pending entries, plus replica truth for the
 *  enqueue-time baseline `send` files on each entry. */
export interface ReceiptsRuntime {
  subscribeOutboxOutcomes(listener: (outcome: OutboxOutcome) => void): () => void
  readonly services: {
    readonly outbox: { readonly queue: Pick<EngineOutbox, 'enqueue' | 'pending' | 'awaiting'> }
  }
  readonly replica: Pick<Replica, 'row'>
  readonly principal: { readonly userId: string }
}

/**
 * One outcome for one transaction. `kind` is the outbox kind (`issueUpdate`,
 * `recordEdit`, …) and `id` the entity id in its input (an issue's id for a
 * mark-read, whose row id names its issue). A superseded entry
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
  const i = input as { kind?: unknown; id?: unknown } | null | undefined
  if (typeof i?.id !== 'string') return undefined
  // A mark-read is a record edit of my own issue row (POD-6404): its target is
  // the issue the row is about.
  return i.kind === 'issueUserState' ? parseIssueUserStateRowId(i.id).entityId : i.id
}

const isMarkRead = (entry: { kind: string; input: unknown }): boolean =>
  entry.kind === 'recordEdit' && (entry.input as { kind?: unknown }).kind === 'issueUserState'

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
 * Enqueue-time baselines `send` filed, per outbox instance and transaction id.
 * In memory only, as the kernel queue kept them before POD-6279 removed them
 * from the outbox: a reloaded outbox has none, nor does a write the pool made
 * or one enqueued before its row was known. The reference pending log reads
 * them; production does not.
 */
const baselines = new WeakMap<object, Map<string, string>>()

/** A row's DATA fields, keys sorted (no `$` metadata), as one string. */
function fingerprint(row: object): string {
  const data: Record<string, unknown> = {}
  for (const k of Object.keys(row).sort()) {
    if (!k.startsWith('$')) data[k] = (row as Record<string, unknown>)[k]
  }
  return JSON.stringify(data)
}

/**
 * The enqueue-time server values of the fields an entry patches, read from the
 * baseline `send` filed under its id (the replica row fingerprinted at
 * enqueue).
 *
 * Exported for the phase-c gate adapter (`gen/arm-edits.ts`), which rebuilds
 * `OutboxPendingWrite`s for a re-created arm after a reload (POD-4574).
 */
export function baseOf(outbox: object, entry: OutboxEntry): FieldValues<'issue'> | undefined {
  const baseline = baselines.get(outbox)?.get(entry.mutationId)
  if (baseline === undefined) return undefined
  let row: Record<string, unknown>
  try {
    const parsed = JSON.parse(baseline) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    row = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  if (isMarkRead(entry)) return { readAt: text(row.readAt) }
  if (entry.kind === 'issueUpdate') {
    const patch = (entry.input as { patch?: Record<string, unknown> }).patch ?? {}
    const base: { title?: string; stage?: string } = {}
    if ('title' in patch && typeof row.title === 'string') base.title = row.title
    if ('stage' in patch && typeof row.stage === 'string') base.stage = row.stage
    return Object.keys(base).length === 0 ? undefined : base
  }
  return undefined
}

function pendingWrite(outbox: object, entry: OutboxEntry, acked: boolean): OutboxPendingWrite {
  const base = baseOf(outbox, entry)
  return {
    txId: entry.mutationId,
    kind: entry.kind,
    input: entry.input,
    queuedAt: entry.queuedAt,
    acked,
    ...(base === undefined ? {} : { base }),
  }
}

/**
 * The enqueue-time baseline `send` files: the fingerprint of the truth row
 * these two commands land on — the principal's marker for a mark-read, the
 * projection for an update (mirrors the row-source `truth` reader). `undefined` when the row
 * is not in the replica, exactly like an entry enqueued before its row was
 * known.
 */
function sendBaseline(runtime: ReceiptsRuntime, command: KernelCommand): string | undefined {
  const row =
    command.kind === 'recordEdit'
      ? runtime.replica.row?.('issueUserStates', command.input.id)
      : runtime.replica.row?.('issueProjections', command.input.id)
  return row === undefined ? undefined : fingerprint(row)
}

/** A {@link WriteTransport} whose events carry the outbox kind and target id.
 *  Assignable to `WriteTransport`: every {@link ReceiptEvent} is a `WriteEvent`. */
export interface ReceiptTransport extends Omit<WriteTransport, 'subscribe'> {
  subscribe(listener: (event: ReceiptEvent) => void): () => void
}

/**
 * The {@link WriteTransport} a phase-c arm sends through (W2): `send` enqueues
 * under the arm's txId into the outbox, filing the enqueue-time baseline
 * (`sendBaseline`) beside it; `subscribe`
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
    runtime.services.outbox.queue.pending().some((e) => e.mutationId === txId) ||
    runtime.services.outbox.queue.awaiting().some((e) => e.mutationId === txId)

  return {
    send(txId, command: KernelCommand) {
      const baseline = sendBaseline(runtime, command)
      if (baseline !== undefined) {
        let filed = baselines.get(runtime.services.outbox.queue)
        if (filed === undefined) baselines.set(runtime.services.outbox.queue, (filed = new Map()))
        filed.set(txId, baseline)
      }
      const opts = { mutationId: txId }
      const enqueued =
        command.kind === 'issueUpdate'
          ? runtime.services.outbox.queue.enqueue('issueUpdate', command.input, opts)
          : runtime.services.outbox.queue.enqueue('recordEdit', command.input, opts)
      Promise.resolve(enqueued).catch((error: unknown) => {
        // The throw came after the entry reached the queue: the kernel still
        // owes it an outcome, and will report it.
        if (inQueue(txId)) return
        const event: ReceiptEvent = {
          type: 'rejected',
          txId,
          kind: command.kind,
          id: targetId(command.input),
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
        ...runtime.services.outbox.queue
          .pending()
          .map((e) => pendingWrite(runtime.services.outbox.queue, e, false)),
        ...runtime.services.outbox.queue
          .awaiting()
          .map((e) => pendingWrite(runtime.services.outbox.queue, e, true)),
      ]
    },
  }
}
