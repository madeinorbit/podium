import { asIssueId, asMachineId, asSessionId, asUserId, NO_SESSION_USER_STATE, type SessionMeta } from '@podium/model'
import { formatSessionRef } from '@podium/protocol'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Resolve profiling before importing the store/driver instrumentation.
const previousProfile = vi.hoisted(() => {
  const previous = process.env.PODIUM_LOOP_PROFILE
  process.env.PODIUM_LOOP_PROFILE = 'attribution'
  return previous
})
afterAll(() => {
  if (previousProfile === undefined) delete process.env.PODIUM_LOOP_PROFILE
  else process.env.PODIUM_LOOP_PROFILE = previousProfile
})
import { queryAttributionSnapshot, resetQueryAttribution } from '@podium/runtime/sqlite'
import { systemPrincipal } from '../../command-principal'
import { sessionStatePrincipalFor } from './session-state/registry'
import { harnessCapabilitiesFor } from '../../harness-manifest'
import { openTestStore } from '../../test-support/open-test-store'
import { Session } from './session'
import { SessionAuthz } from './session-authz'
import { SessionRepository } from './repository'
import { internalSessionRead, SessionStateService, type SessionStatePrincipal } from './session-state/service'
import { SessionView } from './view'

const reader = asUserId('projection-reader')
const principal: SessionStatePrincipal = { userId: reader, humanDirect: true, onBehalfOf: reader,
  capability: { role: 'worker', scope: { kind: 'none' } } }
const machineId = asMachineId('projection-machine')

async function fixture(count: number) {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/projection', machineId, undefined, 'PASS')
  await store.issues.upsertIssue({
    id: asIssueId('projection-issue'),
    ownerUserId: reader,
    visibility: 'personal',
    createdByActor: reader,
    createdByOnBehalfOf: reader,
    repoPath: '/projection',
    seq: 1,
    title: 'X',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'dev/mw',
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
    createdAt: 't',
    updatedAt: 't',
    archived: false,
    priority: 2,
    type: 'task',
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
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
  })
  const rows = Array.from({ length: count }, (_, i) => {
    const session = new Session({
      sessionId: asSessionId(`projection-${i}`), durableLabel: `projection-${i}`,
      agentKind: 'claude-code', cwd: `/projection/work-${i}`, title: `Session ${i}`,
      origin: { kind: 'spawn' }, createdAt: '2026-09-10T00:00:00.000Z',
      geometry: { cols: 80, rows: 24 }, machineId, toDaemon: () => {},
      ownerUserId: [1, 3, 4].includes(i % 5) ? asUserId('other') : reader,
    })
    // Unique absent issues exercise negative caching as the corpus grows.
    if (i % 5 === 0) session.issueId = asIssueId(`missing-${i}`)
    if (i % 5 === 1) { session.refIssueId = asIssueId(`missing-ref-${i}`); session.refLetter = 'a' }
    if (i % 5 === 2) session.refDraft = i + 1
    if (i % 5 === 3) { session.issueId = asIssueId('projection-issue'); session.refIssueId = session.issueId; session.refLetter = 'b' }
    return session
  })
  for (const [index, row] of rows.entries()) {
    if (index % 5 === 1) await store.grants.upsert({
      resourceKind: 'session', resourceId: row.sessionId, grantee: reader, verb: 'read',
      owner: 'other', visibility: 'private', createdAt: '2026-09-10T00:00:00.000Z',
      actorKind: 'user', actorId: 'other', onBehalfOf: null,
    })
    await store.sync.enqueueMessage({ id: `queue-${row.sessionId}`, sessionId: row.sessionId, text: 'queued', queuedAt: 1 })
  }
  await store.sessions.markSessionRead(reader, rows[0]!.sessionId, '2026-09-11T00:00:00.000Z')
  // ON A ROW THE READER OWNS (row 2), not row 1. Row 1 is the grantee case, and
  // since B1 (PDM-133) a grant confers nothing, so a snooze parked there would
  // never reach the reader's projection — and the
  // `expected.some(s => s.snoozedUntil === null)` guard below, which exists to
  // stop this suite comparing two empty-ish arrays, would silently go false.
  // Moved rather than deleted: the guard is the non-vacuity check.
  await store.sessions.setSnooze(reader, rows[2]!.sessionId, null)
  const sessions = new Map(rows.map(s => [s.sessionId, s]))
  const authz = new SessionAuthz({ sessions, store } as never)
  const state = new SessionStateService({ store, getSession: (id: string) => sessions.get(asSessionId(id)),
    sessionOwner: ({ sessionId, memo }: Parameters<ConstructorParameters<typeof SessionStateService>[0]['sessionOwner']>[0]) => authz.sessionOwner(sessionId, memo),
    primeOwnerMemo: (memo: Parameters<SessionAuthz['primeOwnerMemo']>[0], ids: Parameters<SessionAuthz['primeOwnerMemo']>[1]) => authz.primeOwnerMemo(memo, ids),
  } as never)
  const machines = { factsSnapshot: vi.fn(async () => ({ name: () => 'Build box', loginCondition: () => 'logged-out' as const })),
    machineName: async () => 'Build box', agentLoginCondition: async () => 'logged-out' as const }
  const view = new SessionView({ sessions, store, state, machines: machines as never, sessionOccupancyCount: () => 3 })
  // Broadcast still resolves its principal-less overlay user exactly once — the
  // budget assertion below counts the calls, so the seam has to be a spy.
  // `openTestStore` primes a first admin, so the real `internalOverlayUser()`
  // would answer THAT member and every overlay in a principal-less pass would be
  // empty. Pinning the READER is what makes the broadcast slice wire the same
  // overlay rows the reader-scoped `list()` cases above wire, which is what the
  // two files' budgets are written to compare.
  vi.spyOn(view, 'internalOverlayUser').mockResolvedValue(reader)
  return { store, rows, sessions, authz, state, machines, view }
}

/** Frozen pre-pass wire algorithm: the oracle deliberately performs row reads. */
async function legacyWire(s: Session, f: Awaited<ReturnType<typeof fixture>>): Promise<SessionMeta> {
  const overlay = await f.state.overlay(reader, s.sessionId)
  const meta = s.toMeta(overlay ?? NO_SESSION_USER_STATE)
  const queuedMessageCount = (await f.store.sync.queuedMessageCounts(s.sessionId)).get(s.sessionId) ?? 0
  const loginCondition = await f.machines.agentLoginCondition()
  const capabilities = harnessCapabilitiesFor(s.agentKind)
  let displayRef: string | undefined
  if (s.refIssueId && s.refLetter) {
    const issue = await f.store.issues.getIssue(s.refIssueId)
    if (issue) {
      const prefix = await f.store.repos.prefixForPath(issue.repoPath)
      if (prefix) displayRef = formatSessionRef({ prefix, seq: issue.seq, letter: s.refLetter })
    }
  } else if (s.refDraft != null) {
    const prefix = await f.store.repos.prefixForPath(s.cwd)
    if (prefix) displayRef = formatSessionRef({ prefix, draft: s.refDraft })
  }
  return { ...meta, ...(queuedMessageCount > 0 ? { queuedMessageCount } : {}), clientCount: 3,
    machineName: await f.machines.machineName(), ...(loginCondition ? { condition: loginCondition } : {}),
    ...(capabilities ? { harnessHandoff: capabilities.handoff, harnessPromptModeHints: capabilities.promptModeHints } : {}),
    ...(s.refIssueId ? { refIssueId: s.refIssueId } : {}), ...(s.refLetter ? { refLetter: s.refLetter } : {}),
    ...(s.refDraft != null ? { refDraft: s.refDraft } : {}), ...(displayRef ? { displayRef } : {}),
  }
}

function statementCount() {
  return [...queryAttributionSnapshot().values()].reduce((sum, cost) => sum + cost.count, 0)
}

describe('one projection pass', () => {
  it('characterizes visibility without revalidating an already-admitted principal', async () => {
    const f = await fixture(5)
    try {
      // The five rows cover missing issue fallback, direct grantee, no-issue
      // owner, issue owner (different from session owner), and unrelated reader.
      //
      // TWO OF THEM FLIPPED IN B1 (PDM-133), and they are the two the change is
      // about. Row 1 was readable because the reader held a GRANT EDGE on it;
      // grants are inactive history now. Row 3 was readable because the reader
      // owns the ATTACHED ISSUE while 'other' owns the session; the issue no
      // longer decides. Rows 0 and 2 are the reader's OWN sessions and are
      // unaffected, which is what keeps this vector discriminating rather than
      // uniformly false.
      // Account status and actor kind are admission concerns: this API consumes
      // an admitted principal and historically consults neither user rows nor roles.
      await f.store.users.create({ id: reader, displayName: 'Reader', role: 'member',
        createdAt: '2026-09-10T00:00:00.000Z', disabledAt: null }, 'test-only')
      expect(await f.store.users.get(reader)).toBeDefined()
      expect(await Promise.all(f.rows.map(s => f.state.canReadSession(principal, s.sessionId))))
        .toEqual([true, false, true, false, false])
      // Test-only revocation: no user lifecycle write API exists yet.
      // @ts-expect-error test-only access to the private database connection
      await f.store.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
        .run('2026-09-11T00:00:00.000Z', reader)
      // A previously admitted principal keeps this method's historical outcome.
      // The transport admission layer, not this visibility method, rejects it.
      expect(await Promise.all(f.rows.map(s => f.state.canReadSession(principal, s.sessionId))))
        .toEqual([true, false, true, false, false])
      expect(() => sessionStatePrincipalFor(systemPrincipal('characterization')))
        .toThrow('system principal has no per-user session state')
      const member = { ...principal, userId: asUserId('unrelated'),
        capability: { role: 'worker', scope: { kind: 'subtree', rootId: asIssueId('projection-issue') } },
      } as SessionStatePrincipal
      expect(await Promise.all(f.rows.map(s => f.state.canReadSession(member, s.sessionId))))
        .toEqual([false, false, false, false, false])
      // [false x5], MATCHING THE `member` VECTOR ABOVE — an admin capability
      // buys nothing here [PDM-291]. This vector was [true x5] until PDM-291,
      // left that way ON PURPOSE by PDM-270 so this issue had a red to turn
      // green rather than a case to reconstruct. PDM-270 removed the matching
      // admin short circuit from mayWatch/mayDrive and could NOT remove this
      // one, because `scope.kind === 'all'` was ALSO what made every
      // principal-less internal read work: view.defaultPrincipal() borrowed the
      // earliest admin, whom userCommandPrincipal mints with scope `all`. The
      // two callers now have two answers — the internal read below, and this.
      const operator = { ...principal, userId: asUserId('unrelated'),
        capability: { role: 'admin', scope: { kind: 'all' } },
      } as SessionStatePrincipal
      expect(await Promise.all(f.rows.map(s => f.state.canReadSession(operator, s.sessionId))))
        .toEqual([false, false, false, false, false])
      expect(await f.state.canReadSession(operator, asSessionId('absent'))).toBe(false)
      // AND THE OTHER CALLER, admitted for a reason that is not a capability:
      // the server reading its own surface. Without this the removal above
      // would be indistinguishable from simply breaking internal reads, and the
      // five oracle/command-plane tests that go through a principal-less
      // `sessionById` are the ones that would have said so.
      const internal = internalSessionRead('characterization')
      expect(await Promise.all(f.rows.map(s => f.state.canReadSession(internal, s.sessionId))))
        .toEqual([true, true, true, true, true])
      // Absence is still absence for an internal read: it is not an existence
      // oracle for the server either.
      expect(await f.state.canReadSession(internal, asSessionId('absent'))).toBe(false)
      // `visibleSessions` is a SECOND COPY of the rule, not a caller of it, so
      // both vectors are asserted against it too or half the change is unpinned.
      expect(await f.state.visibleSessions(operator, f.rows.map(s => s.sessionId)))
        .toEqual(new Set())
      expect(await f.state.visibleSessions(internal, f.rows.map(s => s.sessionId)))
        .toEqual(new Set(f.rows.map(s => s.sessionId)))
    } finally { await f.store.close() }
  })

  it('preserves the old reader-scoped SessionMeta array deeply', async () => {
    const f = await fixture(10)
    try {
      const expected = []
      for (const s of f.rows) if (await f.state.canReadSession(principal, s.sessionId)) expected.push(await legacyWire(s, f))
      expect(await f.view.list(principal, 'rpc')).toEqual(expected)
      // Four of ten: the reader owns rows where i % 5 is 0 or 2. It was eight
      // before B1 (PDM-133), when a grant edge and the attached issue each
      // carried one more row in.
      expect(expected).toHaveLength(4)
      expect(expected.some(s => s.displayRef)).toBe(true)
      expect(expected.some(s => s.snoozedUntil === null)).toBe(true)
    } finally { await f.store.close() }
  })

  it('reads at most three statements for 200 visibility candidates and none for primed ownership', async () => {
    const f = await fixture(200)
    try {
      resetQueryAttribution()
      await f.store.sync.queuedMessageCounts(asSessionId('calibration-only'))
      const recordingsPerStatement = statementCount()
      expect([1, 2]).toContain(recordingsPerStatement)
      const sessionReads = vi.spyOn(f.store.sessions, 'getSession')
      const userReads = vi.spyOn(f.store.users, 'get')
      resetQueryAttribution()
      const start = performance.now()
      const visible = await f.state.visibleSessions(principal, f.rows.map(s => s.sessionId))
      const count = statementCount() / recordingsPerStatement
      process.stdout.write(`visibility 200: ${count} physical statements, ${(performance.now() - start).toFixed(2)} ms\n`)
      // 80 of 200 — two in every five are the reader's own (see above).
      expect(visible.size).toBe(80)
      expect(count).toBe(3)
      expect(sessionReads).not.toHaveBeenCalled()
      expect(userReads).not.toHaveBeenCalled()

      // These registry sessions have no attached live process. Ownership reads
      // the registry, and its issue/grant inputs come from the enclosing pass.
      const pass = await f.view.buildProjectionPass(f.rows, principal)
      resetQueryAttribution()
      // ROW 3 IS THE B1 CASE ITSELF: owned by 'other', attached to an issue the
      // READER owns. Before PDM-133 this answered `reader` — the attached issue
      // outranking the row. It answers the row now.
      expect(await f.authz.sessionOwner(f.rows[3]!.sessionId, pass))
        .toEqual({ owner: asUserId('other'), grants: [] })
      expect(statementCount()).toBe(0)
      expect(sessionReads).not.toHaveBeenCalled()
      process.stdout.write('registered non-live ownership: 0 physical statements\n')
      resetQueryAttribution()
      expect(await f.state.visibleSessions(principal, [], pass)).toEqual(new Set())
      expect(statementCount()).toBe(0)
    } finally { await f.store.close() }
  })

  it('has a constant statement budget for 5, 50 and 200 sessions', async () => {
    const counts = []
    for (const size of [5, 50, 200]) {
      const f = await fixture(size)
      try {
        resetQueryAttribution()
        await f.store.sync.queuedMessageCounts(asSessionId('calibration-only'))
        const recordingsPerStatement = statementCount()
        expect([1, 2]).toContain(recordingsPerStatement)
        resetQueryAttribution()
        const start = performance.now()
        const result = await f.view.list(principal, 'rpc')
        counts.push(statementCount() / recordingsPerStatement)
        process.stdout.write(`projection ${size}: ${counts.at(-1)} physical statements, ${(performance.now() - start).toFixed(2)} ms\n`)
        expect(result).toHaveLength((size * 2) / 5)
        expect(f.machines.factsSnapshot).toHaveBeenCalledTimes(1)
      } finally { await f.store.close() }
    }
    // Repo registry is warm from fixture creation. Six physical reads: issues,
    // two grant kinds, queue counts and two overlays. Calibration accounts for
    // POD-3852 double recording, and still works after that fix lands.
    expect(counts[0]).toBe(6)
    expect(counts).toEqual([counts[0], counts[0], counts[0]])
  })

  it('has the same constant read budget for a broadcast slice of 5, 50 and 200 dirty sessions', async () => {
    const counts = []
    for (const size of [5, 50, 200]) {
      const f = await fixture(size)
      const repo = new SessionRepository({ sessions: f.sessions, store: f.store, view: f.view,
        now: () => Date.now(), runScheduledBroadcast: async () => {},
        ledger: { capture: async (specs: { entity: string; id: string; op: string; value: unknown }[]) => specs.map((s, i) => ({ ...s, entityId: s.id, seq: i + 1 })) },
      } as never)
      try {
        for (const s of f.rows) repo.markVolatileSessionDirty(s.sessionId)
        resetQueryAttribution()
        await f.store.sync.queuedMessageCounts(asSessionId('calibration-only'))
        const recordingsPerStatement = statementCount()
        expect([1, 2]).toContain(recordingsPerStatement)
        resetQueryAttribution()
        const start = performance.now()
        const result = await repo.drainVolatileCaptureSlice({ maxItems: size, maxCpuMs: Infinity })
        counts.push(statementCount() / recordingsPerStatement)
        process.stdout.write(`broadcast ${size}: ${counts.at(-1)} physical read statements, ${(performance.now() - start).toFixed(2)} ms\n`)
        expect(result.changes).toHaveLength(size)
        expect(result.remaining).toBe(0)
        expect(f.view.internalOverlayUser).toHaveBeenCalledTimes(1)
        expect(f.machines.factsSnapshot).toHaveBeenCalledTimes(1)
      } finally { await f.store.close() }
    }
    // Repo registry is warm from fixture creation. Six physical reads: issues,
    // two grant kinds, queue counts and two overlays. Calibration accounts for
    // POD-3852 double recording, and still works after that fix lands.
    expect(counts[0]).toBe(6)
    expect(counts).toEqual([counts[0], counts[0], counts[0]])
  })

  it('restricts queue counts to the requested set without a per-id parameter limit', async () => {
    const f = await fixture(5)
    try {
      const ids = [f.rows[0]!.sessionId, ...Array.from({ length: 1200 }, (_, i) => asSessionId(`absent-${i}`))]
      expect(await f.store.sync.queuedMessageCounts(ids)).toEqual(new Map([[f.rows[0]!.sessionId, 1]]))
      expect(await f.store.sync.queuedMessageCounts([])).toEqual(new Map())
    } finally { await f.store.close() }
  })

  it('does no IO once a pass has been built', async () => {
    const f = await fixture(5)
    try {
      const pass = await f.view.buildProjectionPass(f.rows, principal)
      resetQueryAttribution()
      f.rows.map(s => f.view.wire(s, pass))
      expect(statementCount()).toBe(0)
      expect(f.machines.factsSnapshot).toHaveBeenCalledTimes(1)
    } finally { await f.store.close() }
  })
})
