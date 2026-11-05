// LEGACY(remove-after: 2027-03): the per-command outbox kinds that became generic record edits (POD-6404..6406), kept only to drain entries an older build queued and to reach a server without `sync.submit`; removing it strands those queued writes and stops a newer app marking read, snoozing, tucking or stopping a session on an older server.

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
import {
  parseIssueUserStateRowId,
  parseLayoutRowId,
  parseSessionUserStateRowId,
} from '@podium/model'
import type { PodiumClientApi } from '../api'
import type { RecordEditEntry, RecordRemoveEntry } from '../records'

/** The retired kinds and the command each was queued under. */
export const LEGACY_OUTBOX_COMMANDS = {
  sessionMarkRead: { name: 'sessions.markRead', version: 1 },
  sessionMarkUnread: { name: 'sessions.markUnread', version: 1 },
  snoozeSet: { name: 'snoozes.set', version: 1 },
  snoozeClear: { name: 'snoozes.clear', version: 1 },
  issueMarkRead: { name: 'issues.markRead', version: 1 },
  issueMarkUnread: { name: 'issues.markUnread', version: 1 },
  issueSetTucked: { name: 'issues.setTucked', version: 1 },
  layoutSet: { name: 'layout.set', version: 1 },
  layoutClear: { name: 'layout.clear', version: 1 },
  issueArchive: { name: 'issues.archive', version: 1 },
  issueDefer: { name: 'issues.defer', version: 1 },
  issueUndefer: { name: 'issues.undefer', version: 1 },
  issueSetLabels: { name: 'issues.setLabels', version: 1 },
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
    layoutSet: (i) => api.layout.set.mutate(call(i)),
    layoutClear: (i) => api.layout.clear.mutate(call(i)),
    issueArchive: (i) => api.issues.archive.mutate(call(i)),
    issueDefer: (i) => api.issues.defer.mutate(call(i)),
    issueUndefer: (i) => api.issues.undefer.mutate(call(i)),
    issueSetLabels: (i) => api.issues.setLabels.mutate(call(i)),
  }
}

/**
 * The session lifecycle routes a record edit of `desired` (and a remove) stood
 * for before POD-6399. They were never queued, so they have no retired kind:
 * only the old-server path reaches them.
 */
type LifecycleRoute =
  | 'sessionStop'
  | 'sessionHibernate'
  | 'sessionResurrect'
  | 'sessionKill'
  | 'issueUpdate'

function lifecycleRoutes(
  api: PodiumClientApi,
): Record<LifecycleRoute, (input: Input) => Promise<unknown>> {
  const call = (input: Input) => input as never
  return {
    sessionStop: (i) => api.sessions.stop.mutate(call(i)),
    sessionHibernate: (i) => api.sessions.hibernate.mutate(call(i)),
    sessionResurrect: (i) => api.sessions.resurrect.mutate(call(i)),
    sessionKill: (i) => api.sessions.kill.mutate(call(i)),
    // An issue's plain fields that had no command of their own (POD-6405).
    issueUpdate: (i) => api.issues.update.mutate(call(i)),
  }
}

/** One old call a record write stands for. */
interface LegacyCall {
  readonly kind: LegacyOutboxKind | LifecycleRoute
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
    case 'issueProjection': {
      // The plain fields (POD-6405): labels, defer and undefer had their own
      // commands; the rest rode `issues.update`.
      if (unset.some((name) => name !== 'deferUntil')) return undefined
      const id = entry.id
      const { labels, deferUntil, ...rest } = patch
      if (Object.keys(rest).length > 0)
        calls.push({ kind: 'issueUpdate', input: { id, patch: rest } })
      if (labels !== undefined) calls.push({ kind: 'issueSetLabels', input: { id, labels } })
      if (unset.includes('deferUntil'))
        calls.push({ kind: 'issueDefer', input: { id, until: null } })
      else if (typeof deferUntil === 'string') {
        const at = Date.parse(deferUntil)
        calls.push(
          Number.isFinite(at) && at <= Date.now()
            ? { kind: 'issueUndefer', input: { id } }
            : { kind: 'issueDefer', input: { id, until: deferUntil } },
        )
      }
      return calls
    }
    case 'userLayout': {
      const { key } = parseLayoutRowId(entry.id)
      if (unset.includes('value')) return [{ kind: 'layoutClear', input: { keys: [key] } }]
      if (!known(['value'])) return undefined
      return [{ kind: 'layoutSet', input: { values: { [key]: patch.value } } }]
    }
    case 'session': {
      // The lifecycle (POD-6399): `desired`, and `force` with a stop.
      if (!known(['desired', 'force'])) return undefined
      const sessionId = entry.id
      switch (patch.desired) {
        case 'stopped':
          return [
            {
              kind: 'sessionStop',
              input: { sessionId, ...(patch.force === true ? { force: true } : {}) },
            },
          ]
        case 'hibernated':
          return [{ kind: 'sessionHibernate', input: { sessionId } }]
        case 'running':
          return [{ kind: 'sessionResurrect', input: { sessionId } }]
        default:
          return undefined
      }
    }
    default:
      return undefined
  }
}

/** The old command a record remove stands for: a session's is kill. */
export function legacyCallsForRecordRemove(entry: RecordRemoveEntry): LegacyCall[] | undefined {
  switch (entry.kind) {
    case 'session':
      return [{ kind: 'sessionKill', input: { sessionId: entry.id } }]
    case 'userLayout':
      return [{ kind: 'layoutClear', input: { keys: [parseLayoutRowId(entry.id).key] } }]
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
  return await runLegacy(api, entry.mutationId, legacyCallsForRecordEdit(entry))
}

/** Send a record remove as its old command. */
export async function submitRecordRemoveAsLegacy(
  api: PodiumClientApi,
  entry: RecordRemoveEntry & { readonly mutationId: MutationId },
): Promise<unknown> {
  return await runLegacy(api, entry.mutationId, legacyCallsForRecordRemove(entry))
}

async function runLegacy(
  api: PodiumClientApi,
  mutationId: MutationId,
  calls: readonly LegacyCall[] | undefined,
): Promise<unknown> {
  if (calls === undefined) return undefined
  const entry = { mutationId }
  const executors = { ...legacyOutboxExecutors(api), ...lifecycleRoutes(api) }
  for (const [index, call] of calls.entries()) {
    const mutationId = (
      calls.length === 1 ? entry.mutationId : `${entry.mutationId}:${index}`
    ) as MutationId
    await executors[call.kind]({ ...call.input, mutationId })
  }
  return { ok: true }
}
