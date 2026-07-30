/**
 * THE SETTINGS GUARD, AGAINST THE RUNNING ROUTER (POD-386).
 *
 * POD-313's own title carves settings out of phase 3.3 — "3.3 Migrate superagent
 * + machines/repos + specs mutations; dedupe send/sendTurn (settings via #352)".
 * So this issue's obligation for `settings` is not that it improves. It is that
 * it is UNTOUCHED, and that is a claim that fails in BOTH directions: a settings
 * write appearing is a scope leak, and a settings write DISAPPEARING is a
 * cutover that quietly absorbed somebody else's surface — which would read as
 * progress on every ratchet in the repo.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE THE SOURCE-TEXT CENSUS
 * ---------------------------------------------------------------------------
 *
 * `scripts/audit-router-mutations.ts` makes the same claim by reading
 * `router.ts` as TEXT. It resolves no modules, so it runs in a fresh checkout
 * and before anything is built — and it is blind to everything that is not
 * spelled in that one file. A `...settingsFamily` spread would satisfy it while
 * moving every settings write into a contract table.
 *
 * This one reads the OBJECT that will actually be served: the built `appRouter`,
 * its procedure names and their tRPC types. Between them the two instruments
 * cover both failure directions — a hand-written write appearing in the source,
 * and the surface being re-derived from somewhere the source scan cannot see.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE REFUSING ARM DEPENDS ON
 * ---------------------------------------------------------------------------
 *
 * Nothing environmental. `appRouter` is built at module load from the same
 * definition the server serves, `_def.procedures` is the dispatch table itself,
 * and `_def.type` is the verb tRPC will enforce on the wire. There is no server
 * to bind, no principal to be, and no fixture standing in for the product — so
 * there is no setup fact that could make the refusing arm unreachable. Delete a
 * settings procedure and the first test fails; migrate one into a contract table
 * and the third fails.
 */

import { describe, expect, it } from 'vitest'
import { appRouter } from './router'

/** The dispatch table `appRouter` will actually serve, keyed by dotted name. */
type ProcedureDef = { _def?: { type?: string } }
const procedures = (appRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })
  ._def.procedures

const typeOf = (name: string): string | undefined => procedures[name]?._def?.type

/** Exactly what `settings` served before phase 3.3 opened, verb included. The
 *  verb matters on its own: a write re-spelled as a query is still a change to
 *  this surface, and it is the one shape a name-only check would miss. */
const SETTINGS_SURFACE: Record<string, 'query' | 'mutation'> = {
  'settings.get': 'query',
  'settings.set': 'mutation',
  'settings.telegramSetupStart': 'mutation',
  'settings.telegramSetupPoll': 'mutation',
}

describe('the settings surface is UNTOUCHED by phase 3.3', () => {
  it('serves exactly the procedures it served before, with the same verbs', () => {
    const served = Object.fromEntries(
      Object.keys(procedures)
        .filter((n) => n.startsWith('settings.'))
        .map((n) => [n, typeOf(n)]),
    )
    // `toEqual` over the whole map and not four `toBeDefined()` calls: an extra
    // settings procedure has to fail this, and a per-name assertion cannot see one.
    expect(served).toEqual(SETTINGS_SURFACE)
  })

  it('still serves its three writes as MUTATIONS — a removal fails as hard as an addition', () => {
    for (const [name, verb] of Object.entries(SETTINGS_SURFACE)) {
      if (verb !== 'mutation') continue
      expect(typeOf(name), `${name} is no longer served as a mutation`).toBe('mutation')
    }
  })

  it('is not derived from any contract table — no command in @podium/commands names it', async () => {
    // The check the source-text census structurally cannot make: a
    // `...settingsFamily` spread would leave router.ts textually clean while
    // moving the whole surface. Read off the package's own tables, so a settings
    // tenant added later is found here rather than in a review.
    const commands = (await import('@podium/commands')) as unknown as Record<string, unknown>
    const named: string[] = []
    for (const [exportName, value] of Object.entries(commands)) {
      if (!value || typeof value !== 'object') continue
      if (!/_CONTRACTS$/.test(exportName)) continue
      for (const contract of Object.values(value as Record<string, unknown>)) {
        const name = (contract as { name?: unknown } | null)?.name
        if (typeof name === 'string' && name.startsWith('settings.')) {
          named.push(`${exportName}.${name}`)
        }
      }
    }
    expect(named).toEqual([])
  })
})

describe('this guard can say YES', () => {
  /**
   * The guard is three absence/equality claims, which is exactly what a broken
   * reader reports. These do not mutate the product — they run the same
   * comparisons the tests above run, against a table that CONTAINS the defect,
   * and require them to fail. Without this the whole file would stay green
   * against a `procedures` accessor that returned `{}`.
   */
  it('the accessor reads a real dispatch table, not an empty object', () => {
    expect(Object.keys(procedures).length).toBeGreaterThan(50)
    expect(typeOf('settings.set')).toBe('mutation')
    expect(typeOf('settings.nonexistent')).toBeUndefined()
  })

  it('the equality check notices an ADDED settings procedure', () => {
    const withExtra = { ...SETTINGS_SURFACE, 'settings.smuggled': 'mutation' }
    expect(withExtra).not.toEqual(SETTINGS_SURFACE)
  })

  it('the equality check notices a REMOVED one', () => {
    const { 'settings.set': _removed, ...withoutSet } = SETTINGS_SURFACE
    expect(withoutSet).not.toEqual(SETTINGS_SURFACE)
  })

  it('the equality check notices a write RE-SPELLED as a query', () => {
    expect({ ...SETTINGS_SURFACE, 'settings.set': 'query' }).not.toEqual(SETTINGS_SURFACE)
  })

  it('the contract scan finds a settings-named contract when one exists', async () => {
    // The same walk the third test runs, over a table that DOES name one. If this
    // finds nothing, that test's empty result means "the walk is broken", not
    // "settings is unmigrated".
    const fixture = { FAKE_CONTRACTS: { set: { name: 'settings.set' } } }
    const named: string[] = []
    for (const [exportName, value] of Object.entries(fixture)) {
      if (!/_CONTRACTS$/.test(exportName)) continue
      for (const contract of Object.values(value)) {
        if (typeof contract.name === 'string' && contract.name.startsWith('settings.')) {
          named.push(`${exportName}.${contract.name}`)
        }
      }
    }
    expect(named).toEqual(['FAKE_CONTRACTS.settings.set'])
  })

  it('the contract scan actually reaches the shipped tables', async () => {
    // …and the walk must be reading REAL tables, or the empty settings result is
    // vacuous. Every migrated family must be visible to it.
    const commands = (await import('@podium/commands')) as unknown as Record<string, unknown>
    const names: string[] = []
    for (const [exportName, value] of Object.entries(commands)) {
      if (!value || typeof value !== 'object' || !/_CONTRACTS$/.test(exportName)) continue
      for (const contract of Object.values(value as Record<string, unknown>)) {
        const name = (contract as { name?: unknown } | null)?.name
        if (typeof name === 'string') names.push(name)
      }
    }
    expect(names).toContain('specs.create')
    expect(names).toContain('machines.rename')
    expect(names.length).toBeGreaterThan(20)
  })
})
