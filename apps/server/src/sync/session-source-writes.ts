/**
 * Session satellites with writes outside the session persist funnel (POD-6789).
 * Each hook wraps the SOURCE write. Its ids are resolved inside the commit,
 * before either build, and the row and log share that commit's transaction.
 * Checkpoints, runtime events and offers already run in the persist funnel;
 * draft documents name their session when the coalesced document is written.
 */
import type { SessionId } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'
import type { SessionStore } from '../store'

export function installSessionSourceWrites(
  store: SessionStore,
  writer: Pick<LedgerWriter, 'commit'>,
): void {
  const compare = async <T>(ids: () => Promise<readonly SessionId[]>, write: () => Promise<T>) =>
    (
      await writer.commit({
        affects: async () => (await ids()).map((id) => ({ entity: 'session' as const, id })),
        write,
      })
    ).result

  store.sync.sessionRecordWrite = compare
  store.events.sessionPruneWrite = compare
  store.repos.sessionRecordWrite = async (path, write) =>
    await compare(
      async () => (await store.sessions.sessionsUnderPath(path)).map(({ id }) => id),
      write,
    )
  store.conversations.registry.sessionRecordWrite = async (machineId, nativeIds, write) =>
    await compare(
      async () =>
        [...(await store.sessions.listSessionsByResumeValues(nativeIds)).values()]
          .flat()
          .filter((row) => row.machineId === machineId)
          .map(({ id }) => id),
      write,
    )
  store.issues.setSessionRefWrite(
    async (ids, write) =>
      await compare(
        async () => (await store.sessions.sessionsReferencingIssues(ids)).map(({ id }) => id),
        write,
      ),
  )
}
