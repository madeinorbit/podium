/**
 * THE FACET RULES, over EVERY contract table in this package (POD-381, at
 * POD-642's request).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS RATHER THAN ONE ASSERTION PER TABLE
 * ---------------------------------------------------------------------------
 *
 * ADR 3 Amendment 1 D18.3 makes `policy.machineVerb: 'use'` imply
 * `offline: 'online-only'` — a queued execution command is a rights snapshot
 * with a delayed fuse. That rule was originally asserted inside
 * `session-command-plane.test.ts`, which enforced it for exactly the nine
 * contracts that file declares.
 *
 * POD-642 spotted the hole from the outside: `sessions.handoff` is the second
 * declarer of `machineVerb`, and under a per-file assertion it would have been
 * outside the only test that enforces the field's consequence. A rule enforced
 * per file is a rule the next file does not have.
 *
 * So the scan is over the PACKAGE's exports, not over a hand-maintained list of
 * tables. A new `defineCommands(...)` export is covered the moment it exists,
 * with no test edit and therefore no test edit to forget — which matters most
 * for the table that has not been written yet.
 *
 * ---------------------------------------------------------------------------
 * A SCAN THAT FINDS NOTHING PASSES EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * The first test below is the instrument check, and it is not decorative: every
 * assertion here is a for-loop over discovered tables, so a discovery that
 * silently stopped matching — a renamed export shape, an index that no longer
 * re-exports a module — would turn this whole file green and mean nothing. It
 * asserts the scan finds the tables that exist BY NAME, so "no violations" can
 * only be read after "and it looked at these".
 */

import { describe, expect, it } from 'vitest'
import type { CommandDef } from './framework'
import * as commands from './index'

interface CommandTable {
  readonly export: string
  readonly namespace: string
  readonly defs: Record<string, CommandDef>
}

/** Every `defineCommands(...)` result this package exports. */
function discoverTables(): CommandTable[] {
  const tables: CommandTable[] = []
  for (const [name, value] of Object.entries(commands as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const candidate = value as { namespace?: unknown; defs?: unknown }
    if (typeof candidate.namespace !== 'string') continue
    if (typeof candidate.defs !== 'object' || candidate.defs === null) continue
    // A `{namespace, defs}` shape whose defs are not contracts would be a false
    // positive; require at least one def carrying an input schema.
    const defs = candidate.defs as Record<string, CommandDef>
    const entries = Object.values(defs)
    if (entries.length === 0 || !entries.every((def) => def?.input !== undefined)) continue
    tables.push({ export: name, namespace: candidate.namespace, defs })
  }
  return tables
}

const TABLES = discoverTables()
const ALL_CONTRACTS: { name: string; def: CommandDef }[] = TABLES.flatMap((table) =>
  Object.entries(table.defs).map(([key, def]) => ({ name: `${table.namespace}.${key}`, def })),
)

/**
 * Contracts that declare the `use` verb and are STILL offline-eligible, each
 * with the reason the blanket rule does not bind it.
 *
 * Keyed by dotted wire name so it cannot be satisfied by a same-named command in
 * another namespace, and listed here rather than inferred so a second exception
 * must edit this line and argue for itself. Make the exception visible; do not
 * make the rule silent.
 */
const OFFLINE_ELIGIBLE_EXCEPTIONS: Record<string, string> = {
  'sessions.resumeAndSend':
    "the client outbox oracle pins it in the covered set (must-not-change); it wakes an EXISTING session rather than minting a process, carries a mutationId the authority dedupes, and is bounded by D10/D11's inequality rather than by its delivery class",
}

describe('the contract-table scan itself', () => {
  it('finds every table this package exports, by name — so a later "no violations" means something', () => {
    const found = TABLES.map((table) => table.export).sort()

    // Both migrations' tables, named explicitly. If POD-642's handoff table (or
    // anyone else's) lands and this list is stale, the count assertion below is
    // what notices — the rule still covers it either way.
    expect(found).toEqual(
      expect.arrayContaining([
        'pinCommands',
        'sessionCommandPlane',
        'sessionPresenceCommands',
        'snoozeCommands',
        'tabCommands',
      ]),
    )
    expect(TABLES.length).toBeGreaterThanOrEqual(5)
    expect(ALL_CONTRACTS.length).toBeGreaterThanOrEqual(20)
  })

  it('the scan discriminates — it does not sweep up every exported object', () => {
    // A `{namespace, defs}` shape is specific, but "every object export" would
    // not be, and a scan that matched everything would report violations from
    // unrelated shapes rather than covering contracts.
    const names = TABLES.map((table) => table.export)
    expect(names).not.toContain('WIRE_VERSION')
    expect(names.every((name) => name.toLowerCase().includes('command'))).toBe(true)
  })
})

describe('ADR 3 Amendment 1 D18.3 — machineVerb `use` implies not offline-eligible', () => {
  it('holds for every declaring contract in the package, whichever table declares it', () => {
    const violations = ALL_CONTRACTS.filter(
      ({ name, def }) =>
        def.policy?.machineVerb === 'use' &&
        def.offline === 'eligible' &&
        OFFLINE_ELIGIBLE_EXCEPTIONS[name] === undefined,
    ).map(({ name }) => name)

    expect(violations).toEqual([])
  })

  it('at least one contract actually declares the verb — the rule is not vacuous', () => {
    const declaring = ALL_CONTRACTS.filter(({ def }) => def.policy?.machineVerb === 'use')

    expect(declaring.length).toBeGreaterThan(0)
    // And the class is what it should be: everything that commands a process.
    expect(declaring.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['sessions.create', 'sessions.kill', 'sessions.sendText']),
    )
  })

  it('every exception is real, and is argued on the contract itself', () => {
    for (const [name, why] of Object.entries(OFFLINE_ELIGIBLE_EXCEPTIONS)) {
      const found = ALL_CONTRACTS.find((contract) => contract.name === name)
      // An exemption for a command that does not exist is a stale licence: it
      // would silently pre-authorize whoever next uses that name.
      expect(found, `${name} is exempted but not declared anywhere`).toBeDefined()
      expect(found?.def.offline).toBe('eligible')
      expect(found?.def.decision, `${name} must argue its exception in its own decision record`)
        .toBeDefined()
      expect(why.length).toBeGreaterThan(20)
    }
  })
})

describe('the facets that are meaningless when absent', () => {
  it('every contract declaring a machineVerb also declares an offline class', () => {
    for (const { name, def } of ALL_CONTRACTS) {
      if (def.policy?.machineVerb === undefined) continue
      expect(def.offline, `${name} declares a machine verb but no offline class`).toBeDefined()
    }
  })

  it('no contract is exposed on a transport without declaring a policy', () => {
    for (const { name, def } of ALL_CONTRACTS) {
      if ((def.exposure ?? []).length === 0) continue
      expect(def.policy, `${name} is served somewhere but declares no policy`).toBeDefined()
    }
  })
})
