/** Prior-value reference transport contracts used only by the worklist regression harness. */
import type { OutboxKinds } from '@podium/client-core/engine'
import { EDITABLE_STAGES, type TxId, type EditableStage, type WritableKind, type EditPatch, type KernelCommand } from '@podium/client-graph/write/commands'
export * from '@podium/client-graph/write/commands'

/** The values an object HOLDS for each editable field — what `prior` records. */
export interface WritableFields {
  issue: {
    title: string
    /** Any stage the server may send; only {@link EditableStage} can be written. */
    stage: string
    readAt: string | null
  }
}

export type FieldName<K extends WritableKind> = keyof WritableFields[K] & string
export type FieldValues<K extends WritableKind> = Partial<WritableFields[K]>

/**
 * How a server value is recognised as the echo of a pending value (W7).
 *
 * - `exact`: the server lands the value verbatim, so the echo EQUALS it
 *   (`issues.update` never rewrites a key it was sent; overlay.ts:371-391).
 * - `stamp`: the server writes its OWN clock, so the echo is any non-null
 *   value that differs from the server value at edit time — the kernel's own
 *   `issueMarkRead` coverage predicate (overlay.ts:326-341).
 */
export type Coverage = 'exact' | 'stamp'

export const FIELD_COVERAGE: { readonly [K in WritableKind]: { readonly [F in FieldName<K>]: Coverage } } = {
  issue: { title: 'exact', stage: 'exact', readAt: 'stamp' },
}

// ---------------------------------------------------------------------------
// Log records
// ---------------------------------------------------------------------------

/** The kernel reports the Authority applied the mutation (outbox `applied`). */
export interface Receipt {
  readonly txId: TxId
}

export interface WriteError {
  readonly message: string
  /** The kernel's refusal code when there is one (`OutboxRejectionReason`). */
  readonly code?: string
  /**
   * True when the kernel PARKED the entry for recovery rather than dropping it
   * — authored text (a title) is kept in the dead-letter home so the words are
   * not lost (wiring.ts `shouldParkDeadLetter`). Either way the object rewinds.
   */
  readonly parked: boolean
}

/** Definitive refusal: outbox `dead-lettered`, or the enqueue itself failed. */
export interface Rejection {
  readonly txId: TxId
  readonly error: WriteError
}

/**
 * The outbox collapsed this still-queued entry into a later one with the same
 * collapse key (POD-785; `issue-read:<id>` for mark-read). It was never sent
 * and will get no receipt; its successor carries the intent (W9).
 */
export interface Superseded {
  readonly txId: TxId
}

/** One outcome event per txId, from the receipts stream (L3b, POD-4554). */
export type WriteEvent =
  | ({ readonly type: 'accepted' } & Receipt)
  | ({ readonly type: 'rejected' } & Rejection)
  | ({ readonly type: 'superseded' } & Superseded)

/** An outbox entry still owed an outcome, as bootstrap reads it (W11). */
export interface OutboxPendingWrite {
  readonly txId: TxId
  /** Outbox kind; entries of kinds outside the slice are skipped. */
  readonly kind: string
  readonly input: unknown
  /** `OutboxEntry.queuedAt` — the clock the kernel stamps mark-read with. */
  readonly queuedAt: number
  /** True for the kernel's awaiting-truth stage: the receipt already arrived. */
  readonly acked: boolean
  /** Enqueue-time server values of the patched fields, when the kernel kept
   *  them (`baselineCell`). The `stamp` coverage reads it. */
  readonly base?: FieldValues<'issue'>
}

/**
 * What the arm needs from the kernel (L3b, POD-4554 provides it). The arm
 * never reads the outbox, the ledger or the folded snapshot directly.
 */
export interface WriteTransport {
  /** Enqueue `command` under `txId` through the outbox
   *  seam with `opts.mutationId = txId` (W2). Fire-and-forget: an enqueue
   *  failure comes back as a `rejected` event for the same txId. */
  send(txId: TxId, command: KernelCommand): void
  subscribe(listener: (event: WriteEvent) => void): () => void
  /** Queued then awaiting-truth entries, in kernel queue order. */
  pending(): readonly OutboxPendingWrite[]
}

const EDITABLE_STAGE_SET: ReadonlySet<string> = new Set(EDITABLE_STAGES)

/**
 * The slice edit an outbox entry carries, for bootstrap re-apply (W11). Null
 * when the entry is outside the slice. An `issues.update` from another surface
 * restores only its title/stage keys; the rest of its patch is not a slice field.
 */
export function editForPendingWrite(
  entry: OutboxPendingWrite,
): { kind: 'issue'; id: string; patch: EditPatch<'issue'> } | null {
  if (entry.kind === 'issueMarkRead') {
    const input = entry.input as OutboxKinds['issueMarkRead']
    return { kind: 'issue', id: input.id, patch: { readAt: new Date(entry.queuedAt).toISOString() } }
  }
  if (entry.kind === 'issueUpdate') {
    const input = entry.input as { id: string; patch: Record<string, unknown> }
    const patch: EditPatch<'issue'> = {}
    if (typeof input.patch.title === 'string') patch.title = input.patch.title
    if (typeof input.patch.stage === 'string' && EDITABLE_STAGE_SET.has(input.patch.stage)) {
      patch.stage = input.patch.stage as EditableStage
    }
    return Object.keys(patch).length === 0 ? null : { kind: 'issue', id: input.id, patch }
  }
  return null
}

/**
 * Wall time, like the kernel's awaiting-truth TTL: the clock a transaction log
 * stamps presses and arms its TTL timer with.
 */
export const wallClockNow = (): number => Date.now()
