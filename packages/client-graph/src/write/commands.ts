/** Editable issue fields and validation for commands sent through the kernel. */
import type { MutationId } from '@podium/model'
import type { OutboxKinds } from '@podium/client-core/engine'

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

/** What an edit may SET. `readAt` is mark-read only: a non-null ISO instant. */
export interface EditPatches {
  issue: {
    title?: string
    stage?: EditableStage
    readAt?: string
  }
}

export type EditPatch<K extends WritableKind> = EditPatches[K]

export const EDITABLE_FIELDS = { issue: { title: true, stage: true, readAt: true } } as const

export type KernelCommand =
  | { readonly kind: 'issueUpdate'; readonly input: OutboxKinds['issueUpdate'] }
  | { readonly kind: 'issueMarkRead'; readonly input: OutboxKinds['issueMarkRead'] }

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

