/**
 * THE SUPERAGENT'S WRITES, SENT ON THE SYNC WRITE ENTRY POINT (ADR 12 D2, POD-6419).
 *
 * `superagentWrites(trpc).sendTurn.mutate(input)` in place of
 * `trpc.superagent.sendTurn.mutate(input)`: the same procedures and types, each
 * write sent on `sync.submit` and answered now. A refusal is thrown with the
 * service's own words, as the route's error was.
 * LEGACY(remove-after: 2027-03): an older server, without `sync.submit` or
 * without these commands on it, takes each command's own route.
 */

import { type SyncSubmitTransport, writesThroughSubmit } from '@podium/protocol'

/** Every superagent mutation is a write; its reads are queries. */
const everyWrite = (): boolean => true

export const superagentWrites = <C extends { readonly superagent: object }>(
  trpc: C,
): C['superagent'] =>
  writesThroughSubmit(
    trpc as unknown as SyncSubmitTransport,
    trpc.superagent,
    'superagent',
    everyWrite,
  )
