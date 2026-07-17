import type { ServerMessage } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  issueMembershipScanCount,
  issueWireBuildCount,
  resetIssueWireBuildCount,
} from './modules/issues/instrumentation'
import { SessionRegistry } from './relay'
import type { IssueRow } from './store'
import { SessionStore } from './store'

/**
 * The normalized issue wire, end to end through the PRODUCTION wiring
 * [POD-796] — flag-gated emission of the `issueProjection` kind, and THE D7.2
 * bypass that severs the issue↔session coupling.
 *
 * Everything here runs over `new SessionRegistry(store)`: the real relay
 * composition, the real Ledger over a real (in-memory) SessionStore, real
 * clients over real `hello`/`attach` frames. No browser, and no stubs on the
 * path under test — the D7.2 claim is a claim about how these parts are WIRED
 * TOGETHER, so a harness that faked any of them could not witness it.
 */

const ISSUE_COUNT = 300
const SESSION_COUNT = 200

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

/** A session row that hydrates into a live `Session` object at boot WITHOUT a
 *  PTY — `loadFromStore` rebuilds hibernated rows, so `listSessions()` reaches a
 *  realistic scale for the price of an INSERT. */
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

/**
 * Seed the world, then flip the flag, THEN construct — in that order.
 *
 * The relay resolves `issues-normalized-wire` lazily and caches it, dropping the
 * cache on the `settings.changed` bus event. A test writing the settings row
 * directly does not emit that event, so the flag must be in the store before the
 * first resolve (the boot reconcile inside the constructor). Writing it after
 * would silently measure the OTHER flag state — which would make the D7.2 test
 * pass for the wrong reason.
 */
function world(opts: { flag: boolean; issues?: number; sessions?: number }) {
  const store = new SessionStore(':memory:')
  for (let i = 0; i < (opts.issues ?? ISSUE_COUNT); i++) store.issues.upsertIssue(issueRow(i))
  const sessionIds: string[] = []
  for (let i = 0; i < (opts.sessions ?? SESSION_COUNT); i++) sessionIds.push(seedSession(store, i))
  store.settings.setSettings({
    ...normalizeSettings(undefined),
    experimental: { 'issues-normalized-wire': opts.flag },
  })
  const registry = new SessionRegistry(store)
  registries.push(registry)
  return { store, registry, sessionIds }
}

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

/** A client that offers the caps the normalized path requires. */
function capClient(registry: SessionRegistry): string {
  return client(registry, ['metadataDelta', 'issuesNormalized'])
}

function client(registry: SessionRegistry, caps: string[] | undefined): string {
  const id = registry.modules.sessions.attachClient(() => {})
  registry.modules.sessions.onClientMessage(id, {
    type: 'hello',
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
 * this change reads **1 build but 300 scans**: POD-723's memo reuses 299 cached
 * payloads, but it still calls `sessionsForIssue()` for every issue to compute
 * the cache key, and each of those filters all ${SESSION_COUNT} sessions. So the
 * O(issues × sessions) work D7.2 forbids is entirely intact — 60 000 session
 * comparisons — and a build-counting assertion would have read "1 vs 0" and
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
  registry.modules.sessions.setWorkState({ sessionId, workState: 'testing' })
  registry.modules.sessions.flushBroadcasts()
  return { builds: issueWireBuildCount(), scans: issueMembershipScanCount() }
}

describe('issueProjection emission is flag-gated and ADDITIVE [POD-796]', () => {
  const changesOf = (registry: SessionRegistry, entity: string) => {
    const boot = registry.modules.sessions.syncChangesSince(null)
    // A null cursor bootstraps to a snapshot; take a cursor from 0 to read the
    // whole durable change log instead.
    const all = registry.modules.sessions.syncChangesSince(0)
    return all.kind === 'delta'
      ? all.changes.filter((c) => c.entity === entity)
      : (boot.kind === 'delta' ? boot.changes : []).filter((c) => c.entity === entity)
  }

  it('flag OFF: NO issueProjection rows are ever appended (legacy behaviour intact)', () => {
    const { registry } = world({ flag: false, issues: 3, sessions: 2 })
    registry.modules.issues.update('iss_1', { title: 'edited' })
    registry.modules.sessions.flushBroadcasts()
    expect(changesOf(registry, 'issueProjection')).toEqual([])
    // ...and the legacy kind is untouched.
    expect(changesOf(registry, 'issue').length).toBeGreaterThan(0)
  })

  it('flag ON: issueProjection rows are appended AND issue rows still are', () => {
    const { registry } = world({ flag: true, issues: 3, sessions: 2 })
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

  it('flag ON appends issueDep and repo rows; flag OFF is a rollback that REMOVES them [POD-822]', () => {
    // The flag is the cutover's rollback switch, and this pins that it actually
    // rolls back. `allDepProjections`/`allRepoProjections` return EMPTY (not
    // undefined) with the flag off, so the boot reconcile against a baseline that
    // HAD rows diffs every one as a REMOVE. If they returned undefined instead,
    // the rows would sit frozen in the ledger and in every client's replica, and
    // flipping the flag off would NOT restore the legacy path.
    const { store } = world({ flag: true, issues: 2, sessions: 0 })
    // Give iss_0 a dep and a prefix so there is something to roll back.
    store.issues.addIssueDep('iss_0', 'iss_1', 'blocks')

    const onReg = new SessionRegistry(store)
    registries.push(onReg)
    onReg.modules.issues.addDep('iss_0', 'iss_1') // no-op re-add, forces a publish
    onReg.modules.sessions.flushBroadcasts()
    const onDeps = onReg.modules.sessions.syncChangesSince(0)
    const depsWhileOn =
      onDeps.kind === 'delta'
        ? onDeps.changes.filter((c) => c.entity === 'issueDep' && c.op === 'upsert')
        : []
    expect(depsWhileOn.length).toBeGreaterThan(0)

    // Flip the flag OFF and reboot the service against the SAME store (baseline
    // carries the edge/repo rows from the on-run).
    store.settings.setSettings({
      ...normalizeSettings(undefined),
      experimental: { 'issues-normalized-wire': false },
    })
    const offReg = new SessionRegistry(store)
    registries.push(offReg)
    offReg.modules.sessions.flushBroadcasts()
    // The boot reconcile diffed the now-empty normalized truth against the
    // baseline and appended REMOVEs. Read the whole log: the last op for the
    // edge id must be a remove.
    const all = offReg.modules.sessions.syncChangesSince(0)
    const edgeOps =
      all.kind === 'delta'
        ? all.changes.filter((c) => c.entity === 'issueDep' && c.id === 'iss_0|iss_1|blocks')
        : []
    expect(edgeOps.at(-1)?.op, 'flag OFF must roll the edge back to a REMOVE').toBe('remove')
  })

  it('flag ON: the write-less publish tail heals a projection changed behind the service’s back', () => {
    // Pins the relay's `publishIssueList` projection reconcile — the write-less
    // full-list tail (relay.ts), which no other test here reaches. It is hard to
    // observe by construction, and that is worth stating: on the new path a
    // session change BYPASSES this tail, and when a legacy client keeps the tail
    // alive the projections are unchanged (a session change cannot dirty one),
    // so the reconcile correctly dedups to nothing and appends nothing.
    //
    // What the tail is actually FOR is the case below: a local row that changed
    // with no persist() to declare it — an offline/behind-the-back edit, exactly
    // what the 'issue' reconcile beside it has always covered. Without the
    // reconcile, that heal never reaches the normalized feed.
    const { store, registry, sessionIds } = world({ flag: true, issues: 3, sessions: 2 })
    // A legacy delta client keeps the write-less publish path alive.
    client(registry, ['metadataDelta'])
    const attacher = client(registry, ['metadataDelta'])
    registry.modules.sessions.flushBroadcasts()

    // Mutate the row behind the service's back and re-hydrate: no persist(), so
    // no commit-declared change — only a reconcile against full truth can see it.
    const row = store.issues.getIssue('iss_1')
    if (!row) throw new Error('seeded row missing')
    store.issues.upsertIssue({ ...row, title: 'healed behind the back' })
    registry.modules.issues.reload()

    // Any write-less full-list publish now reconciles BOTH kinds against truth.
    registry.modules.sessions.onClientMessage(attacher, {
      type: 'attach',
      sessionId: sessionIds[0] as string,
    })
    registry.modules.sessions.flushBroadcasts()

    const healed = changesOf(registry, 'issueProjection')
      .filter((c) => c.id === 'iss_1')
      .at(-1)
    const value = healed?.op === 'upsert' ? (healed.value as Record<string, unknown>) : undefined
    expect(value?.title).toBe('healed behind the back')
  })
})

describe('THE D7.2 bypass: a session change performs no issue-wire work [POD-796]', () => {
  it('flag ON + only cap clients: a one-field session change touches ZERO issues', () => {
    const { registry, sessionIds } = world({ flag: true })
    capClient(registry)
    capClient(registry)
    const { scans } = issueWorkForOneFieldSessionChange(registry, sessionIds[0] as string)
    expect(
      scans,
      `D7.2 VIOLATED: a one-field session change (workState) touched ${scans} issue(s) with ` +
        `the normalized flag ON and only cap-clients connected — it must touch 0. Each touch ` +
        `filters all ${SESSION_COUNT} sessions, so ${ISSUE_COUNT} issues × ${SESSION_COUNT} ` +
        `sessions is the O(entities) work ADR 4 D7.2 forbids on the publish path. Note this ` +
        `asserts on SCANS, not builds: POD-723's memo makes builds read 1 here while the ` +
        `world-scan survives untouched, which is why the ADR calls the shims scar tissue ` +
        `rather than compliance.`,
    ).toBe(0)
  })

  it('flag OFF: the SAME change still scans every issue (the coupling, measured)', () => {
    const { registry, sessionIds } = world({ flag: false })
    capClient(registry)
    capClient(registry)
    const { scans } = issueWorkForOneFieldSessionChange(registry, sessionIds[0] as string)
    // The control. If this ever reads 0 the bypass test above proves NOTHING —
    // it would mean the trigger never reached publishIssues (e.g. the byte-skip
    // ate it) and both cases would pass vacuously.
    expect(
      scans,
      `the flag-OFF control touched ${scans} issues; it must touch ${ISSUE_COUNT} (one per ` +
        `issue, each filtering all ${SESSION_COUNT} sessions). A 0 here means the one-field ` +
        `session change never reached publishIssues at all, which would make the flag-ON ` +
        `bypass test vacuous — that is exactly what happened when this test triggered on ` +
        `clientCount, which POD-722 denylists upstream.`,
    ).toBe(ISSUE_COUNT)
  })

  it('flag ON but a LEGACY DELTA client is connected: the rebuild stays on', () => {
    // A delta client without CAP_ISSUES_NORMALIZED reads the embedded
    // SessionMeta[] off the 'issue' kind. Skipping the rebuild would starve it
    // silently — no event ever heals a delta client that was never told.
    const { registry, sessionIds } = world({ flag: true })
    capClient(registry)
    client(registry, ['metadataDelta'])
    const { scans } = issueWorkForOneFieldSessionChange(registry, sessionIds[0] as string)
    expect(
      scans,
      `a legacy delta client was connected, so the session-derived IssueWire must still be ` +
        `maintained (${ISSUE_COUNT} issue touches expected); got ${scans}. Skipping starves it.`,
    ).toBe(ISSUE_COUNT)
  })

  it('flag ON but a SNAPSHOT client is connected: the rebuild stays on', () => {
    // No caps at all ⇒ it is served the legacy `issuesChanged` snapshot by
    // fanOutSnapshot, which only publishIssues() produces.
    const { registry, sessionIds } = world({ flag: true })
    capClient(registry)
    client(registry, undefined)
    const { scans } = issueWorkForOneFieldSessionChange(registry, sessionIds[0] as string)
    expect(scans, `a legacy snapshot client needs the rebuild; got ${scans} touches`).toBe(
      ISSUE_COUNT,
    )
  })

  it('flag ON but a PRE-HELLO client is connected: the rebuild stays on (fail-safe)', () => {
    // The subtle one. `caps` is empty until hello arrives, so a client that has
    // connected but not yet negotiated must count as legacy — the fail-safe
    // direction. Getting this wrong is invisible: the client would simply never
    // see issue updates it was entitled to.
    const { registry, sessionIds } = world({ flag: true })
    capClient(registry)
    registry.modules.sessions.attachClient(() => {}) // attached, no hello yet
    const { scans } = issueWorkForOneFieldSessionChange(registry, sessionIds[0] as string)
    expect(
      scans,
      `a PRE-HELLO client has no caps yet and must count as legacy; got ${scans} touches`,
    ).toBe(ISSUE_COUNT)
  })

  it('a client claiming issuesNormalized WITHOUT metadataDelta still needs the rebuild', () => {
    // The cap pair is a conjunction, not redundancy: the normalized projection
    // has NO snapshot transport — it exists only as a metadataDelta row. Such a
    // client is served the legacy snapshot by fanOutSnapshot, so it needs the
    // rebuild despite claiming to understand the new shape.
    const { registry, sessionIds } = world({ flag: true })
    client(registry, ['issuesNormalized'])
    const { scans } = issueWorkForOneFieldSessionChange(registry, sessionIds[0] as string)
    expect(
      scans,
      `issuesNormalized WITHOUT metadataDelta means the client is on the SNAPSHOT feed, which ` +
        `carries no IssueProjection — it needs the legacy rebuild. Got ${scans} touches.`,
    ).toBe(ISSUE_COUNT)
  })
})

describe('a legacy client is never starved by a bypass window [POD-796]', () => {
  /**
   * Reviewing the rebase composition, which chose NOT to stamp
   * `lastIssueSessionProjection` on the bypass arm, reasoning that a legacy
   * client attaching later must be forced to re-publish rather than inherit a
   * silent skip.
   *
   * THE CHOICE IS RIGHT, BUT NOT FOR THAT REASON, and I could not build a test
   * that discriminates it — I tried, and the mutation (make the bypass stamp)
   * left my first attempt GREEN, so I deleted it rather than keep a test that
   * asserts a guard it cannot see. What actually rescues that client is one line
   * up the stack: `attachClient` sends a FRESHLY BUILT `issuesChanged`
   * (`this.deps.issuesWire()`, service.ts:2428) to every client at attach, BEFORE
   * hello and therefore before caps exist. So no client can observe a stale issue
   * wire inherited from a bypass window, stamped or not.
   *
   * Not stamping remains correct and worth keeping: it preserves what the
   * variable's NAME claims — the projection as of the last actual PUBLISH — and a
   * stamp that records a publish which never happened is a lie waiting for the
   * next reader. But it is defence in depth, not the load-bearing guard, and this
   * test pins the guard that IS load-bearing: delete the attach paint and a client
   * arriving after a bypass window renders stale member data.
   */
  it('a client attaching after a bypass window is painted fresh issue data', () => {
    const { registry, sessionIds } = world({ flag: true, issues: 3, sessions: 2 })
    capClient(registry)
    const sessionId = sessionIds[0] as string

    // A bypass window: the session world moves while only cap-clients watch, so
    // nothing rebuilds the legacy IssueWire and its embedded SessionMeta[] goes
    // stale by design.
    registry.modules.sessions.setWorkState({ sessionId, workState: 'testing' })
    registry.modules.sessions.flushBroadcasts()

    // A legacy client now arrives and must NOT see the pre-bypass world.
    const inbox: ServerMessage[] = []
    const id = registry.modules.sessions.attachClient((m) => inbox.push(m))
    registry.modules.sessions.onClientMessage(id, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
    registry.modules.sessions.flushBroadcasts()

    const painted = inbox.filter((m) => m.type === 'issuesChanged').at(-1)
    expect(painted, 'a newly attached client must be painted an issue list at all').toBeDefined()
    const member = (
      painted as { issues: { id: string; sessions: { workState?: string }[] }[] }
    ).issues
      .find((i) => i.id === 'iss_0')
      ?.sessions.find((x) => (x as { sessionId?: string }).sessionId === sessionId)
    expect(
      member?.workState,
      `the issue wire painted at attach carried workState=${member?.workState} — the value from ` +
        `BEFORE the bypass window. A client arriving after a bypass would render a stale ` +
        `session world with no event to heal it.`,
    ).toBe('testing')
  })
})

describe('THE D7.2 bypass for dep edges: a dep change is O(1), not O(issues) [POD-822]', () => {
  // The dep-edge twin of the session-broadcast bypass above. On the LEGACY wire,
  // `deps`/`blocked`/`dependents` are FIELDS of the issue, so a dep add between
  // A and B changed B's payload with no write on B — and only a full-list rebuild
  // (O(issues), each scanning its member sessions) found it. A replica that reads
  // the 'issueDep' kind derives all four itself from the edge row, so the edge IS
  // the ripple: O(1). This measures that the rebuild is skipped exactly when no
  // legacy client needs it, using the same production-wired scan counter.
  const depWork = (registry: SessionRegistry, from: string, to: string): number => {
    registry.modules.sessions.flushBroadcasts()
    resetIssueWireBuildCount()
    registry.modules.issues.addDep(from, to)
    registry.modules.sessions.flushBroadcasts()
    return issueMembershipScanCount()
  }

  const depChangesAppended = (registry: SessionRegistry) => {
    const all = registry.modules.sessions.syncChangesSince(0)
    return all.kind === 'delta' ? all.changes.filter((c) => c.entity === 'issueDep') : []
  }

  it('flag ON + only cap clients: a dep add scans O(1) issues, not all 300', () => {
    // 300 issues seeded; add ONE edge. The membership-scan count must not scale
    // with the issue count — the whole point of the edge being its own entity.
    const { registry } = world({ flag: true })
    capClient(registry)
    capClient(registry)
    const scans = depWork(registry, 'iss_1', 'iss_2')
    // O(1): the ONLY issue touched is the fromId's own persist (the additive
    // legacy 'issue' change still builds one wire — POD-797 removes even that
    // when it deletes the legacy kind). Emphatically NOT the O(issues) rebuild.
    expect(
      scans,
      `D7.2 VIOLATED: a single dep add touched ${scans} issues (${ISSUE_COUNT} seeded). The ` +
        `edge is its own entity; a replica derives blocked/ready/dependents from it, so the ` +
        `legacy full-list rebuild must be skipped when no client needs the embedded wire.`,
    ).toBeLessThan(ISSUE_COUNT)
    expect(scans).toBeLessThanOrEqual(1)
  })

  it('flag ON + only cap clients: the dep add appends exactly ONE issueDep row (O(1))', () => {
    const { registry } = world({ flag: true })
    capClient(registry)
    registry.modules.sessions.flushBroadcasts()
    const before = depChangesAppended(registry).length
    registry.modules.issues.addDep('iss_1', 'iss_2')
    registry.modules.sessions.flushBroadcasts()
    const appended = depChangesAppended(registry)
    // One edge in → one edge row out, carrying the composed key and both
    // endpoints. Not a full re-emit of the edge set.
    expect(appended.length - before).toBe(1)
    const edge = appended.at(-1)
    const value = edge?.op === 'upsert' ? (edge.value as Record<string, unknown>) : undefined
    expect(value).toMatchObject({ fromId: 'iss_1', toId: 'iss_2', type: 'blocks' })
    expect(edge?.id).toBe('iss_1|iss_2|blocks')
  })

  it('flag OFF: the SAME dep add still rebuilds every issue (the coupling, measured)', () => {
    // The control that keeps the test honest, mirroring the session-bypass
    // control: with the flag off there is no edge kind for a replica to read, so
    // the legacy rebuild MUST still run and touch every issue.
    const { registry } = world({ flag: false })
    client(registry, ['metadataDelta'])
    const scans = depWork(registry, 'iss_1', 'iss_2')
    expect(
      scans,
      `the flag-OFF control touched ${scans} issues; it must touch at least ${ISSUE_COUNT} — ` +
        `without the edge entity the legacy blocked/dependents derivation has nowhere else to live.`,
    ).toBeGreaterThanOrEqual(ISSUE_COUNT)
  })

  it('flag ON but a LEGACY DELTA client is connected: the rebuild stays on', () => {
    // Fail-safe, exactly as the session bypass: a client that still reads the
    // embedded wire keeps the rebuild alive, or its blocked/dependents freeze.
    const { registry } = world({ flag: true })
    capClient(registry)
    client(registry, ['metadataDelta']) // no issuesNormalized
    const scans = depWork(registry, 'iss_1', 'iss_2')
    expect(
      scans,
      `a legacy delta client needs the rebuild after a dep add; got ${scans} touches`,
    ).toBeGreaterThanOrEqual(ISSUE_COUNT)
  })
})
