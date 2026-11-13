/**
 * A REPOSITORY WRITE RUN AS ONE CHANGE-LOG COMMIT (POD-6920).
 *
 * Repositories whose every write must reach the log, whoever makes it (chat
 * messages, asks, superagent threads, effects, the event log), take this
 * hook from the composition root and run each write through it: the commit
 * runs the write in its own transaction (a savepoint inside an enclosing
 * one), drains what the write captured and appends the records it reached.
 * Inside a change-log commit already running (a command whose write reaches
 * one of these tables) the write joins it: that commit drains it with the
 * rest of its write. Without a hook (a store-level test) the write runs as is.
 */

import type { LedgerWriter } from '@podium/sync'
import { changeLogCommitOpen } from './commit-open'

export type ChangeLogCommit = <T>(write: () => Promise<T>) => Promise<T>

/** The hook over a Ledger writer. */
export function changeLogCommit(ledger: Pick<LedgerWriter, 'commit'>): ChangeLogCommit {
  return async (write) =>
    changeLogCommitOpen()
      ? await write()
      : (await ledger.commit({ write: async () => await write() })).result
}

/** Run `write` through `hook` when one is installed. */
export async function throughChangeLog<T>(
  hook: ChangeLogCommit | undefined,
  write: () => Promise<T>,
): Promise<T> {
  return hook === undefined ? await write() : await hook(write)
}
