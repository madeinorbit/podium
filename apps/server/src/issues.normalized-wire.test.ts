import { normalizeSettings } from '@podium/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { issueWireBuildCount, resetIssueWireBuildCount } from './modules/issues/instrumentation'
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
 * THE measurement: issue-wire builds performed by ONE one-field session change.
 *
 * The change is `attacherId` attaching to a session — `clientCount` 0→1, the
 * cheapest real session mutation there is, and the one a chat switch performs
 * (POD-701: p50 711ms ×2 per switch at 530-session scale).
 *
 * `attacherId` must be an ALREADY-CONNECTED client, and the window is opened
 * only after it has said hello. Two reasons, both learned by getting it wrong:
 * `attachClient` paints a bootstrap `issuesChanged` built fresh (a legitimate
 * O(issues) build, but not the one under test), and a client that has not yet
 * negotiated caps counts as legacy — so creating the attacher inside the window
 * measured the bootstrap AND suppressed the very bypass under test.
 */
function buildsForOneFieldSessionChange(
  registry: SessionRegistry,
  sessionId: string,
  attacherId: string,
): number {
  registry.modules.sessions.flushBroadcasts()
  resetIssueWireBuildCount()
  registry.modules.sessions.onClientMessage(attacherId, { type: 'attach', sessionId })
  registry.modules.sessions.flushBroadcasts()
  return issueWireBuildCount()
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
  it('flag ON + only cap clients: a one-field session change performs ZERO issue-wire builds', () => {
    const { registry, sessionIds } = world({ flag: true })
    const attacher = capClient(registry)
    capClient(registry)
    const builds = buildsForOneFieldSessionChange(registry, sessionIds[0] as string, attacher)
    expect(
      builds,
      `D7.2 VIOLATED: a one-field session change (clientCount 0→1) performed ${builds} ` +
        `issue-wire build(s) with the normalized flag ON and only cap-clients connected — ` +
        `it must perform 0. ${ISSUE_COUNT} issues × ${SESSION_COUNT} sessions were seeded, so ` +
        `each build embeds the session world (ADR 4 D7.1) and this is the O(issues × sessions) ` +
        `coupling POD-796 exists to sever.`,
    ).toBe(0)
  })

  it('flag OFF: the SAME change still builds every issue (the coupling, measured)', () => {
    const { registry, sessionIds } = world({ flag: false })
    const attacher = capClient(registry)
    capClient(registry)
    const builds = buildsForOneFieldSessionChange(registry, sessionIds[0] as string, attacher)
    // The control. If this ever reads 0 the bypass test above proves NOTHING —
    // it would mean the trigger never reached publishIssues (e.g. the byte-skip
    // ate it) and both cases would pass vacuously.
    expect(
      builds,
      `the flag-OFF control performed ${builds} issue-wire builds; it must perform ` +
        `${ISSUE_COUNT} (one per issue). A 0 here means the one-field session change never ` +
        `reached publishIssues at all, which would make the flag-ON bypass test vacuous.`,
    ).toBe(ISSUE_COUNT)
  })

  it('flag ON but a LEGACY DELTA client is connected: the rebuild stays on', () => {
    // A delta client without CAP_ISSUES_NORMALIZED reads the embedded
    // SessionMeta[] off the 'issue' kind. Skipping the rebuild would starve it
    // silently — no event ever heals a delta client that was never told.
    const { registry, sessionIds } = world({ flag: true })
    const attacher = capClient(registry)
    client(registry, ['metadataDelta'])
    const builds = buildsForOneFieldSessionChange(registry, sessionIds[0] as string, attacher)
    expect(
      builds,
      `a legacy delta client was connected, so the session-derived IssueWire must still be ` +
        `rebuilt (${ISSUE_COUNT} expected); got ${builds}. Skipping it starves that client.`,
    ).toBe(ISSUE_COUNT)
  })

  it('flag ON but a SNAPSHOT client is connected: the rebuild stays on', () => {
    // No caps at all ⇒ it is served the legacy `issuesChanged` snapshot by
    // fanOutSnapshot, which only publishIssues() produces.
    const { registry, sessionIds } = world({ flag: true })
    const attacher = capClient(registry)
    client(registry, undefined)
    const builds = buildsForOneFieldSessionChange(registry, sessionIds[0] as string, attacher)
    expect(builds, `a legacy snapshot client needs the rebuild; got ${builds}`).toBe(ISSUE_COUNT)
  })

  it('flag ON but a PRE-HELLO client is connected: the rebuild stays on (fail-safe)', () => {
    // The subtle one. `caps` is empty until hello arrives, so a client that has
    // connected but not yet negotiated must count as legacy — the fail-safe
    // direction. Getting this wrong is invisible: the client would simply never
    // see issue updates it was entitled to.
    const { registry, sessionIds } = world({ flag: true })
    const attacher = capClient(registry)
    registry.modules.sessions.attachClient(() => {}) // attached, no hello yet
    const builds = buildsForOneFieldSessionChange(registry, sessionIds[0] as string, attacher)
    expect(
      builds,
      `a PRE-HELLO client has no caps yet and must count as legacy; got ${builds} builds`,
    ).toBe(ISSUE_COUNT)
  })

  it('a client claiming issuesNormalized WITHOUT metadataDelta still needs the rebuild', () => {
    // The cap pair is a conjunction, not redundancy: the normalized projection
    // has NO snapshot transport — it exists only as a metadataDelta row. Such a
    // client is served the legacy snapshot by fanOutSnapshot, so it needs the
    // rebuild despite claiming to understand the new shape.
    const { registry, sessionIds } = world({ flag: true })
    const attacher = client(registry, ['issuesNormalized'])
    const builds = buildsForOneFieldSessionChange(registry, sessionIds[0] as string, attacher)
    expect(
      builds,
      `issuesNormalized WITHOUT metadataDelta means the client is on the SNAPSHOT feed, which ` +
        `carries no IssueProjection — it needs the legacy rebuild. Got ${builds}.`,
    ).toBe(ISSUE_COUNT)
  })
})
