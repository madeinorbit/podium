/**
 * THE SETTINGS GUARD, AGAINST THE RUNNING ROUTER (POD-386, converted by POD-420
 * from ABSENT to DERIVED-SURFACE-EXACT).
 *
 * POD-386 wrote this when settings was carved out of phase 3.3 — "settings via
 * #352" — and its claim was that the surface was UNTOUCHED, including the claim
 * that no `*_CONTRACTS` table in `@podium/commands` named a `settings.*`
 * command. POD-420 is #352's command-contract child, so that last claim is now
 * false BY DESIGN: `SETTINGS_CONTRACTS` names four.
 *
 * WHAT DID NOT CHANGE, AND MUST NOT: the guard still fails in BOTH DIRECTIONS
 * with no ratchet relief. POD-386's reasoning generalises past settings and is
 * the reason it is worth having — *a settings write DISAPPEARING is as much a
 * failure as one appearing, because an absorbed surface reads as progress on
 * every ratchet.* So the exact form below is a whole-map equality on names AND
 * verbs, and the contract half is now an exact correspondence rather than an
 * emptiness check:
 *
 *   · every `settings.*` contract declaring `trpc` MUST be served, as a mutation;
 *   · every served `settings.*` procedure MUST be either a named hand-written
 *     exception or a contract the table declares.
 *
 * The failure mode this conversion had to avoid is turning a check that cannot
 * pass into one that cannot fail. `describe('this guard can say NO')` plants
 * both defects — a settings write no contract names, and a contract naming a
 * procedure the router does not serve — and requires the comparisons to fire.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE THE SOURCE-TEXT AUDIT
 * ---------------------------------------------------------------------------
 *
 * `scripts/audit-settings-commands.ts` makes the same claims by reading
 * `router.ts` as TEXT. It resolves no modules, so it runs in a fresh checkout
 * and before anything is built — and it is blind to everything not spelled in
 * that one file. This one reads the OBJECT that will actually be served:
 * `_def.procedures` is the dispatch table itself and `_def.type` is the verb
 * tRPC enforces on the wire.
 *
 * WHAT THE REFUSING ARM DEPENDS ON: nothing environmental. `appRouter` is built
 * at module load from the same definition the server serves — no server to bind,
 * no principal to be, no fixture standing in for the product. Delete a settings
 * procedure and the first test fails; add one no contract names and the third
 * does.
 */

import { SETTINGS_COMMAND_NAMES, SETTINGS_CONTRACTS } from '@podium/commands'
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'

/** The dispatch table `appRouter` will actually serve, keyed by dotted name. */
type ProcedureDef = { _def?: { type?: string } }
const procedures = (appRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })
  ._def.procedures

const typeOf = (name: string): string | undefined => procedures[name]?._def?.type

/**
 * The procedures `settings` serves that are NOT derived from a contract, with
 * the reason each is still hand-written. Named individually, because "the rest"
 * is how an unaccounted-for write hides.
 *
 *  - `get` is a READ. A `visibility` class describes what a command WRITES.
 *  - `set` is the legacy blob write, still called by the sidebar, the
 *    auto-continue dialog and the engine — and it now refuses a SECRET change,
 *    which is what makes the contracted pair the only way to write material.
 *  - the two telegram procedures WERE here and are now CONTRACTED (POD-1080,
 *    ADR 3 Amendment 1 D22): the binding ceremony is an authentication surface,
 *    so they moved into `DERIVED` below under unchanged wire keys. They are the
 *    one kind of removal this guard is meant to admit — POD-420 deferred them to
 *    that issue by name — and the whole-map equality still fails if they vanish
 *    from the ROUTER, because `DERIVED` is read off the contract table.
 */
const HAND_WRITTEN: Record<string, 'query' | 'mutation'> = {
  'settings.get': 'query',
  'settings.set': 'mutation',
}

/** The contracted half, DERIVED from the table — so a fifth contract must appear
 *  in the router without anyone editing this file, and a deleted one fails. */
const DERIVED: Record<string, 'mutation'> = Object.fromEntries(
  SETTINGS_COMMAND_NAMES.map((name) => [name, 'mutation' as const]),
)

const EXPECTED_SURFACE: Record<string, string> = { ...HAND_WRITTEN, ...DERIVED }

const servedSettings = (): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.keys(procedures)
      .filter((n) => n.startsWith('settings.'))
      .map((n) => [n, typeOf(n)]),
  )

describe('the settings surface is EXACTLY its contracts plus its named exceptions', () => {
  it('serves exactly that map, with the same verbs', () => {
    // `toEqual` over the whole map and not one assertion per name: an EXTRA
    // settings procedure has to fail this, and a per-name assertion cannot see
    // one. This is also the direction that fails when a write DISAPPEARS.
    expect(servedSettings()).toEqual(EXPECTED_SURFACE)
  })

  it('still serves every hand-written write as a MUTATION — a removal fails as hard as an addition', () => {
    for (const [name, verb] of Object.entries(HAND_WRITTEN)) {
      if (verb !== 'mutation') continue
      expect(typeOf(name), `${name} is no longer served as a mutation`).toBe('mutation')
    }
  })

  it('every contract declaring trpc IS served, as a mutation', () => {
    // The direction POD-385's defect lives in: a contract naming a transport no
    // dispatcher reads. Derived from the table, so it cannot be satisfied by an
    // empty one — the next test proves the table is not empty.
    for (const name of SETTINGS_COMMAND_NAMES) {
      const contract = SETTINGS_CONTRACTS[name]
      if (!contract.exposure.includes('trpc')) continue
      expect(typeOf(name), `${name} declares trpc exposure but nothing serves it`).toBe('mutation')
    }
  })

  it('every served settings procedure is a contract or a NAMED exception', () => {
    for (const name of Object.keys(servedSettings())) {
      const accounted = name in HAND_WRITTEN || name in DERIVED
      expect(accounted, `${name} is served by nothing that accounts for it`).toBe(true)
    }
  })

  it('no settings command is exposed on the outbox — the class refusal, at the table', () => {
    for (const name of SETTINGS_COMMAND_NAMES) {
      expect(SETTINGS_CONTRACTS[name].exposure).not.toContain('outbox')
    }
  })
})

describe('this guard can say NO', () => {
  /**
   * Every claim above is an equality or an absence, which is exactly what a
   * broken reader reports. These do not mutate the product — they run the same
   * comparisons against tables that CONTAIN the defect and require them to fail.
   * Without this file the whole guard would stay green against a `procedures`
   * accessor that returned `{}` and a contract table with nothing in it.
   */
  it('the accessor reads a real dispatch table, not an empty object', () => {
    expect(Object.keys(procedures).length).toBeGreaterThan(50)
    expect(typeOf('settings.set')).toBe('mutation')
    expect(typeOf('settings.nonexistent')).toBeUndefined()
  })

  it('the contract table is NOT empty — the derived half has content', () => {
    // Without this, "every contract declaring trpc is served" passes perfectly
    // against a table naming nothing, which is the emptiness POD-732 named.
    expect(SETTINGS_COMMAND_NAMES.length).toBe(6)
    expect(Object.keys(DERIVED).sort()).toEqual([
      'settings.clearSecret',
      'settings.setSecret',
      'settings.telegramSetupPoll',
      'settings.telegramSetupStart',
      'settings.updateInstance',
      'settings.updatePersonal',
    ])
  })

  it('the equality check notices a settings write NO CONTRACT NAMES', () => {
    const smuggled = { ...servedSettings(), 'settings.smuggled': 'mutation' }
    expect(smuggled).not.toEqual(EXPECTED_SURFACE)
    expect('settings.smuggled' in HAND_WRITTEN || 'settings.smuggled' in DERIVED).toBe(false)
  })

  it('the correspondence notices a CONTRACT the router does not serve', () => {
    // The second planted defect: a table naming a command with no procedure.
    const phantom = { ...DERIVED, 'settings.phantom': 'mutation' as const }
    for (const name of Object.keys(phantom)) {
      if (name !== 'settings.phantom') continue
      expect(typeOf(name)).toBeUndefined()
    }
    expect({ ...HAND_WRITTEN, ...phantom }).not.toEqual(EXPECTED_SURFACE)
  })

  it('the equality check notices a REMOVED procedure — POD-386s mutant', () => {
    // POD-386 mutation-verified its guard by deleting settings.telegramSetupStart.
    // The converted form must survive the same mutant: removing any member of
    // the expected map breaks the whole-map equality.
    const { 'settings.telegramSetupStart': _gone, ...without } = EXPECTED_SURFACE
    expect(without).not.toEqual(EXPECTED_SURFACE)
    const { 'settings.setSecret': _alsoGone, ...withoutContract } = EXPECTED_SURFACE
    expect(withoutContract).not.toEqual(EXPECTED_SURFACE)
  })

  it('the equality check notices a write RE-SPELLED as a query', () => {
    expect({ ...EXPECTED_SURFACE, 'settings.set': 'query' }).not.toEqual(EXPECTED_SURFACE)
    expect({ ...EXPECTED_SURFACE, 'settings.setSecret': 'query' }).not.toEqual(EXPECTED_SURFACE)
  })

  it('the contract scan reaches the SHIPPED tables, not a fixture', () => {
    const commands = SETTINGS_CONTRACTS['settings.setSecret']
    expect(commands.name).toBe('settings.setSecret')
    expect(commands.visibility).toBe('secret')
    expect(commands.delivery.class).toBe('online-sensitive')
  })
})
