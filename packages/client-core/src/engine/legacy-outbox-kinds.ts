// LEGACY(remove-after: 2027-03): the per-command outbox kinds that became generic record edits (POD-6404..6406), kept only to drain entries an older build queued and to reach a server without `sync.submit`; removing it strands those queued writes and stops a newer app marking read, snoozing or tucking on an older server.

/**
 * THE RETIRED PLAIN-EDIT KINDS, TWO WAYS (ADR 12 D3, POD-6404).
 *
 * The apps now write read marks, snoozes and tucks as generic record edits
 * (`records.<kind>.edit`). Two things still speak the old commands:
 *
 *  1. ENTRIES AN OLDER BUILD QUEUED. A reload after the upgrade finds them in
 *     the durable queue under their old kind and command. They drain exactly as
 *     they were made: the same command under the same mutationId, so the
 *     server's dedup still answers one that already landed. They paint nothing;
 *     the server's row shows when it lands.
 *  2. A SERVER WITHOUT `sync.submit` (a phone newer than its server). A record
 *     edit has no route there, so it is sent as the old command(s) it replaced,
 *     with the same effect. Only when the queue has already found the entry
 *     point missing (POD-6277's detection); never a second probe.
 */

import type { MutationId } from '@podium/model'
import { parseIssueUserStateRowId, parseSessionUserStateRowId } from '@podium/model'
import type { PodiumClientApi } from '../api'
import type { RecordEditEntry } from '../records'

/** The retired kinds and the command each was queued under. */
export const LEGACY_OUTBOX_COMMANDS = {
  sessionMarkRead: { name: 'sessions.markRead', version: 1 },
  sessionMarkUnread: { name: 'sessions.markUnread', version: 1 },
  snoozeSet: { name: 'snoozes.set', version: 1 },
  snoozeClear: { name: 'snoozes.clear', version: 1 },
  issueMarkRead: { name: 'issues.markRead', version: 1 },
  issueMarkUnread: { name: 'issues.markUnread', version: 1 },
  issueSetTucked: { name: 'issues.setTucked', version: 1 },
} as const

export type LegacyOutboxKind = keyof typeof LEGACY_OUTBOX_COMMANDS

export const isLegacyOutboxKind = (kind: string): kind is LegacyOutboxKind =>
  Object.hasOwn(LEGACY_OUTBOX_COMMANDS, kind)

/** `issueMarkRead` was the foreground reaction's own receipt: a refusal of one
 *  is bookkeeping to drop, as it always was. */
export const LEGACY_AUTOMATIC_KINDS: ReadonlySet<string> = new Set(['issueMarkRead'])

type Input = Record<string, unknown> & { readonly mutationId?: MutationId }

/** Run one queued entry of a retired kind under its old route. */
export function legacyOutboxExecutors(
  api: PodiumClientApi,
): Record<LegacyOutboxKind, (input: Input) => Promise<unknown>> {
  const call = (input: Input) => input as never
  return {
    sessionMarkRead: (i) => api.sessions.markRead.mutate(call(i)),
    sessionMarkUnread: (i) => api.sessions.markUnread.mutate(call(i)),
    snoozeSet: (i) => api.snoozes.set.mutate(call(i)),
    snoozeClear: (i) => api.snoozes.clear.mutate(call(i)),
    issueMarkRead: (i) => api.issues.markRead.mutate(call(i)),
    issueMarkUnread: (i) => api.issues.markUnread.mutate(call(i)),
    issueSetTucked: (i) => api.issues.setTucked.mutate(call(i)),
  }
}

/** One old call a record edit stands for. */
interface LegacyCall {
  readonly kind: LegacyOutboxKind
  readonly input: Record<string, unknown>
}

/**
 * The old commands a record edit stands for, in patch order, or `undefined`
 * when no old command can carry it (it is then refused, as a record write on
 * such a server always was).
 */
export function legacyCallsForRecordEdit(entry: RecordEditEntry): LegacyCall[] | undefined {
  const patch = entry.patch
  const unset = entry.unset ?? []
  const calls: LegacyCall[] = []
  const known = (names: readonly string[]) =>
    [...Object.keys(patch).filter((n) => patch[n] !== undefined), ...unset].every((n) =>
      names.includes(n),
    )
  switch (entry.kind) {
    case 'sessionUserState': {
      if (!known(['readAt', 'snoozedUntil'])) return undefined
      const { sessionId } = parseSessionUserStateRowId(entry.id)
      if (patch.readAt !== undefined) {
        calls.push(
          patch.readAt === null
            ? { kind: 'sessionMarkUnread', input: { sessionId } }
            : { kind: 'sessionMarkRead', input: { sessionId, readAt: patch.readAt } },
        )
      }
      if (patch.snoozedUntil !== undefined) {
        calls.push({ kind: 'snoozeSet', input: { sessionId, until: patch.snoozedUntil } })
      }
      if (unset.includes('snoozedUntil')) calls.push({ kind: 'snoozeClear', input: { sessionId } })
      return calls
    }
    case 'issueUserState': {
      if (!known(['readAt', 'tuckedAt'])) return undefined
      const { entityId: id } = parseIssueUserStateRowId(entry.id)
      if (patch.readAt !== undefined) {
        calls.push(
          patch.readAt === null
            ? { kind: 'issueMarkUnread', input: { id } }
            : { kind: 'issueMarkRead', input: { id, readAt: patch.readAt } },
        )
      }
      if (patch.tuckedAt !== undefined) {
        calls.push({ kind: 'issueSetTucked', input: { id, tucked: patch.tuckedAt !== null } })
      }
      return calls
    }
    default:
      return undefined
  }
}

/**
 * Send a record edit as its old commands. Each call gets its own replay id,
 * derived from the entry's, so a retry dedups call by call.
 */
export async function submitRecordEditAsLegacy(
  api: PodiumClientApi,
  entry: RecordEditEntry & { readonly mutationId: MutationId },
): Promise<unknown> {
  const calls = legacyCallsForRecordEdit(entry)
  if (calls === undefined) return undefined
  const executors = legacyOutboxExecutors(api)
  for (const [index, call] of calls.entries()) {
    const mutationId = (
      calls.length === 1 ? entry.mutationId : `${entry.mutationId}:${index}`
    ) as MutationId
    await executors[call.kind]({ ...call.input, mutationId })
  }
  return { ok: true }
}
