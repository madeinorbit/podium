/**
 * POD-4548 (L1c) — the optimistic write contract the phase-c issues implement
 * (Mc1/Mc2 on MobX, Hc1/Hc2 hand-rolled).
 *
 * THE SHAPE (Linear's, audit `docs/decisions/4441-round-two-audit.md` §7): an
 * edit is applied to the in-memory object AT ONCE, recorded in a pending log
 * with the values it replaced, and sent through the kernel, which stays the
 * transport. The kernel's answer settles it: a receipt forgets the entry, a
 * rejection rewinds the object. Fast first, truthful second.
 *
 * THE RULES are stated in `docs/plans/pod-4545-round-three-write-contract.md`
 * and numbered there (W1–W12); the comments below cite them.
 *
 * POD-5432: the product pool no longer keeps a pending log of PRIOR VALUES.
 * Its transaction log (`write/transactions.ts`) rolls back by rebase (server
 * truth with the remaining transactions folded over it), so nothing restores
 * a stored value. What stays here is the editable surface, the command
 * mapping and the transport types. The prior-value reference log (W4–W10)
 * moved to the prototype harness that still compares against it
 * (`tests/worklist/shared/src/pending-log.ts`).
 *
 * OWNERSHIP. Additive, round three (POD-4545). Type-only imports from the
 * kernel, so importing this file pulls no engine code into an arm's bundle.
 */

import type { MutationId } from '@podium/model'
import type { OutboxKinds } from '@podium/client-core/engine'

// ---------------------------------------------------------------------------
// Identity and the editable surface
// ---------------------------------------------------------------------------

/**
 * A transaction id IS the outbox mutation id (W2). The arm mints it in
 * `edit()` and hands it to the kernel's enqueue, which stores it on the outbox
 * entry, sends it as the tRPC input's `mutationId` (the server's dedupe key)
 * and reports it on every outbox event. It survives a reload with the entry.
 */
export type TxId = MutationId

/** Entities with editable fields in the slice. Sessions and worktrees have none. */
export type WritableKind = 'issue'

/**
 * Stages a status control sets through `issues.update`: the `stage` branch of
 * `issueStatusIntent` (`packages/model/src/entities/issue-status.ts`). The
 * terminal statuses are `issues.close` (a different command that also stamps
 * `closedReason`) and are not slice edits (W3).
 */
export const EDITABLE_STAGES = ['backlog', 'planning', 'in_progress', 'review'] as const
export type EditableStage = (typeof EDITABLE_STAGES)[number]

/** The values an object HOLDS for each editable field — what `prior` records. */
export interface WritableFields {
  issue: {
    title: string
    /** Any stage the server may send; only {@link EditableStage} can be written. */
    stage: string
    readAt: string | null
  }
}

/** What an edit may SET. `readAt` is mark-read only: a non-null ISO instant. */
export interface EditPatches {
  issue: {
    title?: string
    stage?: EditableStage
    readAt?: string
  }
}

export type FieldName<K extends WritableKind> = keyof WritableFields[K] & string
export type EditPatch<K extends WritableKind> = EditPatches[K]
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

// ---------------------------------------------------------------------------
// The interfaces an arm implements or consumes
// ---------------------------------------------------------------------------

/**
 * The kernel command that carries an edit, typed against the kernel's own
 * `OutboxKinds` so a drift in the outbox inputs fails typecheck here (W3).
 */
export type KernelCommand =
  | { readonly kind: 'issueUpdate'; readonly input: OutboxKinds['issueUpdate'] }
  | { readonly kind: 'issueMarkRead'; readonly input: OutboxKinds['issueMarkRead'] }

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

// ---------------------------------------------------------------------------
// Mapping: edit -> kernel command, outbox entry -> edit
// ---------------------------------------------------------------------------

export class WriteContractError extends Error {
  override readonly name = 'WriteContractError'
}

const EDITABLE_STAGE_SET: ReadonlySet<string> = new Set(EDITABLE_STAGES)
const ISSUE_FIELDS: ReadonlySet<string> = new Set(['title', 'stage', 'readAt'])

/**
 * The command an edit rides (W3). Throws before any state changes when the
 * patch is not one slice command: empty, an unknown field, a non-editable
 * stage, a null `readAt`, or `readAt` mixed with title/stage (two commands,
 * two transactions — the caller makes two edits).
 */
export function commandFor<K extends WritableKind>(kind: K, id: string, patch: EditPatch<K>): KernelCommand {
  if (kind !== 'issue') throw new WriteContractError(`no editable fields on ${String(kind)}`)
  const p = patch as EditPatch<'issue'> & Record<string, unknown>
  const keys = Object.keys(p)
  if (keys.length === 0) throw new WriteContractError('empty patch')
  for (const k of keys) {
    if (!ISSUE_FIELDS.has(k)) throw new WriteContractError(`field ${k} is not editable`)
    if (p[k] === undefined) throw new WriteContractError(`field ${k} is undefined`)
  }
  if ('readAt' in p) {
    if (keys.length > 1) throw new WriteContractError('readAt is its own command (issues.markRead); edit it alone')
    if (typeof p.readAt !== 'string') throw new WriteContractError('readAt must be an ISO instant; mark-unread is not a slice edit')
    return { kind: 'issueMarkRead', input: { id } }
  }
  if (p.stage !== undefined && !EDITABLE_STAGE_SET.has(p.stage)) {
    throw new WriteContractError(`stage ${p.stage} is not set through issues.update (close is issues.close)`)
  }
  if (p.title !== undefined && typeof p.title !== 'string') throw new WriteContractError('title must be a string')
  const out: { title?: string; stage?: EditableStage } = {}
  if (p.title !== undefined) out.title = p.title
  if (p.stage !== undefined) out.stage = p.stage
  return { kind: 'issueUpdate', input: { id, patch: out } }
}

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
