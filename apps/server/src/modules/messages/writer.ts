/**
 * THE WRITER A MESSAGES WRITE COMMITS ON (ADR 12 D9, POD-6602).
 *
 * The messages table is a synced kind (`message`), so its repository's writers
 * take the commit's write scope, and the only way to get one is a commit on a
 * writer. Which writer is the caller's to say:
 *
 *  - a mail command (or a session or issue command that sends, reads or fails
 *    mail inside its own unit) passes its own, the command's writer;
 *  - the delivery service's own work writes on its declared origins
 *    (`write-contexts.ts`): `messages.daemon` for what a machine reports about
 *    a message, `messages.delivery` for the hand-ons, retries, retracts and
 *    sweeps the server runs after a commit.
 *
 * THE FEED'S CHANGES ARE NOT DECLARED HERE. Every row the repository writes is
 * handed to the messages table's capture inside the same unit, which appends
 * the chat feed's changes under the `feed.messages` mirror (POD-4764). That
 * capture stays the one source of them, so a commit here declares none.
 */

import type { LedgerWriter, WriteScope } from '@podium/sync'

/** A writer a messages write can commit on. Commit and capture: the session
 *  inbox a delivery hands it to writes the session's row with it too. */
export type MessageWriter = Pick<LedgerWriter, 'commit' | 'capture'>

/** One messages write, as a commit on `writer`. */
export async function commitMessages<T>(
  writer: MessageWriter,
  write: (scope: WriteScope) => Promise<T>,
): Promise<T> {
  return (await writer.commit({ write, changes: () => [] })).result
}
