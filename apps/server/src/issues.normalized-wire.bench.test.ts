import { normalizeSettings } from '@podium/runtime'
import { afterEach, expect, it } from 'vitest'
import {
  issueMembershipScanCount,
  resetIssueWireBuildCount,
} from './modules/issues/instrumentation'
import { perf } from './modules/perf/registry'
import { SessionRegistry } from './relay'
import type { IssueRow } from './store'
import { SessionStore } from './store'

/**
 * THE A/B [POD-796, for POD-736's quantitative gate] — what the cutover removes
 * from the session-broadcast path, at the LIVE instance's scale, measured
 * through the POD-701 harness's own phase timers.
 *
 * ## Why this is a server-side bench and not the browser switch bench
 *
 * `tests/e2e/switch-bench.ts` measures chat-switch p50/p90 in a real browser,
 * and it is the right instrument for POD-736's gate — but it cannot see this
 * change yet, and running it would produce a confidently wrong zero. The bypass
 * engages only when EVERY connected delta client offers CAP_ISSUES_NORMALIZED,
 * and `apps/web` deliberately does not: the cap promises "I no longer need
 * IssueWire", and the web replica's issue views still read it because
 * `IssueProjection` carries no `deps`/`prefix` and nothing replica-side supplies
 * them (POD-822). So a browser A/B would run its flag-ON arm with a non-cap
 * client, never engage the bypass, and measure flag-ON == flag-OFF. That number
 * would be real, reproducible, and a lie about the cutover.
 *
 * The browser A/B is therefore blocked on POD-822, not on the harness. What is
 * measurable NOW is the server-side phase the bypass deletes, which is the whole
 * of what POD-796 changes on the publish path.
 *
 * ## The metric-name contract [packages/protocol/src/perf.ts STABILITY]
 *
 * Nothing is renamed here and no baseline is invalidated. This CONSUMES two
 * existing phase names exactly as POD-701/POD-722 defined them:
 *   - `sessionsBroadcast.publishIssues`        — the rebuild ran, and its cost
 *   - `sessionsBroadcast.publishIssuesSkipped` — the rebuild did not run
 * The migration story POD-736 asks for is therefore: THERE IS NO RENAME. The
 * cutover does not re-point `sessionsBroadcast.*` at a new pipeline; it makes the
 * `publishIssues` phase STOP EXECUTING and the existing `publishIssuesSkipped`
 * phase fire in its place. Both names keep their POD-701 meaning, so the recorded
 * baselines stay comparable and the gate can read the same keys before and after.
 * (`publishIssuesSkipped` is itself a post-baseline addition under the same
 * contract — POD-701's own accounting note says so.)
 */

// The live instance, measured 2026-07-17 from a read-only copy of ~/.podium.
const ISSUE_COUNT = 793
const SESSION_COUNT = 588

function issueRow(i: number): IssueRow {
  return {
    id: `iss_${i}`,
    repoPath: '/repo',
    repoId: 'repo_1',
    seq: i,
    title: `issue ${i}`,
    description: '',
    stage: 'in_progress',
    worktreePath: `/repo/.worktrees/w${i}`,
    branch: `issue/${i}`,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: null,
    suggestedReason: null,
    blockedBy: [],
    dependencyNote: null,
    prUrl: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archived: false,
    priority: 0,
    type: 'task',
    assignee: null,
    parentId: null,
    design: null,
    acceptance: null,
    notes: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null,
    supersededBy: null,
    duplicateOf: null,
    pinned: false,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
  }
}

function seedSession(store: SessionStore, i: number): string {
  const id = `sess_${i}`
  store.sessions.upsertSession({
    id,
    agentKind: 'shell',
    cwd: `/repo/.worktrees/w${i % ISSUE_COUNT}`,
    title: `session ${i}`,
    name: null,
    archived: false,
    workState: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'hibernated',
    exitCode: null,
    durableLabel: `podium-${id}`,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: null,
    machineId: 'm1',
    headless: false,
    issueId: `iss_${i % ISSUE_COUNT}`,
    readAt: null,
  })
  return id
}

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function world(flag: boolean, caps: string[]) {
  const store = new SessionStore(':memory:')
  for (let i = 0; i < ISSUE_COUNT; i++) store.issues.upsertIssue(issueRow(i))
  const sessionIds: string[] = []
  for (let i = 0; i < SESSION_COUNT; i++) sessionIds.push(seedSession(store, i))
  store.settings.setSettings({
    ...normalizeSettings(undefined),
    experimental: { 'issues-normalized-wire': flag },
  })
  const registry = new SessionRegistry(store)
  registries.push(registry)
  const id = registry.modules.sessions.attachClient(() => {})
  registry.modules.sessions.onClientMessage(id, {
    type: 'hello',
    clientId: '',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    caps,
  })
  registry.modules.sessions.flushBroadcasts()
  return { registry, sessionIds }
}

/** One arm: N one-field session changes, timed through the real phase timers.
 *  The arms differ in TWO inputs (flag AND client caps), deliberately: flag-ON
 *  with a non-cap client never engages the bypass (the skip is AND-composed
 *  with legacyIssueWireNeeded()), so it measures the OLD path — the
 *  legacy-client tests in issues.normalized-wire.test.ts pin exactly that.
 *  flag-OFF+cap likewise behaves as the old path. The two-variable arm is the
 *  one that isolates the bypass. */
function arm(flag: boolean, caps: string[], rounds: number) {
  const { registry, sessionIds } = world(flag, caps)
  perf.reset()
  resetIssueWireBuildCount()
  const states = ['testing', 'reviewing', 'coding', 'debugging'] as const
  for (let i = 0; i < rounds; i++) {
    registry.modules.sessions.setWorkState({
      sessionId: sessionIds[i % SESSION_COUNT] as string,
      // Must actually MOVE the projection each round or POD-722 skips it and the
      // arm measures nothing — the same vacuity the D7.2 control exists to catch.
      workState: states[i % states.length] as 'testing',
    })
    registry.modules.sessions.flushBroadcasts()
  }
  const phases = perf.snapshot().phases
  return {
    published: phases['sessionsBroadcast.publishIssues'],
    skipped: phases['sessionsBroadcast.publishIssuesSkipped'],
    scans: issueMembershipScanCount(),
  }
}

it(`A/B at live scale (${ISSUE_COUNT} issues x ${SESSION_COUNT} sessions): the cutover deletes the publishIssues phase`, {
  timeout: 120_000,
}, () => {
  const ROUNDS = 20

  // OLD PATH: the real post-POD-722/723 pipeline, on a client that needs IssueWire.
  const old = arm(false, ['metadataDelta'], ROUNDS)
  // NEW PATH: same world, same changes, a client that can read projections.
  const neu = arm(true, ['metadataDelta', 'issuesNormalized'], ROUNDS)

  const report = [
    '',
    `A/B — one-field session change (workState), ${ROUNDS} rounds, ${ISSUE_COUNT} issues x ${SESSION_COUNT} sessions`,
    '',
    'OLD PATH (flag off — the REAL post-722/723 pipeline, not the pre-fix one):',
    `  sessionsBroadcast.publishIssues   count=${old.published?.count ?? 0} p50=${old.published?.p50Ms ?? '-'}ms p90=${old.published?.p90Ms ?? '-'}ms max=${old.published?.maxMs ?? '-'}ms`,
    `  sessionsBroadcast.publishIssuesSkipped count=${old.skipped?.count ?? 0}`,
    `  issue membership scans (D7.2 unit) = ${old.scans}  (= ${ISSUE_COUNT} x ${ROUNDS}; each filters all ${SESSION_COUNT} sessions)`,
    '',
    'NEW PATH (flag on + cap client):',
    `  sessionsBroadcast.publishIssues   count=${neu.published?.count ?? 0}  <- the phase does not execute`,
    `  sessionsBroadcast.publishIssuesSkipped count=${neu.skipped?.count ?? 0} p50=${neu.skipped?.p50Ms ?? '-'}ms`,
    `  issue membership scans (D7.2 unit) = ${neu.scans}`,
    '',
  ].join('\n')
  console.error(report)

  // The old path pays the rebuild on every round...
  expect(old.published?.count, 'the old-path control must actually publish').toBe(ROUNDS)
  expect(old.scans, 'the old path scans every issue, every round').toBe(ISSUE_COUNT * ROUNDS)
  // ...and the new path does not execute the phase at all. Not "faster": absent.
  expect(
    neu.published?.count ?? 0,
    'the publishIssues phase must not execute at all on the new path',
  ).toBe(0)
  expect(neu.scans, 'the new path performs no issue work whatsoever').toBe(0)
})
