/**
 * A SUPERAGENT COMMAND'S OWN DEFINITIVE REFUSAL (POD-6419).
 *
 * The thread-lock and state rules (`sendTurn` while the thread is open in a
 * terminal, `openInTerminal` while a turn runs or before there is a harness
 * session, `concierge` on an unregistered repo) are decisions, not failures:
 * retrying the same command later in the same state answers the same. On the
 * sync write entry point they are a rejected reply that carries this message
 * (`sync-write.ts`); the old routes throw this error, whose message is the one
 * they always threw.
 */

import type { SyncSubmitRefusal } from '@podium/protocol'

export class SuperagentRefusal extends Error {
  constructor(
    readonly kind: Extract<SyncSubmitRefusal['kind'], 'conflict' | 'invalid' | 'target-not-found'>,
    message: string,
  ) {
    super(message)
    this.name = 'SuperagentRefusal'
  }
}
