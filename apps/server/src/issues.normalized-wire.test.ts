import { asIssueId, asSessionId, FIRST_ADMIN_USER_ID, asMachineId } from '@podium/model'
import { type ServerMessage, WIRE_VERSION } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  issueMembershipScanCount,
  issueWireBuildCount,
  resetIssueWireBuildCount,
} from './modules/issues/instrumentation'
import { userCommandPrincipal } from './command-principal'
import { SessionRegistry } from './relay'
import type { IssueRow } from './store'
import { SessionStore } from './store'
import { attachTestClient } from './test-support/client-transport'

/** The fixture's caller. `addComment` requires a principal (POD-1315) — these
 *  tests exercise the operator seam, so they say so rather than defaulting. */
const AS_OPERATOR = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin')

/**
 * The normalized issue wire, end to end through the PRODUCTION wiring
 * [POD-797] — unconditional normalized emission plus the mechanical D7.2
 * guard that every session change performs zero issue membership scans.
 *
 * Everything here runs over `new SessionRegistry(store)`: the real relay
 * composition, the real Ledger over a real (in-memory) SessionStore, real
 * clients over real `hello`/`attach` frames. No browser, and no stubs on the
 * path under test — the D7.2 claim is a claim about how these parts are WIRED
 * TOGETHER, so a harness that faked any of them could not witness it.
 */

/**
 * SIZED TO THE ASSERTION, NOT TO A LIVE CENSUS [POD-1522].
 *
 * These were 300×200, and the whole cost of that is `new SessionRegistry`:
 * registry construction is O(issues × sessions) at roughly 0.5ms per pair
 * (measured 2026-08-03 at b82fa157 — 300×0: 139ms, 0×200: 125ms, 300×50: 7.4s,
 * 300×100: 14.7s, 300×200: 29.6s, 600×200: 57.8s; both axes alone are free, the
 * product is everything). At 300×200 the guards spent ~33s in the fixture and
 * ~0.5s on the thing under test, against a 60s watchdog — so ordinary CPU
 * contention timed them out and NO ASSERTION RAN. Reproduced deliberately: with
 * only these two files in the lane and 12 spinners on 8 vCPUs, all three scale
 * guards died at `Test timed out in 60000ms`; +120 inert files on a quiet box
 * did not reproduce, so it was contention, never file count or cross-suite state.
 *
 * The scale was never the detector and does not need to be. The counters are
 * EXACT: a reintroduced membership scan increments once per issue touched, so it
 * reads ≥1 at any issue count ≥1, and the zero-vs-nonzero distinction has no
 * noise floor to clear. What the scale must still do is separate CONSTANT work
 * from work PROPORTIONAL to entity count — 60×40 does that with 2400 pairs
 * behind it, two orders of magnitude above the bounds asserted here.
 *
 * This is a change to what the fixture COSTS, not to what it CLAIMS. The
 * O(issues × sessions) boot cost is real and is not fixed by shrinking the
 * fixture; it is filed as its own defect (POD-1529) because it
 * is composition-root boot on the production path, where these counters are not
 * instrumented and therefore never witnessed it.
 */
const ISSUE_COUNT = 60
const SESSION_COUNT = 40
/** Wedge watchdog only — deliberately NOT widened (that move was already made
 * once, 20s→60s in POD-1308, and it only moved the threshold). At the scale
 * above the guards run in ~1.5s, so this is ~40x headroom rather than the ~2x
 * that made them contention-fragile. The zero-scan assertions are the detector. */
const SCALE_GUARD_TIMEOUT_MS = 60_000

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

/** A session row that hydrates into a live `Session` object at boot WITHOUT a
 *  PTY — `loadFromStore` rebuilds hibernated rows, so `listSessions()` reaches a
 *  realistic scale for the price of an INSERT. */
function seedSession(
  store: SessionStore,
  i: number,
  issueId: string | null = `iss_${i % ISSUE_COUNT}`,
): string {
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
    issueId: issueId === null ? null : asIssueId(issueId),
  })
  return id
}

function world(opts: { issues?: number; sessions?: number } = {}) {
  const store = new SessionStore(':memory:')
  for (let i = 0; i < (opts.issues ?? ISSUE_COUNT); i++) store.issues.upsertIssue(issueRow(i))
  const sessionIds: string[] = []
  for (let i = 0; i < (opts.sessions ?? SESSION_COUNT); i++) sessionIds.push(seedSession(store, i))
  const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
  registries.push(registry)
  return { store, registry, sessionIds }
}

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function client(registry: SessionRegistry, caps: string[] | undefined): string {
  const id = attachTestClient(registry.clientGateway, () => {})
  registry.clientGateway.routeClientFrame(id, {
    type: 'hello',
    wireVersion: WIRE_VERSION,
    clientId: '',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    ...(caps ? { caps } : {}),
  })
  return id
}

/**
 * THE measurement: issue work performed by ONE one-field session change.
 *
 * ## Why the assertions read `scans`, not `builds` [POD-796, post-rebase]
 *
 * `builds` counts `toWire` calls; `scans` counts issues TOUCHED by the list path.
 * Post-POD-723 they diverge, and only one of them is D7.2's unit. On the old path
 * this change reads **1 build but ISSUE_COUNT scans**: POD-723's memo reuses every
 * cached payload but one, and still calls `sessionsForIssue()` for every issue to
 * compute the cache key, each of those filtering all SESSION_COUNT sessions. So the
 * O(issues × sessions) work D7.2 forbids is entirely intact — one comparison per
 * pair — and a build-counting assertion would have read "1 vs 0" and
 * quietly reported the shim as near-compliant. D7.2 forbids WORK proportional to
 * entity count, not serializations. Both numbers are returned so the divergence
 * stays visible rather than becoming folklore.
 *
 * ## Why the trigger is `workState` and not `clientCount` [POD-796, post-rebase]
 *
 * It WAS `clientCount` 0→1 (a client attaching). That was measured pre-rebase,
 * against a branch that predated POD-722 — and POD-722 is precisely a denylist of
 * `['clientCount', 'controllerId', 'epoch']`, the three fields that cannot show up
 * on the issue wire, whose changes it skips upstream of this bypass. So after the
 * rebase the old trigger measured 0 builds on BOTH arms and the flag-OFF control
 * went red, exactly as it was built to: the test had become vacuous, because
 * POD-722 already fixes that specific field. The control earning its keep is the
 * reason this comment can be honest instead of a green lie.
 *
 * `setWorkState` is deliberately POD-722's OWN canonical republish case
 * (`broadcast-issue-skip.test.ts`: "a workState change republishes issues"), so
 * there is no argument to have about whether it is issue-relevant — POD-722
 * asserts that it is, and rebuilds every issue for it. That makes this the
 * sharpest available statement of what the normalization actually buys:
 *
 *   POD-722 is a PARTIAL fix — 3 fields of pure connection churn.
 *   The normalization is TOTAL — every session field, including this one,
 *   because `toWire(issue)` has no session parameter to read.
 *
 * The same property holds for `phase`, `title` and `lastActiveAt` (which ticks on
 * every single agent activity, and is the honest hot path); `workState` is used
 * because it is a documented one-field public setter with POD-722's own test
 * standing behind its relevance.
 *
 * The window opens only AFTER every client has said hello: `attachClient` paints
 * a bootstrap `issuesChanged` built fresh (a legitimate O(issues) build, but not
 * the one under test), and a client that has not yet negotiated caps counts as
 * legacy — so creating a client inside the window measured the bootstrap AND
 * suppressed the very bypass under test.
 */
function issueWorkForOneFieldSessionChange(
  registry: SessionRegistry,
  sessionId: string,
): { builds: number; scans: number } {
  registry.modules.sessions.flushBroadcasts()
  resetIssueWireBuildCount()
  registry.modules.sessions.setWorkState({
    sessionId: asSessionId(sessionId),
    workState: 'testing',
  })
  registry.modules.sessions.flushBroadcasts()
  return { builds: issueWireBuildCount(), scans: issueMembershipScanCount() }
}

describe('issueProjection emission is unconditional with transitional legacy residue [POD-797]', () => {
  const changesOf = (registry: SessionRegistry, entity: string) => {
    const boot = registry.modules.sessions.syncChangesSince(null)
    // A null cursor bootstraps to a snapshot; take a cursor from 0 to read the
    // whole durable change log instead.
    const all = registry.modules.sessions.syncChangesSince(0)
    return all.kind === 'delta'
      ? all.changes.filter((c) => c.entity === entity)
      : (boot.kind === 'delta' ? boot.changes : []).filter((c) => c.entity === entity)
  }

  it('issueProjection rows and session-free legacy issue rows are both appended', () => {
    const { registry } = world({ issues: 3, sessions: 2 })
    registry.modules.issues.update('iss_1', { title: 'edited' })
    registry.modules.sessions.flushBroadcasts()

    const projections = changesOf(registry, 'issueProjection')
    const legacy = changesOf(registry, 'issue')
    // ADDITIVE: both kinds carry the edit. An old client reads 'issue' exactly as
    // before; a cap client reads 'issueProjection'.
    expect(projections.some((c) => c.id === 'iss_1')).toBe(true)
    expect(legacy.some((c) => c.id === 'iss_1')).toBe(true)

    const edited = projections.filter((c) => c.id === 'iss_1').at(-1)
    const value = edited?.op === 'upsert' ? (edited.value as Record<string, unknown>) : undefined
    expect(value?.title).toBe('edited')
    // The normalized shape, on the wire, for real: no embedded session payload.
    expect(value).not.toHaveProperty('sessions')
    expect(value).not.toHaveProperty('sessionSummary')
    expect(value).not.toHaveProperty('unread')
    // And it carries the revision the write just assigned (ADR 2 D3).
    expect(value?.revision).toBe(2)
  })

  it('cold snapshot includes all normalized issue collections for reload bootstrap', () => {
    const { registry, store } = world({ issues: 2, sessions: 0 })
    store.repos.addRepo('/repo', store.hostMachineId)
    registry.modules.issues.addDep('iss_0', 'iss_1')

    const snapshot = registry.modules.sessions.syncChangesSince(null)
    expect(snapshot.kind).toBe('snapshot')
    if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot')
    expect(snapshot.issueProjections?.map((row) => row.id).sort()).toEqual(['iss_0', 'iss_1'])
    expect(snapshot.issueDeps).toHaveLength(1)
    expect(snapshot.repos).toHaveLength(1)
  })

  it('boot totalizes legacy cwd membership into the normalized snapshot the replica indexes', () => {
    const store = new SessionStore(':memory:')
    store.issues.upsertIssue(issueRow(0))
    const sessionId = seedSession(store, 0, null)

    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    registry.modules.sessions.flushBroadcasts()

    expect(store.sessions.loadSessions().find((row) => row.id === sessionId)?.issueId).toBe('iss_0')
    const snapshot = registry.modules.sessions.syncChangesSince(null)
    expect(snapshot.kind).toBe('snapshot')
    if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot')
    const projection = snapshot.issueProjections?.find((row) => row.id === 'iss_0')
    expect(projection).toBeDefined()
    expect(
      snapshot.sessions
        .filter((session) => session.issueId === projection?.id)
        .map((session) => session.sessionId),
    ).toEqual([sessionId])

    const all = registry.modules.sessions.syncChangesSince(0)
    expect(all.kind).toBe('delta')
    if (all.kind !== 'delta') throw new Error('expected delta')
    const sessionChanges = all.changes.filter(
      (change) => change.entity === 'session' && change.id === sessionId,
    )
    const last = sessionChanges.at(-1)
    expect(last?.op).toBe('upsert')
    const sessionValue =
      last?.op === 'upsert' ? (last.value as { issueId?: string } | undefined) : undefined
    expect(sessionValue?.issueId).toBe('iss_0')

    const cursor = Math.max(...all.changes.map((change) => change.seq))
    const reboot = new SessionRegistry(store, undefined, { instanceId: 'default' })
    registries.push(reboot)
    reboot.modules.sessions.flushBroadcasts()
    const after = reboot.modules.sessions.syncChangesSince(cursor)
    expect(after.kind).toBe('delta')
    if (after.kind !== 'delta') throw new Error('expected delta')
    expect(
      after.changes.filter((change) => change.entity === 'session' && change.id === sessionId),
    ).toEqual([])
  })

  it('comment add advances updatedAt on the normalized projection', () => {
    const { registry } = world({ issues: 1, sessions: 0 })
    const before = registry.modules.issues.get('iss_0')?.updatedAt

    registry.modules.issues.addComment('iss_0', 'agent', 'projection revision premise', AS_OPERATOR)

    const projections = changesOf(registry, 'issueProjection')
    const appended = projections.filter((change) => change.id === 'iss_0').at(-1)
    const value =
      appended?.op === 'upsert' ? (appended.value as Record<string, unknown>) : undefined
    expect(value?.updatedAt).not.toBe(before)
    expect(value?.updatedAt).toBe(registry.modules.issues.get('iss_0')?.updatedAt)
  })
})

describe('D7.2: every session change performs zero issue membership scans [POD-797]', () => {
  it('workState change touches zero issue wire memberships', {
    timeout: SCALE_GUARD_TIMEOUT_MS,
  }, () => {
    const { registry, sessionIds } = world()
    client(registry, undefined)
    const { scans } = issueWorkForOneFieldSessionChange(registry, sessionIds[0] as string)
    expect(scans).toBe(0)
  })
})

describe('current scoped attach paints session-free issue projections [POD-797]', () => {
  it('paints current issue data without embedding sessions', () => {
    const { registry } = world({ issues: 3, sessions: 2 })
    const inbox: ServerMessage[] = []
    const id = attachTestClient(registry.clientGateway, (message) => inbox.push(message))
    registry.clientGateway.routeClientFrame(id, {
      type: 'hello',
      wireVersion: WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
    registry.modules.sessions.flushBroadcasts()
    const painted = inbox.find((message) => message.type === 'feedBootstrap')
    expect(painted).toBeDefined()
    if (!painted || painted.type !== 'feedBootstrap') return
    const issues = painted.changes
      .filter((change) => change.entity === 'issue' && change.op === 'upsert')
      .map((change) => change.value as Record<string, unknown>)
    expect(issues).toHaveLength(3)
    expect(issues[0]).not.toHaveProperty('sessions')
    expect(issues[0]).not.toHaveProperty('sessionSummary')
    expect(issues[0]).not.toHaveProperty('unread')
  })
})

describe('normalized dep emission [POD-797]', () => {
  it('one dep write emits one edge and performs zero membership scans', {
    timeout: SCALE_GUARD_TIMEOUT_MS,
  }, () => {
    const { registry } = world()
    registry.modules.sessions.flushBroadcasts()
    const before = registry.modules.sessions.syncChangesSince(0)
    const beforeCount =
      before.kind === 'delta'
        ? before.changes.filter((change) => change.entity === 'issueDep').length
        : 0
    resetIssueWireBuildCount()
    registry.modules.issues.addDep('iss_1', 'iss_2')
    registry.modules.sessions.flushBroadcasts()
    expect(issueMembershipScanCount()).toBe(0)
    const after = registry.modules.sessions.syncChangesSince(0)
    const edges =
      after.kind === 'delta' ? after.changes.filter((change) => change.entity === 'issueDep') : []
    expect(edges.length - beforeCount).toBe(1)
    expect(edges.at(-1)?.id).toBe('iss_1|iss_2|blocks')
  })
})
