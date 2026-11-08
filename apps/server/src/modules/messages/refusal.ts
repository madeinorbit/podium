/**
 * A MAIL HANDLER'S DEFINITIVE REFUSAL (POD-6525).
 *
 * The mail handlers refuse in their own words ("only the recipient of a message
 * may reply to it", "unknown message …"). On the sync write entry point a
 * refusal is a reply, `{ outcome: 'rejected' }`, which an outbox dead-letters;
 * any other throw is a failure it retries. So the words the handlers refuse
 * with are thrown as this class, which is still an `Error` with the same
 * message: the relay, the CLI and the old routes read exactly what they read
 * before, and the entry point can tell a refusal from a fault.
 */

import type { SyncSubmitRefusal } from '@podium/protocol'

export class MailRefusal extends Error {
  constructor(
    readonly kind: SyncSubmitRefusal['kind'],
    message: string,
  ) {
    super(message)
  }
}
