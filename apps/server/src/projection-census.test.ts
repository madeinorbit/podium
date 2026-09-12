/**
 * THE PROJECTION POPULATION GATE (A3/PDM-129) — every externally reachable read
 * is classified, and the population is derived from the QUERY TABLES rather than
 * from a list anyone maintains.
 *
 * This is `classification-totality.test.ts`'s argument applied to the read half.
 * That file exists because the command side's totality claim once rested on
 * sixteen independent per-registry calls, so the seventeenth registry was outside
 * every instrument and nothing anywhere said so. The read side had it worse: it
 * had no instrument at all, because `DerivedQuery` has no policy field to check.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST LIVES IN `apps/server` AND THE CENSUS LIVES IN `@podium/commands`
 * ---------------------------------------------------------------------------
 *
 * The census is L1 data and must stay importable by clients. The query tables are
 * L3 — they close over services — so only this package can see both. Putting the
 * table here instead would move an authorization contract into a feature package,
 * which is POD-311 finding 1; putting the test in `@podium/commands` would make
 * an L1 package import L3 services. The seam is the one the codebase already has.
 *
 * ---------------------------------------------------------------------------
 * A SCAN THAT FINDS NOTHING PASSES EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * Every assertion below is a comparison against a discovered population, so a
 * discovery that silently stopped matching would turn this file green and mean
 * nothing. The first test is therefore the instrument check and it is
 * load-bearing: it asserts the discovered population is the expected SIZE and
 * includes named members from every table family. "Everything is classified" may
 * only be read after "and it looked at these 69 reads".
 */

import { describe, expect, it } from 'vitest'
import {
  PROJECTION_POLICIES,
  projectionPolicyErrors,
  UNGOVERNED_PROJECTIONS,
} from '@podium/commands'
import { ACCOUNT_QUERIES } from './modules/accounts/queries'
import { APPROVAL_QUERIES } from './modules/approvals/queries'
import { CLOUD_QUERIES } from './modules/cloud/queries'
import { CONVERSATION_QUERIES } from './modules/conversations/queries'
import { FILE_QUERIES } from './modules/files/queries'
import { DISCOVERY_QUERIES, REPO_QUERIES } from './modules/fleet/queries'
import { AUTH_QUERIES, SETUP_QUERIES, TELEMETRY_QUERIES } from './modules/instance/queries'
import { INTERACTION_QUERIES } from './modules/interactions/queries'
import {
  AUTOMATION_QUERIES,
  COST_QUERIES,
  FEATURE_QUERIES,
  GIT_QUERIES,
  QUOTA_QUERIES,
  SEARCH_QUERIES,
  SETTINGS_QUERIES,
  SPEC_QUERIES,
  SUPERAGENT_QUERIES,
  USAGE_QUERIES,
} from './modules/misc-queries'
import { MODEL_QUERIES } from './modules/models/queries'
import { PERF_QUERIES } from './modules/perf/queries'
import {
  PIN_QUERIES,
  SESSION_QUERIES,
  SNOOZE_QUERIES,
  SYNC_QUERIES,
  TAB_QUERIES,
} from './modules/sessions/queries'
import { WORKFLOW_QUERIES } from './modules/workflows/queries'

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * THE SERVED POPULATION, keyed by the tRPC path the router actually mounts each
 * table on.
 *
 * The router key is NOT always the table's name — `REPO_QUERIES` is mounted at
 * `repos`, `SEARCH_QUERIES` at `search`, `SYNC_QUERIES`' three entries at
 * `sessions`. Writing the tRPC path here rather than deriving it from the
 * constant's name is deliberate: the census names what a CALLER can reach, and a
 * policy filed under a name no caller can type is a policy for nothing.
 *
 * `machines.list` is appended separately because it is the one read still
 * hand-written in `router.ts` with no table to discover it from — which is
 * itself its census finding.
 */
const SERVED: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
  ['accounts', ACCOUNT_QUERIES],
  ['approvals', APPROVAL_QUERIES],
  ['cloud', CLOUD_QUERIES],
  ['conversations', CONVERSATION_QUERIES],
  ['files', FILE_QUERIES],
  ['repos', REPO_QUERIES],
  ['discovery', DISCOVERY_QUERIES],
  ['setup', SETUP_QUERIES],
  ['auth', AUTH_QUERIES],
  ['telemetry', TELEMETRY_QUERIES],
  ['interactions', INTERACTION_QUERIES],
  ['search', SEARCH_QUERIES],
  ['git', GIT_QUERIES],
  ['usage', USAGE_QUERIES],
  ['cost', COST_QUERIES],
  ['quota', QUOTA_QUERIES],
  ['features', FEATURE_QUERIES],
  ['superagent', SUPERAGENT_QUERIES],
  ['specs', SPEC_QUERIES],
  ['settings', SETTINGS_QUERIES],
  ['automations', AUTOMATION_QUERIES],
  ['models', MODEL_QUERIES],
  ['perf', PERF_QUERIES],
  ['sessions', SESSION_QUERIES],
  ['sync', SYNC_QUERIES],
  ['pins', PIN_QUERIES],
  ['snoozes', SNOOZE_QUERIES],
  ['tabs', TAB_QUERIES],
  ['workflows', WORKFLOW_QUERIES],
]

/** The hand-written exception, named so it cannot be forgotten by being absent. */
const HAND_WRITTEN_READS = ['machines.list'] as const

function servedProjectionNames(): string[] {
  const names: string[] = []
  for (const [family, table] of SERVED) {
    for (const name of Object.keys(table)) names.push(`${family}.${name}`)
  }
  names.push(...HAND_WRITTEN_READS)
  return names
}

const CENSUS_NAMES = [
  ...PROJECTION_POLICIES.map((policy) => policy.name),
  ...UNGOVERNED_PROJECTIONS.map((entry) => entry.name),
]

// ---------------------------------------------------------------------------
// The instrument check — read this before reading anything below it
// ---------------------------------------------------------------------------

describe('the projection scan found the fleet', () => {
  it('discovers 69 externally reachable reads', () => {
    // 68 from the query tables plus the one hand-written read. A change to this
    // number is a change to the SURFACE, and it should arrive with a policy.
    expect(servedProjectionNames()).toHaveLength(69)
  })

  it('discovers reads from every table family', () => {
    const names = servedProjectionNames()
    // One named member per family, so a table that stopped exporting — or was
    // renamed out of the import list above — reddens here rather than silently
    // shrinking the population every other assertion is measured against.
    for (const expected of [
      'accounts.list',
      'approvals.list',
      'cloud.runtime',
      'conversations.search',
      'files.read',
      'repos.browse',
      'discovery.lastMachineScan',
      'setup.provenance',
      'auth.profile',
      'telemetry.preview',
      'interactions.forSession',
      'search.query',
      'git.commitDiffFile',
      'usage.summary',
      'cost.tasks',
      'quota.history',
      'features.state',
      'superagent.history',
      'specs.search',
      'settings.get',
      'automations.runs',
      'models.catalog',
      'perf.snapshot',
      'sessions.recap',
      'sync.feedSlice',
      'pins.list',
      'snoozes.list',
      'tabs.listOrders',
      'workflows.status',
      'machines.list',
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
    const missing = servedProjectionNames().filter((name) => !CENSUS_NAMES.includes(name))
    // Default-closed for the read half: a projection added without a census
    // entry is a disclosure nobody decided on, so the gate names it here.
    expect(missing).toEqual([])
  })

  it('classifies nothing that is not served', () => {
    const served = servedProjectionNames()
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
    // The six reads that disclose one person's private execution to another are
    // a different severity from a shared-material read nobody has classified,
    // and collapsing them would let the urgent ones wait behind the tidy ones.
    const disclosing = UNGOVERNED_PROJECTIONS.filter(
      (entry) => entry.severity === 'discloses-private-execution',
    ).map((entry) => entry.name)
    expect(disclosing).toEqual([
      'sessions.status',
      'accounts.list',
      'files.read',
      'files.list',
      'files.search',
      'conversations.search',
    ])
  })
})
