/**
 * THE NO-SIDE-DOOR GATE (POD-314) — the RUNNING-OBJECT half.
 *
 * `scripts/audit-derived-families.ts` reads TEXT and can say "nothing extra is
 * reachable". It cannot say "the thing that should be reachable IS" — an empty
 * router satisfies every absence claim it makes perfectly (POD-732). This file
 * makes the complementary claim against the object the server will actually
 * serve: `appRouter`, resolved, with its real procedure records.
 *
 * Neither instrument substitutes for the other, which is why both exist:
 *
 *   source text  — nothing OUTSIDE a family can reach its handlers
 *   running object — everything the family DECLARES is served, with the right verb
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THE ASSERTIONS BELOW ABLE TO SAY NO
 * ---------------------------------------------------------------------------
 *
 * The trap this run has hit nine times is a suite whose refusing arm cannot fire.
 * For a router assertion the two vacuous spellings are obvious once named:
 * `expect(Object.keys(router)).toBeDefined()` passes against an empty object, and
 * `expect(keys).toEqual(expect.arrayContaining([]))` passes against anything. So
 * every check here is an EQUALITY against the contract table's own membership,
 * computed from the table rather than written out — a family that stopped serving
 * a command fails, and so does one that grew a procedure its table does not
 * declare.
 *
 * The `it.each` is driven by a table that is itself asserted non-empty first. A
 * shrinking `it.each` is the coverage failure that reports green by running fewer
 * cases, and it is the reason the count is pinned before the cases run.
 */

import { describe, expect, it } from 'vitest'
import { appRouter } from '../router'
import { ACCOUNT_COMMANDS_TRPC } from './accounts/registry'
import { APPROVAL_QUERIES } from './approvals/queries'
import { APPROVAL_COMMANDS_TRPC } from './approvals/registry'
import { CLOUD_COMMANDS_TRPC } from './cloud/registry'
import { CONVERSATION_COMMANDS_TRPC } from './conversations/registry'
import { FILE_COMMANDS_TRPC } from './files/registry'
import { HOST_COMMANDS_TRPC } from './hosts/registry'
import {
  AUTH_COMMANDS_TRPC,
  SETUP_COMMANDS_TRPC,
  TELEMETRY_COMMANDS_TRPC,
} from './instance/registry'
import { MODEL_COMMANDS_TRPC } from './models/registry'
import { PERF_COMMANDS_TRPC } from './perf/commands'

/** A tRPC v11 procedure record carries its verb on `_def.type`. Read
 *  structurally so this test does not depend on a tRPC helper's shape. */
const verbOf = (proc: unknown): string | undefined =>
  (proc as { _def?: { type?: string } } | undefined)?._def?.type

/** The eleven families POD-314 derived, each with the table that DECIDES its
 *  membership. The expected keys are computed from the table — never written out
 *  beside it, which would be the second list that silently disagrees. */
const FAMILIES = [
  { router: 'approvals', table: APPROVAL_COMMANDS_TRPC },
  { router: 'conversations', table: CONVERSATION_COMMANDS_TRPC },
  { router: 'perf', table: PERF_COMMANDS_TRPC },
  { router: 'models', table: MODEL_COMMANDS_TRPC },
  { router: 'files', table: FILE_COMMANDS_TRPC },
  { router: 'hosts', table: HOST_COMMANDS_TRPC },
  { router: 'accounts', table: ACCOUNT_COMMANDS_TRPC },
  { router: 'cloud', table: CLOUD_COMMANDS_TRPC },
  { router: 'setup', table: SETUP_COMMANDS_TRPC },
  { router: 'auth', table: AUTH_COMMANDS_TRPC },
  { router: 'telemetry', table: TELEMETRY_COMMANDS_TRPC },
] as const

const routerRecord = (name: string): Record<string, unknown> =>
  (appRouter as unknown as { _def: { record: Record<string, Record<string, unknown>> } })._def
    .record[name] ?? {}

describe('the derived families, against the RUNNING appRouter', () => {
  /**
   * THE NON-VACUITY PIN. Every assertion below is `it.each`-driven, and a table
   * that quietly shrank would report green by running fewer cases. Twenty-four
   * is the current contract-table count, so a
   * family dropping out of the derivation fails HERE rather than silently
   * reducing the coverage of everything after it.
   */
  it('governs eleven families and twenty-four derived writes', () => {
    expect(FAMILIES).toHaveLength(11)
    const total = FAMILIES.reduce((n, f) => n + Object.keys(f.table).length, 0)
    expect(total).toBe(24)
  })

  it.each(
    FAMILIES.map((f) => [f.router, f.table] as const),
  )('%s serves exactly the commands its contract table declares, all as mutations', (name, table) => {
    const served = routerRecord(name)
    const declared = Object.keys(table).sort()

    // EQUALITY, not containment. A command that stopped being served fails the
    // subset direction; a procedure the table does not declare fails the
    // superset one — which is the direction that catches a hand-written write
    // added back beside the derived ones.
    const servedMutations = Object.keys(served)
      .filter((k) => verbOf(served[k]) === 'mutation')
      .sort()
    expect(servedMutations).toEqual(declared)

    // Each is a MUTATION and not a query. The census and the family audits check
    // procedure type in the source; this checks it on the object, which is where
    // a `.query(` would actually take effect.
    for (const key of declared) {
      expect(verbOf(served[key]), `${name}.${key} verb`).toBe('mutation')
    }
  })

  /**
   * THE READS ARE SERVED AND ARE QUERIES — the other half, because a family whose
   * queries vanished would pass every assertion above.
   *
   * `approvals` stands for the shape: its query table declares `list`, and the
   * running router must serve it AS A QUERY. If a read were ever promoted to a
   * mutation — the way a write hides among reads, pointed the other way — the
   * equality assertion above would also catch it, since `list` would appear in
   * `servedMutations` and the table does not declare it.
   */
  it('serves the declared reads as queries', () => {
    const served = routerRecord('approvals')
    for (const key of Object.keys(APPROVAL_QUERIES)) {
      expect(verbOf(served[key]), `approvals.${key} verb`).toBe('query')
    }
  })

  /**
   * THE PROBE THAT PROVES THE READER WORKS.
   *
   * Every assertion above depends on `verbOf` and `routerRecord` actually
   * resolving something. If tRPC changed either shape, `verbOf` would return
   * `undefined` everywhere and `routerRecord` would return `{}` — at which point
   * `servedMutations` is `[]`, and the equality assertions would fail LOUDLY
   * rather than passing, which is the right way round. This case pins the
   * mechanism anyway, so a reader failure is diagnosed here instead of appearing
   * as eleven mysterious empties.
   */
  it('can read a verb and a router record at all', () => {
    const settings = routerRecord('settings')
    expect(Object.keys(settings).length).toBeGreaterThan(0)
    // `settings.get` is a query and `settings.set` a mutation — a pair the reader
    // must be able to TELL APART, so this fails if `verbOf` returns a constant.
    expect(verbOf(settings.get)).toBe('query')
    expect(verbOf(settings.updateInstance)).toBe('mutation')
  })
})
