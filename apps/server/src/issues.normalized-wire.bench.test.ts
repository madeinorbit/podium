import { asIssueId, asSessionId, FIRST_ADMIN_USER_ID, asMachineId} from '@podium/model'
import { WIRE_VERSION } from '@podium/protocol'
import { afterEach, expect, it } from 'vitest'
import {
  issueMembershipScanCount,
  issueWireBuildCount,
  resetIssueWireBuildCount,
} from './modules/issues/instrumentation'
import { SessionRegistry } from './relay'
import type { IssueRow } from './store'
import { SessionStore } from './store'
import { attachTestClient } from './test-support/client-transport'

/**
 * POD-797 residue path through the production composition root.
 *
 * A capless attach still paints the session-free transitional issue list, and
 * every later session change must perform zero issue builds and zero membership
 * scans. The detector is those exact counters — not wall-clock.
 *
 * Scale is 60×40, the same as `issues.normalized-wire.test.ts` D7.2, and it has
 * come down twice for one reason: `new SessionRegistry` is O(issues × sessions),
 * so every entity added here buys fixture cost rather than evidence. A live
 * snapshot (793×588, measured 2026-07-17 from ~/.podium) exceeded five minutes in
 * construction alone and the timeout fired before the assertions ran (POD-1418);
 * 300×200 cost ~33s and did the same thing under ordinary CPU contention
 * (POD-1522, measured 2026-08-03 — see the sister file for the full curve).
 * The zero property never needed the census: the counters are exact, so any
 * residual coupling reads nonzero at 60×40 exactly as it would at 793×588, and
 * the unit lane must not soak composition-root boot at live entity counts.
 * Evidence: docs/agents/pod-1418-normalized-wire-bench.md.
 */

const ISSUE_COUNT = 60
const SESSION_COUNT = 40
/** Sister D7.2 scale guards use 60s. Same order of magnitude here: wedge only;
 *  the zero-build / zero-scan assertions are the detector. At this scale the
 *  guard runs in ~1.5s, so the watchdog is headroom rather than a race. */
const RESIDUE_GUARD_TIMEOUT_MS = 60_000

function issueRow(i: number): IssueRow {
  // The fixture builds ids from template strings; branding at the boundary keeps
  // the row literal readable and the type honest.
  return {
    id: `iss_${i}`,
    ownerUserId: FIRST_ADMIN_USER_ID,
    visibility: 'personal',
    createdByActor: FIRST_ADMIN_USER_ID,
    createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
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
    closedAt: null,
    supersededBy: null,
    duplicateOf: null,
    pinned: false,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
  } as unknown as IssueRow
}

function seedSession(store: SessionStore, i: number): string {
  const id = `sess_${i}`
  store.sessions.upsertSession({
    id: asSessionId(id),
    ownerUserId: FIRST_ADMIN_USER_ID,
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
    machineId: asMachineId('m1'),
    headless: false,
    issueId: asIssueId(`iss_${i % ISSUE_COUNT}`),
  })
  return id
}

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function world() {
  const store = new SessionStore(':memory:')
  for (let i = 0; i < ISSUE_COUNT; i++) store.issues.upsertIssue(issueRow(i))
  const sessionIds: string[] = []
  for (let i = 0; i < SESSION_COUNT; i++) sessionIds.push(seedSession(store, i))
  const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
  registries.push(registry)

  resetIssueWireBuildCount()
  const id = attachTestClient(registry.clientGateway, () => {})
  const attachBuilds = issueWireBuildCount()
  const attachScans = issueMembershipScanCount()
  registry.clientGateway.routeClientFrame(id, {
    type: 'hello',
    wireVersion: WIRE_VERSION,
    clientId: '',
    viewport: { cols: 80, rows: 24, dpr: 1 },
  })
  registry.modules.sessions.flushBroadcasts()
  return { registry, sessionIds, attachBuilds, attachScans }
}

it('session-free residue never couples session changes back to issues', {
  timeout: RESIDUE_GUARD_TIMEOUT_MS,
}, () => {
  const { registry, sessionIds, attachBuilds, attachScans } = world()
  // BOUNDED, not pinned at ISSUE_COUNT. Main measures one build per issue at
  // attach; here it is typically ZERO, because the POD-723 memo is populated at
  // registry construction and the attach paints from it. Pinning the exact number
  // would be pinning WHEN the list was built rather than how much it costs, and
  // it would fail on either side of a legitimate change. What must never happen
  // is a build PER SESSION — that is the coupling under test, and it overshoots
  // this bound by a factor of SESSION_COUNT.
  expect(attachBuilds).toBeLessThanOrEqual(ISSUE_COUNT)
  expect(attachScans).toBe(0)

  resetIssueWireBuildCount()
  const states = ['testing', 'reviewing', 'coding', 'debugging'] as const
  for (let i = 0; i < 20; i++) {
    registry.modules.sessions.setWorkState({
      sessionId: asSessionId(sessionIds[i % SESSION_COUNT] as string),
      workState: states[i % states.length] as 'testing',
    })
    registry.modules.sessions.flushBroadcasts()
  }
  expect(issueWireBuildCount()).toBe(0)
  expect(issueMembershipScanCount()).toBe(0)
})
