/**
 * THE PROJECTION POPULATION GATE (A3/PDM-129, rebuilt by A5.4/PDM-248) — every
 * externally reachable read is classified, and the population is derived from
 * THE ROUTER THIS SERVER ACTUALLY SERVES rather than from a list anyone
 * maintains.
 *
 * This is `classification-totality.test.ts`'s argument applied to the read half.
 * That file exists because the command side's totality claim once rested on
 * sixteen independent per-registry calls, so the seventeenth registry was outside
 * every instrument and nothing anywhere said so.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE WAS REWRITTEN: THE GREEN CERTIFIED COVERAGE IT NEVER MEASURED
 * ---------------------------------------------------------------------------
 *
 * The first version of this file discovered the served population by importing
 * twenty-nine query tables into a `SERVED` array and appending one named
 * hand-written exception. Every assertion then compared the census against that
 * array — so a read absent from BOTH lists was invisible to all of them, and the
 * file was green. That is not a weak check; it is a check that cannot detect the
 * incompleteness it exists to detect, which is worse than no check because its
 * green is read as coverage.
 *
 * It was not hypothetical. Measured at this pin, the router serves 108 tRPC
 * reads and the A3 receipt claimed 69 with `machines.list` as the only
 * hand-written exception. SEVEN hand-written queries were outside every
 * instrument — `settings.viewer` (PDM-248's reported finding), `layout.get`,
 * `readPosition.get`, `operations.active`, `operations.history`, `updates.fleet`
 * and `updates.proposal` — because their families were never added to `SERVED`.
 * Four of those seven had no table to be forgotten from at all: they are
 * `t.procedure.query(...)` written out in a module the array never named.
 *
 * So DISCOVERY IS NOW BOUND TO THE SERVED OBJECT. `appRouter._def.procedures` is
 * the dispatch table tRPC itself routes on and `_def.type` is the verb it
 * enforces on the wire — the same source `router.settings-guard.test.ts` reads,
 * for the same reason: it is the only instrument that can see what is actually
 * served. A new family, a new table, or a fourteenth hand-written query appears
 * here the moment it is mounted, with nobody remembering anything.
 *
 * That claim was proved by counterfactual rather than asserted: a single
 * uncensused `t.procedure.query` added to `router.ts` reddens
 * `classifies every served read` below, naming the offending path.
 * `docs/gates/pdm-248-served-read-census.md` records the run.
 *
 * ---------------------------------------------------------------------------
 * NOT EVERY SERVED READ BELONGS IN THE PROJECTION CENSUS
 * ---------------------------------------------------------------------------
 *
 * 32 of the 108 are served through a definition that ALREADY CARRIES an ADR 3
 * policy — the issue command registry, the lock registry, the mail contracts and
 * the settings contracts. Those reads are classified; they are classified on the
 * COMMAND side, where `classification-totality.test.ts` keeps the population
 * total. Giving them a second `ProjectionPolicy` would be two answers to "how is
 * this authorized", which is the fork POD-386 spent a phase removing.
 *
 * They are therefore EXCLUDED — but the exclusion is derived and CHECKED, never
 * asserted. {@link CLASSIFIED_ELSEWHERE} reads the real tables, and
 * `resolves every exclusion it claims` requires each excluded name to produce a
 * declared `action` from the table that supposedly classifies it. A bare name
 * cannot buy its way out of the census: a hand-written `issues.probe` added to
 * `router.ts` is not a key of `issueRegistry.defs`, so it lands in the residue
 * like any other unclassified read.
 *
 * The raw HTTP, WebSocket and file-route families are OUTSIDE this census
 * entirely and are audited separately, with named owners, in
 * `docs/gates/pdm-248-served-read-census.md`. This file governs the tRPC read surface
 * and says so, rather than letting a query-table count stand in for the whole
 * reachable surface.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST LIVES IN `apps/server` AND THE CENSUS LIVES IN `@podium/commands`
 * ---------------------------------------------------------------------------
 *
 * The census is L1 data and must stay importable by clients. The router is L3 —
 * it closes over services — so only this package can see both. Putting the table
 * here instead would move an authorization contract into a feature package,
 * which is POD-311 finding 1; putting the test in `@podium/commands` would make
 * an L1 package import L3 services. The seam is the one the codebase already has.
 *
 * ---------------------------------------------------------------------------
 * A SCAN THAT FINDS NOTHING PASSES EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * Every assertion below is a comparison against a discovered population, so a
 * discovery that silently stopped matching would turn this file green and mean
 * nothing. The first describe is therefore the instrument check and it is
 * load-bearing: it asserts the dispatch table was read at all, that BOTH verbs
 * came back from it (a `_def.type` rename would otherwise empty the read
 * population and satisfy every claim below perfectly), that the read population
 * is the expected SIZE, and that it includes named members from every family.
 * "Everything is classified" may only be read after "and it looked at these 108
 * reads".
 */

import {
  PROJECTION_POLICIES,
  projectionPolicyErrors,
  SETTINGS_CONTRACTS,
  UNGOVERNED_PROJECTIONS,
} from '@podium/commands'
import { describe, expect, it } from 'vitest'
import { issueRegistry } from './modules/issues/registry'
import { lockRegistry } from './modules/lock/registry'
import { MAIL_COMMANDS } from './modules/messages/registry'
import { appRouter } from './router'

// ---------------------------------------------------------------------------
// Discovery — the served object, not a list
// ---------------------------------------------------------------------------

/**
 * THE DISPATCH TABLE `appRouter` WILL ACTUALLY SERVE, keyed by the dotted tRPC
 * path a caller types.
 *
 * Read exactly as `router.settings-guard.test.ts` reads it. `appRouter` is built
 * at module load from the same definition the server mounts — no server to bind,
 * no principal to be, no fixture standing in for the product — so the population
 * below is the product's, and the router key is by construction the one a CALLER
 * can reach. A policy filed under a name no caller can type is a policy for
 * nothing, and that failure is now unrepresentable rather than merely avoided.
 */
type ProcedureDef = { _def?: { type?: string } }
const procedures = (appRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })
  ._def.procedures

function pathsOfType(type: 'query' | 'mutation'): string[] {
  return Object.entries(procedures)
    .filter(([, procedure]) => procedure?._def?.type === type)
    .map(([name]) => name)
    .sort()
}

/** Every externally reachable tRPC READ: the procedures tRPC serves as queries. */
function servedReads(): string[] {
  return pathsOfType('query')
}

const CENSUS_NAMES = [
  ...PROJECTION_POLICIES.map((policy) => policy.name),
  ...UNGOVERNED_PROJECTIONS.map((entry) => entry.name),
]

// ---------------------------------------------------------------------------
// The classified-elsewhere partition — derived from the real tables
// ---------------------------------------------------------------------------

/**
 * ONE MOUNTED TABLE whose definitions already carry an ADR 3 policy, and the
 * router key it is mounted under.
 *
 * `actions` maps the dotted ROUTER PATH to the `action` the classifying
 * definition declares. It is built from the table itself, so an exclusion cannot
 * outlive the classification it rests on: delete the contract and the name stops
 * being produced, which puts the read straight back into the census residue.
 *
 * `owner` names the instrument that keeps THAT table total — the reason it is
 * safe to look away from these reads here, written down rather than assumed.
 */
interface ClassifiedMount {
  readonly family: string
  readonly table: string
  readonly owner: string
  readonly actions: ReadonlyMap<string, string>
}

/** `defineCommands` tables: `{ namespace, defs }`, each def carrying `action`. */
function fromRegistry(registry: {
  namespace: string
  defs: Record<string, { action?: string }>
}): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, def] of Object.entries(registry.defs)) {
    if (typeof def?.action === 'string') out.set(`${registry.namespace}.${key}`, def.action)
  }
  return out
}

/** Tables of `{ contract }` joins, mounted under a key that is NOT the contract
 *  namespace — `mail.show` is served at `messages.show`. The router key comes
 *  from the table's own key rather than from the contract name, because the
 *  router spreads the table's keys. */
function fromJoinTable(
  family: string,
  table: Record<string, { contract?: { policy?: { action?: string } } }>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, entry] of Object.entries(table)) {
    const action = entry?.contract?.policy?.action
    if (typeof action === 'string') out.set(`${family}.${key}`, action)
  }
  return out
}

/** Contract tables already keyed by the dotted wire name. */
function fromContractTable(
  table: Record<string, { policy?: { action?: string } }>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, contract] of Object.entries(table)) {
    const action = contract?.policy?.action
    if (typeof action === 'string') out.set(name, action)
  }
  return out
}

const CLASSIFIED_ELSEWHERE: readonly ClassifiedMount[] = [
  {
    family: 'issues',
    table: 'modules/issues/registry.ts, joined to ISSUE_CONTRACTS',
    owner:
      'packages/commands classification-totality.test.ts (contract population) + registry.test.ts (the join)',
    actions: fromRegistry(issueRegistry),
  },
  {
    family: 'lock',
    table: 'modules/lock/registry.ts (defineCommands)',
    owner: 'packages/commands framework-facet-rules.test.ts (defineCommands facet totality)',
    actions: fromRegistry(lockRegistry),
  },
  {
    family: 'messages',
    table: 'modules/messages/registry.ts, joined to the mail contracts',
    owner:
      'packages/commands classification-totality.test.ts, plus router.ts mailQuery/mailMutation refusing at module load when the wire verb and the contract action disagree',
    actions: fromJoinTable('messages', MAIL_COMMANDS),
  },
  {
    family: 'settings',
    table: 'SETTINGS_CONTRACTS',
    owner: 'router.settings-guard.test.ts (whole-map equality, both directions)',
    actions: fromContractTable(SETTINGS_CONTRACTS),
  },
]

/** Every router path any mount claims to classify — mutations included, because
 *  a table classifies its whole surface. Intersected with the READ population at
 *  each use site. */
function classifiedPaths(): Map<string, ClassifiedMount> {
  const out = new Map<string, ClassifiedMount>()
  for (const mount of CLASSIFIED_ELSEWHERE) {
    for (const path of mount.actions.keys()) out.set(path, mount)
  }
  return out
}

/** The reads this file governs: served, and not classified by a command
 *  definition somewhere else. */
function censusPopulation(): string[] {
  const classified = classifiedPaths()
  return servedReads().filter((name) => !classified.has(name))
}

// ---------------------------------------------------------------------------
// The instrument check — read this before reading anything below it
// ---------------------------------------------------------------------------

describe('the projection scan found the fleet', () => {
  it('read the router dispatch table, and got both verbs from it', () => {
    // The population every other assertion is measured against is a FILTER over
    // this object. If `_def.type` were renamed, or `_def.procedures` reshaped,
    // the filter would return nothing and "every served read is classified"
    // would be vacuously true. Asserting both verbs came back is what makes the
    // filter's silence impossible.
    expect(Object.keys(procedures).length).toBeGreaterThan(200)
    expect(pathsOfType('mutation').length).toBeGreaterThan(100)
    expect(pathsOfType('query').length).toBeGreaterThan(100)
  })

  it('discovers 108 externally reachable tRPC reads', () => {
    // The REAL number, replacing the 69 A3's receipt reported — that figure was
    // the size of the query tables someone had listed, not of the served
    // surface. A change here is a change to the READ SURFACE, and it should
    // arrive with either a policy or a classifying contract.
    expect(servedReads()).toHaveLength(108)
  })

  it('splits them into 76 census reads and 32 classified elsewhere', () => {
    // Stated as two numbers that must add up, so neither list can absorb the
    // other silently: moving a read out of the census and into an exclusion is
    // visible here even though the total does not move.
    expect(censusPopulation()).toHaveLength(76)
    expect(servedReads().length - censusPopulation().length).toBe(32)
  })

  it('discovers reads from every family the router mounts', () => {
    const names = servedReads()
    // One named member per family, so a family that stopped being mounted —
    // or was renamed — reddens here rather than silently shrinking the
    // population every other assertion is measured against.
    for (const expected of [
      'accounts.list',
      'approvals.list',
      'auth.profile',
      'automations.runs',
      'cloud.runtime',
      'conversations.search',
      'cost.tasks',
      'discovery.lastMachineScan',
      'features.state',
      'files.read',
      'git.commitDiffFile',
      'interactions.forSession',
      'issues.get',
      'layout.get',
      'lock.status',
      'machines.list',
      'messages.show',
      'models.catalog',
      'operations.active',
      'perf.snapshot',
      'pins.list',
      'quota.history',
      'readPosition.get',
      'repos.browse',
      'search.query',
      'sessions.recap',
      'settings.get',
      'settings.viewer',
      'setup.provenance',
      'snoozes.list',
      'specs.search',
      'superagent.history',
      'sync.feedSlice',
      'tabs.listOrders',
      'telemetry.preview',
      'updates.fleet',
      'usage.summary',
      'workflows.status',
    ]) {
      expect(names).toContain(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// Totality, in both directions
// ---------------------------------------------------------------------------

describe('every externally reachable projection is classified', () => {
  it('classifies every served read', () => {
    const missing = censusPopulation().filter((name) => !CENSUS_NAMES.includes(name))
    // Default-closed for the read half: a projection added without a census
    // entry is a disclosure nobody decided on, so the gate names it here. This
    // is the assertion the old hand-maintained `SERVED` array could not make —
    // a read absent from both lists was absent from this comparison too.
    expect(missing).toEqual([])
  })

  it('classifies nothing that is not served', () => {
    const served = servedReads()
    const phantom = CENSUS_NAMES.filter((name) => !served.includes(name))
    // The second direction, for `derived-family.ts`'s reason: without it an
    // EMPTY surface satisfies every claim the census makes. It also catches a
    // read that was deleted while its policy stayed, which is how an audit
    // surface starts describing a system that no longer exists.
    expect(phantom).toEqual([])
  })

  it('puts every read in exactly one list', () => {
    const governed = new Set(PROJECTION_POLICIES.map((policy) => policy.name))
    const both = UNGOVERNED_PROJECTIONS.filter((entry) => governed.has(entry.name))
    // A read that is both governed and ungoverned would let a reviewer find
    // whichever answer they were looking for.
    expect(both.map((entry) => entry.name)).toEqual([])
    expect(new Set(CENSUS_NAMES).size).toBe(CENSUS_NAMES.length)
  })
})

// ---------------------------------------------------------------------------
// The exclusions — checked against the tables that supposedly justify them
// ---------------------------------------------------------------------------

describe('the reads the census excludes are classified somewhere else', () => {
  it('resolves every exclusion it claims', () => {
    const classified = classifiedPaths()
    const unresolved = servedReads()
      .filter((name) => classified.has(name))
      // An exclusion is only an exclusion if the table it names actually
      // carries a declared action for it. Without this, `CLASSIFIED_ELSEWHERE`
      // would be a second hand-maintained list — the exact instrument this file
      // was rewritten to delete — and a name added to it would silently buy a
      // read out of the census.
      .filter((name) => {
        const mount = classified.get(name)
        const action = mount?.actions.get(name)
        return typeof action !== 'string' || action.trim() === ''
      })
    expect(unresolved).toEqual([])
  })

  it('never classifies the same read twice', () => {
    const classified = classifiedPaths()
    const doubled = CENSUS_NAMES.filter((name) => classified.has(name))
    // A read with both a ProjectionPolicy and a command contract is two answers
    // to "how is this authorized" — the fork POD-386 spent a phase removing.
    expect(doubled).toEqual([])
  })

  it('keeps every mount live', () => {
    const reads = new Set(servedReads())
    const dead = CLASSIFIED_ELSEWHERE.filter(
      (mount) => ![...mount.actions.keys()].some((path) => reads.has(path)),
    ).map((mount) => mount.family)
    // A mount that classifies nothing served is either a family that was
    // unmounted or a table that was renamed. Either way the exclusion is stale,
    // and a stale exclusion is how an absorbed surface reads as progress.
    expect(dead).toEqual([])
  })

  it('excludes only the four families it names, and names them', () => {
    const classified = classifiedPaths()
    const excluded = servedReads().filter((name) => classified.has(name))
    const families = [...new Set(excluded.map((name) => name.split('.')[0]))].sort()
    // The exclusion is a claim about FOUR mounted registries, not a general
    // licence. A fifth family becoming exempt must be a deliberate edit here
    // with an owner beside it, never a side effect of adding a table.
    expect(families).toEqual(['issues', 'lock', 'messages', 'settings'])
  })

  it('states the instrument that keeps each excluded table total', () => {
    for (const mount of CLASSIFIED_ELSEWHERE) {
      // "Classified elsewhere" is only an answer if someone can say WHERE and
      // what keeps that elsewhere complete. An unowned exclusion is an
      // unclassified read with better manners.
      expect(mount.table.length).toBeGreaterThan(10)
      expect(mount.owner.length).toBeGreaterThan(20)
    }
  })
})

describe('every governed policy is well formed', () => {
  it('has no classification errors', () => {
    const errors = PROJECTION_POLICIES.flatMap((policy) => projectionPolicyErrors(policy))
    expect(errors).toEqual([])
  })

  it('states a row scope and an indirect-resource answer for every read', () => {
    for (const policy of PROJECTION_POLICIES) {
      // `indirectResources` may be empty, but the field must be present: "this
      // read reaches nothing else" and "nobody asked" must not look alike. An
      // absent array would be the latter wearing the former's clothes.
      expect(Array.isArray(policy.indirectResources)).toBe(true)
      expect(Array.isArray(policy.forbiddenFields)).toBe(true)
      expect(policy.rationale.length).toBeGreaterThan(20)
    }
  })
})

describe('the ungoverned list is a finding list, not a waiver', () => {
  it('is non-empty until the reads are actually governed', () => {
    // A gap list someone empties by deleting rows rather than fixing reads would
    // otherwise look exactly like success. When this genuinely reaches zero, this
    // assertion is the thing that has to be deliberately removed.
    expect(UNGOVERNED_PROJECTIONS.length).toBeGreaterThan(0)
  })

  it('names an owning phase and a finding for every entry', () => {
    for (const entry of UNGOVERNED_PROJECTIONS) {
      expect(['B', 'C', 'F']).toContain(entry.owner)
      expect(entry.finding.length).toBeGreaterThan(40)
    }
  })

  it('separates private-execution disclosure from mere unclassification', () => {
    // The reads that disclose one person's private execution to another are a
    // different severity from a shared-material read nobody has classified, and
    // collapsing them would let the urgent ones wait behind the tidy ones.
    // This list SHRINKS as the reads are governed, and each removal is a claim
    // about a shipped handler rather than a tidy-up: `sessions.status` was the
    // sixth until PDM-229, `conversations.search` the fifth until PDM-274 found
    // its rule already shipped two hops below the query table, and
    // `accounts.list` the fourth until PDM-271 — which, unlike those two, was
    // genuinely ungoverned and had to be FIXED rather than found. All three are
    // in PROJECTION_POLICIES now and the totality test above keeps each in
    // exactly one list.
    //
    // The three that remain are the `files.*` family, and they are one gap
    // rather than three: the same `assertAllowedRoot`, which asks whether a path
    // is a known repository and never who is asking.
    const disclosing = UNGOVERNED_PROJECTIONS.filter(
      (entry) => entry.severity === 'discloses-private-execution',
    ).map((entry) => entry.name)
    expect(disclosing).toEqual(['files.read', 'files.list', 'files.search'])
  })
})
