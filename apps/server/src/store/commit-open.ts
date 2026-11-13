/**
 * WHETHER A CHANGE-LOG COMMIT IS RUNNING (POD-6920).
 *
 * The record source runs each commit's body (write, drain, append) in
 * {@link inChangeLogCommit}; a repository hook that commits its own writes
 * asks {@link changeLogCommitOpen} and joins a running commit instead of
 * opening one inside it. No imports, so any store module can ask.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const openCommit = new AsyncLocalStorage<true>()

/** Is a change-log commit's body running in this async context? */
export function changeLogCommitOpen(): boolean {
  return openCommit.getStore() === true
}

/** Run a change-log commit's body, marked as one. */
export async function inChangeLogCommit<T>(body: () => Promise<T>): Promise<T> {
  return await openCommit.run(true, body)
}
