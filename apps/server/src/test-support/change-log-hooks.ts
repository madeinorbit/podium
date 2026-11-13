/**
 * The repository change-log hooks `relay.ts` installs, for a test that wires
 * its own Ledger over a real store (POD-6920): event appends and retention,
 * chat messages, session rows, superagent threads, effects and asks each run
 * as a change-log commit on `writer`, so their writes reach the log as they
 * do in the server instead of being refused for leaving a capture undrained.
 */

import type { LedgerWriter } from '@podium/sync'
import type { SessionStore } from '../store'
import { changeLogCommit } from '../store/change-log-commit'

export function installChangeLogHooks(
  store: Pick<SessionStore, 'events' | 'messages' | 'sessions' | 'superagent' | 'effects' | 'interactions'>,
  writer: Pick<LedgerWriter, 'commit'>,
): void {
  const commit = changeLogCommit(writer)
  store.events.setLogCommit(commit)
  store.messages.setFeedCapture(commit)
  store.sessions.setMessageWindowWrite(async (write) => {
    await commit(write)
  })
  store.superagent.setThreadFeedCapture(commit)
  store.effects.setFeedCapture(commit)
  store.interactions.setFeedCapture(commit)
}
