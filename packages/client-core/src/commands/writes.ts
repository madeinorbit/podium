import type { SessionId } from '@podium/model'
import { asIssueId, issueUserStateRowId, sessionUserStateRowId } from '@podium/model'
import type { PodiumClientApi } from '../api'
import { createRecordsApi, type RecordKind, type RecordPatch, type RecordRef } from '../records'
import { NAVIGATION_LOADING } from '../ui/state'

import type { CommandDeps } from './context'
import { commandFailureReporter, reportCommandFailures } from './failures'
export function createCommandWrites<TApi extends PodiumClientApi>(rt: CommandDeps<TApi>) {
  const reportFailure = commandFailureReporter(rt.notices)
  const records = reportCommandFailures(
    createRecordsApi((kind, input) => rt.write(kind, input)),
    reportFailure,
  )
  // The navigation reaction and the row gesture can request the same read
  // before durable enqueue has painted its overlay. Share that in-flight act.
  const pendingReads = new Map<string, { readAt?: string; write: Promise<void> }>()
  /** One generic edit of a plain record (ADR 12 D3): it paints at once and
   *  retires with its outbox entry (POD-6404). Through `records`, which loads
   *  the declarations first if no outbox open has (POD-6423). */
  const editRecord = <K extends RecordKind>(
    ref: RecordRef<K>,
    patch: RecordPatch<K>,
  ): Promise<void> => records.edit(ref, patch)
  const mySessionState = (sessionId: SessionId): RecordRef<'sessionUserState'> => ({
    kind: 'sessionUserState',
    id: sessionUserStateRowId(rt.userId, sessionId),
  })
  const myIssueState = (id: string): RecordRef<'issueUserState'> => ({
    kind: 'issueUserState',
    id: issueUserStateRowId(rt.userId, asIssueId(id)),
  })
  /**
   * The read mark a press without one writes: what this device has seen. It
   * is now, or the last activity it holds if that is later (a server clock
   * ahead of this one), so the mark covers every message on screen and the
   * dot does not come back when the server's row lands.
   */
  const coveringReadAt = (activityAt: unknown): string => {
    const now = new Date().toISOString()
    return typeof activityAt === 'string' && activityAt > now ? activityAt : now
  }
  const sessionActivity = (sessionId: SessionId): unknown => {
    const session = rt.state().navigation.session(sessionId)
    return session === NAVIGATION_LOADING ? undefined : session?.lastActiveAt
  }
  const issueActivity = (id: string): unknown => {
    const at = rt.state().navigation.activityAt(id)
    return at === NAVIGATION_LOADING ? undefined : at
  }
  const markRead = (
    kind: 'issue' | 'session',
    id: string,
    input: { readonly readAt?: string },
  ): Promise<void> => {
    // A start still painted has no session on the server, so its read mark
    // would be refused ("Couldn't save session read status", POD-6622). Its
    // paint already reads as read; the real row's own visit marks it.
    if (kind === 'session' && rt.launchPainted?.(id as SessionId) === true) return Promise.resolve()
    const key = `${kind}:${id}`
    const pending = pendingReads.get(key)
    const readAt = input.readAt
    const send = (): Promise<void> =>
      kind === 'session'
        ? editRecord(mySessionState(id as SessionId), {
            readAt: readAt ?? coveringReadAt(sessionActivity(id as SessionId)),
          })
        : editRecord(myIssueState(id), { readAt: readAt ?? coveringReadAt(issueActivity(id)) })
    if (
      pending &&
      (readAt === pending.readAt || (readAt && pending.readAt && readAt <= pending.readAt))
    )
      return pending.write
    // A visit can end before its leading enqueue finishes. Preserve that last
    // observation in order rather than dropping it as a duplicate.
    const write: Promise<void> = (
      pending
        ? pending.write.then(() => (pendingReads.get(key)?.write === write ? send() : undefined))
        : send()
    ).finally(() => {
      if (pendingReads.get(key)?.write === write) pendingReads.delete(key)
    })
    pendingReads.set(key, { readAt, write })
    return write
  }

  return {
    records,
    editRecord,
    mySessionState,
    myIssueState,
    markRead,
    pendingReads,
    reportFailure,
  }
}
export type CommandWrites = ReturnType<typeof createCommandWrites>
