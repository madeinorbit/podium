/**
 * THE AUTOMATION WRITES, SENT ON THE SYNC WRITE ENTRY POINT (ADR 12 D2, POD-6418).
 *
 * `automationWrites(trpc).create.mutate(input)` in place of
 * `trpc.automations.create.mutate(input)`: the same procedures and types, each
 * write sent on `sync.submit` and answered now (D6 `immediate`). A refusal is
 * thrown with the service's own words, as the route's error was.
 * LEGACY(remove-after: 2027-03): an older server, without `sync.submit` or
 * without these commands on it, takes each command's own route.
 */

import { type SyncSubmitTransport, writesThroughSubmit } from '@podium/protocol'
import type { Trpc } from '@/app/trpc'

/** Every automation mutation is a write; its reads are queries. */
const everyWrite = (): boolean => true

export const automationWrites = (trpc: Trpc): Trpc['automations'] =>
  writesThroughSubmit(
    trpc as unknown as SyncSubmitTransport,
    trpc.automations,
    'automations',
    everyWrite,
  )
