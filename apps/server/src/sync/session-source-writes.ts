/**
 * Session satellites with writes outside the session persist funnel (POD-6789).
 * Each hook runs the SOURCE write as a change-log commit: the database
 * captures the rows it changed, and the commit drains that capture in the
 * same transaction, so the session records those rows reach are appended with
 * it (POD-6920). Checkpoints, runtime events and offers already run in the
 * persist funnel; draft documents run in their own commit.
 */
import { changeLogCommit } from '../store/change-log-commit'
import type { LedgerWriter } from '@podium/sync'
import type { SessionStore } from '../store'

export function installSessionSourceWrites(
  store: SessionStore,
  writer: Pick<LedgerWriter, 'commit'>,
): void {
  // Joins a change-log commit already running (POD-6920).
  const commit = changeLogCommit(writer)
  store.sync.sessionRecordWrite = commit
  store.repos.sessionRecordWrite = commit
  store.conversations.registry.sessionRecordWrite = commit
  store.issues.setSessionRefWrite(commit)
}
