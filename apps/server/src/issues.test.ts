import type { SessionMeta } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { repoOpCommand } from '../../daemon/src/repo-op'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { SessionStore } from './store'

function harness(sessions: SessionMeta[] = []) {
  const store = new SessionStore(':memory:')
  const setSessionArchived = vi.fn()
  const broadcast = vi.fn()
  const deps: IssueDeps & { broadcast: ReturnType<typeof vi.fn> } = {
    store,
    listSessions: () => sessions,
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    broadcast,
    ...issueTestPlumbing((msg) => broadcast(msg)),
    setSessionArchived,
    now: () => '2026-06-30T00:00:00.000Z',
  }
  return { store, deps, svc: new IssueService(deps), setSessionArchived }
}

const sess = (cwd: string, phase = 'working'): SessionMeta =>
  ({
    sessionId: cwd,
    agentKind: 'claude-code',
    title: 't',
    cwd,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: 't',
    lastActiveAt: 't',
    origin: { kind: 'spawn' },
    archived: false,
    agentState: { phase, since: 't', openTaskCount: 0 },
  }) as unknown as SessionMeta

describe('IssueService repo_id scoping (#140)', () => {
  it('unifies one origin checked out at two paths into a single #N sequence', () => {
    const { store, deps } = harness()
    const origin = 'git@github.com:acme/app.git'
    store.repos.addRepo('/home/alice/app', 'm-alice', origin)
    store.repos.addRepo('/home/bob/app', 'm-bob', origin) // same origin ⇒ same repo_id
    const svc = new IssueService(deps)
    const a = svc.create({ repoPath: '/home/alice/app', title: 'from alice', startNow: false })
    const b = svc.create({ repoPath: '/home/bob/app', title: 'from bob', startNow: false })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2) // shared sequence — NOT two colliding #1s
    // list from either checkout returns the unified set
    expect(
      svc
        .list('/home/alice/app')
        .map((i) => i.id)
        .sort(),
    ).toEqual([a.id, b.id].sort())
    expect(
      svc
        .list('/home/bob/app')
        .map((i) => i.id)
        .sort(),
    ).toEqual([a.id, b.id].sort())
  })

  it('resolveRef scopes a shared #N to the caller repo; unscoped stays ambiguous', () => {
    const { store, deps } = harness()
    store.repos.addRepo('/repoA', 'mA', 'git@github.com:o/a.git')
    store.repos.addRepo('/repoB', 'mB', 'git@github.com:o/b.git') // distinct origins
    const svc = new IssueService(deps)
    const a = svc.create({ repoPath: '/repoA', title: 'A1', startNow: false })
    const b = svc.create({ repoPath: '/repoB', title: 'B1', startNow: false })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(1) // different repos, each starts at #1
    expect(svc.resolveRef('#1', '/repoA')).toBe(a.id) // scoped to caller's repo
    expect(svc.resolveRef('#1', '/repoB')).toBe(b.id)
    expect(() => svc.resolveRef('#1')).toThrow(/ambiguous issue ref #1/) // cross-repo, no scope
  })
})

describe('IssueService CRUD', () => {
  it('creates a backlog issue (startNow=false), assigns seq, broadcasts', () => {
    const { svc, deps } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    expect(wire.seq).toBe(1)
    expect(wire.stage).toBe('backlog')
    expect(wire.worktreePath).toBeNull()
    expect(deps.broadcast).toHaveBeenCalled()
    expect(svc.list('/r').length).toBe(1)
  })

  it('toWire derives members + summary from live sessions', () => {
    const { svc } = harness([
      sess('/r/wt', 'working'),
      sess('/r/wt/pkg', 'idle'),
      sess('/elsewhere'),
    ])
    const wire = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    // simulate a started issue by updating the worktree path
    const updated = svc.update(wire.id, { worktreePath: '/r/wt', stage: 'planning' })
    expect(updated.sessions.length).toBe(2)
    expect(updated.sessionSummary.total).toBe(2)
  })

  it('update patches fields; archive sets the flag', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    expect(svc.update(w.id, { stage: 'in_progress' }).stage).toBe('in_progress')
    expect(svc.archive(w.id).archived).toBe(true)
  })

  it('create honors a client-provided id verbatim (optimistic draft reconciliation)', () => {
    const { svc } = harness()
    const wire = svc.create({
      repoPath: '/r',
      title: 'X',
      startNow: false,
      id: 'iss_client-supplied',
    })
    expect(wire.id).toBe('iss_client-supplied')
    expect(svc.get('iss_client-supplied')?.id).toBe('iss_client-supplied')
  })

  it('create mints an iss_-prefixed uuid when no id is given (unchanged default behavior)', () => {
    const { svc } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    expect(wire.id).toMatch(/^iss_[0-9a-f-]{36}$/)
  })

  it('createDraftFor threads a client-provided id through to create()', () => {
    const { svc } = harness()
    const wire = svc.createDraftFor('/r', 'claude-code', 'iss_draft-client-id')
    expect(wire.id).toBe('iss_draft-client-id')
    expect(wire.draft).toBe(true)
  })

  it('createDraftFor mints an id when omitted (unchanged default behavior)', () => {
    const { svc } = harness()
    const wire = svc.createDraftFor('/r')
    expect(wire.id).toMatch(/^iss_[0-9a-f-]{36}$/)
  })
})

describe('IssueService single-issue broadcast (#22)', () => {
  const broadcasts = (deps: IssueDeps & { broadcast: ReturnType<typeof vi.fn> }) =>
    deps.broadcast.mock.calls.map((c) => c[0] as { type: string })

  it('a self-contained update serializes ONE wire and broadcasts only issueUpdated', () => {
    const { svc, deps } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.create({ repoPath: '/r', title: 'B', startNow: false })
    ;(deps.broadcast as ReturnType<typeof vi.fn>).mockClear()
    const wires = vi.spyOn(svc, 'toWire')
    svc.update(a.id, { notes: 'note' })
    // No full-list serialization: exactly one toWire (the mutated row).
    expect(wires).toHaveBeenCalledTimes(1)
    const sent = broadcasts(deps)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'issueUpdated', issue: { id: a.id, notes: 'note' } })
  })

  it('a closed-predicate flip additionally fans out the full list (cross-issue derivation)', () => {
    const { svc, deps } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    ;(deps.broadcast as ReturnType<typeof vi.fn>).mockClear()
    svc.close(a.id)
    const types = broadcasts(deps).map((m) => m.type)
    expect(types).toEqual(['issueUpdated', 'issuesChanged'])
  })
})

describe('IssueService unread (#124)', () => {
  it('a never-read issue with activity is unread; markIssueRead clears it', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    expect(w.unread).toBe(true)
    expect(w.readAt).toBeNull()
    const read = svc.markIssueRead(w.id)
    expect(read.readAt).toBe('2026-06-30T00:00:00.000Z')
    expect(read.unread).toBe(false)
    // The freshly-derived wire reflects it too.
    expect(svc.get(w.id)!.unread).toBe(false)
  })

  it('markIssueUnread nulls readAt so the row re-reads as unread + emits issue.unread (#138)', () => {
    const { svc, store } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.markIssueRead(w.id)
    expect(svc.get(w.id)!.unread).toBe(false)
    const un = svc.markIssueUnread(w.id)
    expect(un.readAt).toBeNull()
    expect(un.unread).toBe(true)
    // Freshly-derived wire agrees, and the transition event mirrors issue.read.
    expect(svc.get(w.id)!.unread).toBe(true)
    expect(store.events.listEventsSince(0, { kinds: ['issue.unread'] }).length).toBe(1)
  })

  it('derives unread from the latest of updatedAt / member-session lastActiveAt vs readAt', () => {
    const activeSess = { ...sess('/r/wt'), lastActiveAt: '2026-06-05T00:00:00.000Z' }
    const { svc, store } = harness([activeSess])
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.update(w.id, { worktreePath: '/r/wt' })
    const row = store.issues.getIssue(w.id)!
    // readAt AFTER all activity → read.
    expect(
      svc.toWire({
        ...row,
        updatedAt: '2026-06-01T00:00:00.000Z',
        readAt: '2026-06-06T00:00:00.000Z',
      }).unread,
    ).toBe(false)
    // A member session went active AFTER readAt → unread again.
    expect(
      svc.toWire({
        ...row,
        updatedAt: '2026-06-01T00:00:00.000Z',
        readAt: '2026-06-04T00:00:00.000Z',
      }).unread,
    ).toBe(true)
    // updatedAt itself postdates readAt → unread.
    expect(
      svc.toWire({
        ...row,
        updatedAt: '2026-06-10T00:00:00.000Z',
        readAt: '2026-06-06T00:00:00.000Z',
      }).unread,
    ).toBe(true)
  })
})

describe('IssueService.sweepAutoArchive (read-gated auto-archive #127)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  // A done issue read at the fixed harness clock (2026-06-30T00:00:00Z).
  const readAtMs = Date.parse('2026-06-30T00:00:00.000Z')
  const doneAndRead = () => {
    const h = harness()
    const w = h.svc.create({ repoPath: '/r', title: 'Done thing', startNow: false })
    h.svc.close(w.id) // stage=done, closedReason=done, updatedAt=harness now
    h.svc.markIssueRead(w.id) // readAt=harness now, unread→false
    return { ...h, id: w.id }
  }

  it('archives a done issue read > 24h ago; emits issue.auto_archived (not issue.archived)', () => {
    const { svc, store, deps, id } = doneAndRead()
    const archived = svc.sweepAutoArchive(readAtMs + DAY_MS + 3600_000) // 25h later
    expect(archived.map((w) => w.id)).toEqual([id])
    expect(archived[0]!.archived).toBe(true)
    expect(svc.get(id)!.archived).toBe(true)
    // The distinct auto-archive event is logged; the manual archive event is NOT.
    expect(store.events.listEventsSince(0, { kinds: ['issue.auto_archived'] }).length).toBe(1)
    expect(store.events.listEventsSince(0, { kinds: ['issue.archived'] }).length).toBe(0)
    expect(deps.broadcast).toHaveBeenCalled()
  })

  it('leaves a done+read issue read < 24h ago alone', () => {
    const { svc, store, id } = doneAndRead()
    const archived = svc.sweepAutoArchive(readAtMs + 12 * 3600_000) // only 12h later
    expect(archived).toEqual([])
    expect(svc.get(id)!.archived).toBe(false)
    expect(store.events.listEventsSince(0, { kinds: ['issue.auto_archived'] }).length).toBe(0)
  })

  it('leaves a done-but-unread issue alone even long after it was closed', () => {
    const h = harness()
    const w = h.svc.create({ repoPath: '/r', title: 'Unseen result', startNow: false })
    h.svc.close(w.id) // done, but never read → unread
    expect(h.svc.get(w.id)!.unread).toBe(true)
    const archived = h.svc.sweepAutoArchive(readAtMs + 10 * DAY_MS)
    expect(archived).toEqual([])
    expect(h.svc.get(w.id)!.archived).toBe(false)
  })

  it('leaves a not-done issue alone even when read long ago', () => {
    const h = harness()
    const w = h.svc.create({ repoPath: '/r', title: 'Still open', startNow: false })
    h.svc.markIssueRead(w.id) // read, but stage is backlog (open)
    const archived = h.svc.sweepAutoArchive(readAtMs + 10 * DAY_MS)
    expect(archived).toEqual([])
    expect(h.svc.get(w.id)!.archived).toBe(false)
  })

  it('does not re-archive: skips already-archived rows (idempotent, no duplicate event)', () => {
    const { svc, store, id } = doneAndRead()
    expect(svc.sweepAutoArchive(readAtMs + 2 * DAY_MS).map((w) => w.id)).toEqual([id])
    // A second sweep touches nothing and emits no further event.
    expect(svc.sweepAutoArchive(readAtMs + 3 * DAY_MS)).toEqual([])
    expect(store.events.listEventsSince(0, { kinds: ['issue.auto_archived'] }).length).toBe(1)
  })

  it('treats a closed-by-reason issue (not stage done) as archivable when read > 24h ago', () => {
    const h = harness()
    const canonical = h.svc.create({ repoPath: '/r', title: 'canonical', startNow: false })
    const dup = h.svc.create({ repoPath: '/r', title: 'dup', startNow: false })
    h.svc.duplicate(dup.id, canonical.id) // closedReason set (stage may not be 'done')
    h.svc.markIssueRead(dup.id)
    const archived = h.svc.sweepAutoArchive(readAtMs + 2 * DAY_MS)
    expect(archived.map((w) => w.id)).toContain(dup.id)
    expect(h.svc.get(canonical.id)!.archived).toBe(false) // still open → untouched
  })
})

describe('IssueService archive cascade to sessions (#133)', () => {
  it('archiving an issue archives its member sessions (so no orphan worktree row remains)', () => {
    const { svc, setSessionArchived } = harness([
      sess('/r/wt'),
      sess('/r/wt/pkg'),
      sess('/elsewhere'),
    ])
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.update(w.id, { worktreePath: '/r/wt' })
    setSessionArchived.mockClear()
    svc.archive(w.id)
    // Both member sessions (cwd inside the worktree) are archived; the outsider is not.
    expect(setSessionArchived).toHaveBeenCalledTimes(2)
    expect(setSessionArchived).toHaveBeenCalledWith('/r/wt', true)
    expect(setSessionArchived).toHaveBeenCalledWith('/r/wt/pkg', true)
    expect(setSessionArchived).not.toHaveBeenCalledWith('/elsewhere', true)
  })

  it('a context-menu / CLI update({ archived: true }) cascades the same way', () => {
    const { svc, setSessionArchived } = harness([sess('/r/wt')])
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.update(w.id, { worktreePath: '/r/wt' })
    setSessionArchived.mockClear()
    svc.update(w.id, { archived: true })
    expect(setSessionArchived).toHaveBeenCalledWith('/r/wt', true)
  })

  it('the S5 auto-archive sweep also archives member sessions so the worktree row disappears', () => {
    const member = { ...sess('/r/wt'), lastActiveAt: '2026-06-20T00:00:00.000Z' }
    const { svc, setSessionArchived } = harness([member])
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.update(w.id, { worktreePath: '/r/wt' })
    svc.close(w.id) // done
    svc.markIssueRead(w.id) // read at harness now
    setSessionArchived.mockClear()
    const nowMs = Date.parse('2026-06-30T00:00:00.000Z')
    const archived = svc.sweepAutoArchive(nowMs + 25 * 3600_000)
    expect(archived.map((a) => a.id)).toEqual([w.id])
    expect(setSessionArchived).toHaveBeenCalledWith('/r/wt', true)
  })

  it('un-archiving an issue does NOT cascade (sessions stay archived unless restored explicitly)', () => {
    const { svc, setSessionArchived } = harness([sess('/r/wt')])
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.update(w.id, { worktreePath: '/r/wt' })
    svc.archive(w.id)
    setSessionArchived.mockClear()
    svc.update(w.id, { archived: false })
    expect(setSessionArchived).not.toHaveBeenCalled()
  })

  it('skips already-archived member sessions (no redundant archive call)', () => {
    const live = sess('/r/wt/live')
    const already = { ...sess('/r/wt/gone'), archived: true }
    const { svc, setSessionArchived } = harness([live, already])
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.update(w.id, { worktreePath: '/r/wt' })
    setSessionArchived.mockClear()
    svc.archive(w.id)
    expect(setSessionArchived).toHaveBeenCalledTimes(1)
    expect(setSessionArchived).toHaveBeenCalledWith('/r/wt/live', true)
    expect(setSessionArchived).not.toHaveBeenCalledWith('/r/wt/gone', true)
  })
})

describe('IssueService next-message defer (#430)', () => {
  it('defers until next message and clears when a member session enters attention', () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions)
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.defer(w.id, 'next-message')
    expect(svc.get(w.id)!.deferred).toBe(true)
    // A session explicitly attached to the issue enters attention → defer clears.
    sessions.push({ ...sess('/elsewhere', 'awaiting_input'), issueId: w.id } as SessionMeta)
    svc.onSessionAttention('/elsewhere')
    expect(svc.get(w.id)!.deferred).toBe(false)
    expect(svc.get(w.id)!.deferUntil == null).toBe(true)
  })

  it("does not clear another issue's defer or timed defers", () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions)
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.defer(a.id, 'next-message')
    svc.defer(b.id, '2099-01-01')
    sessions.push({ ...sess('/x', 'awaiting_input'), issueId: b.id } as SessionMeta)
    svc.onSessionAttention('/x')
    expect(svc.get(a.id)!.deferred).toBe(true) // session belongs to b, not a
    expect(svc.get(b.id)!.deferred).toBe(true) // timed defer untouched
  })
})

describe('IssueService.undefer (manual unsnooze #133)', () => {
  const nowMs = Date.parse('2026-06-30T00:00:00.000Z')
  it('drops a snooze into the returned-from-defer state (past deferUntil, not null) + emits issue.unsnoozed', () => {
    const { svc, store } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.defer(w.id, '2026-07-15') // snooze into the future → deferred
    expect(svc.get(w.id)!.deferred).toBe(true)
    const un = svc.undefer(w.id)
    // NOT cleared to null — set to a PAST instant so the client reads it as
    // returned-from-defer (top-of-WORK + "Unsnoozed" tag), which a null cannot do.
    expect(un.deferUntil).not.toBeNull()
    expect(Date.parse(un.deferUntil!)).toBeLessThan(nowMs)
    // Backdated comfortably past the sidebar's coarse (minute-granularity) clock so
    // the transition shows immediately rather than up to a minute later.
    expect(nowMs - Date.parse(un.deferUntil!)).toBeGreaterThanOrEqual(60_000)
    // No longer deferred → back in the ready queue.
    expect(un.deferred).toBe(false)
    // The correct transition event is logged (unsnoozed), NOT a second snooze.
    expect(store.events.listEventsSince(0, { kinds: ['issue.unsnoozed'] }).length).toBe(1)
    expect(store.events.listEventsSince(0, { kinds: ['issue.snoozed'] }).length).toBe(1)
  })

  it('is a no-op when the issue is not deferred (no event, deferUntil stays null)', () => {
    const { svc, store } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    const un = svc.undefer(w.id)
    expect(un.deferUntil == null).toBe(true)
    expect(store.events.listEventsSince(0, { kinds: ['issue.unsnoozed'] }).length).toBe(0)
  })

  // FIX C (#138): opening an unsnoozed issue clears the "Unsnoozed" tag. The
  // open-path calls defer(null); prove it reliably NULLS the backdated deferUntil
  // (undefer left it in the past) so `issueReturnedFromDefer` goes false again.
  it('defer(id, null) clears the backdated deferUntil an undefer leaves behind', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.defer(w.id, '2026-07-15')
    const un = svc.undefer(w.id)
    expect(un.deferUntil).not.toBeNull() // backdated to the past (returned-from-defer)
    const cleared = svc.defer(w.id, null)
    expect(cleared.deferUntil == null).toBe(true) // tag source is gone
    expect(svc.get(w.id)!.deferUntil == null).toBe(true)
  })
})

describe('IssueService toWire needs_human (P4)', () => {
  it('surfaces needsHuman + humanQuestion set on the row', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const row = store.issues.getIssue(a.id)!
    const wired = svc.toWire({ ...row, needsHuman: true, humanQuestion: 'which key?' })
    expect(wired.needsHuman).toBe(true)
    expect(wired.humanQuestion).toBe('which key?')
  })

  it('reports needsHuman=false and omits humanQuestion when unset', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    const row = store.issues.getIssue(a.id)!
    const wired = svc.toWire({ ...row, needsHuman: false, humanQuestion: null })
    expect(wired.needsHuman).toBe(false)
    expect(wired.humanQuestion).toBeUndefined()
  })
})

describe('IssueService.start', () => {
  it('creates a worktree off parent, spawns the agent with the description as initialPrompt, moves to in_progress', async () => {
    const { svc, deps } = harness()
    const created = svc.create({
      repoPath: '/r',
      title: 'Fix login',
      description: 'do the thing',
      startNow: false,
    })
    const started = await svc.start(created.id)
    expect(started.stage).toBe('in_progress')
    expect(started.branch).toBe('issue/1-fix-login')
    expect(started.worktreePath).toBe('/r/.worktrees/issue-1-fix-login')
    expect(deps.repoOp).toHaveBeenCalledWith(
      'worktreeAdd',
      '/r',
      { path: '/r/.worktrees/issue-1-fix-login', branch: 'issue/1-fix-login', startPoint: 'main' },
      undefined,
    )
    expect(deps.spawnSession).toHaveBeenCalledWith({
      cwd: '/r/.worktrees/issue-1-fix-login',
      agentKind: 'claude-code',
      model: 'auto',
      effort: 'auto',
      initialPrompt: 'do the thing',
      spawnedBy: `issue:${created.id}`,
    })
  })

  it('routes worktree creation and the spawn to the issue machine when pinned', async () => {
    const { svc, deps } = harness()
    const created = svc.create({
      repoPath: '/r',
      title: 'Remote',
      startNow: false,
      machineId: 'mach-b',
    })
    expect(created.machineId).toBe('mach-b')
    await svc.start(created.id)
    expect(deps.repoOp).toHaveBeenCalledWith(
      'worktreeAdd',
      '/r',
      expect.objectContaining({ branch: 'issue/1-remote' }),
      'mach-b',
    )
    expect(deps.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'mach-b' }))
    svc.addSession(created.id)
    expect(deps.spawnSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ machineId: 'mach-b' }),
    )
  })

  it('pre-flights the machine pin: a failing requireMachineForRepo aborts before any work', async () => {
    const { svc, deps } = harness()
    deps.requireMachineForRepo = vi.fn(() => {
      throw new Error(
        "machine 'laptop' is offline — bring its daemon online or clear the issue's machine pin",
      )
    })
    const created = svc.create({
      repoPath: '/r',
      title: 'Remote',
      startNow: false,
      machineId: 'mach-b',
    })
    await expect(svc.start(created.id)).rejects.toThrow(/machine 'laptop' is offline/)
    expect(deps.requireMachineForRepo).toHaveBeenCalledWith('mach-b', '/r')
    expect(deps.repoOp).not.toHaveBeenCalled()
    expect(deps.spawnSession).not.toHaveBeenCalled()
    // addSession on a started issue is guarded too
    deps.requireMachineForRepo = vi.fn()
    await svc.start(created.id)
    ;(deps.requireMachineForRepo as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("machine 'laptop' has no repo registered at /r")
    })
    expect(() => svc.addSession(created.id)).toThrow(/no repo registered/)
  })

  it('unpinned issues skip the machine pre-flight', async () => {
    const { svc, deps } = harness()
    deps.requireMachineForRepo = vi.fn(() => {
      throw new Error('should not be called')
    })
    const created = svc.create({ repoPath: '/r', title: 'Local', startNow: false })
    await svc.start(created.id)
    expect(deps.requireMachineForRepo).not.toHaveBeenCalled()
  })

  it('starting a closed issue reopens it explicitly: closed markers clear + issue.reopened (#24)', async () => {
    const { svc, store } = harness()
    const created = svc.create({ repoPath: '/r', title: 'Closed then started', startNow: false })
    svc.close(created.id, 'wontfix')
    const started = await svc.start(created.id)
    expect(started.stage).toBe('in_progress')
    expect(started.closedReason).toBeUndefined()
    expect(started.ready).toBe(true)
    expect(svc.search({ repoPath: '/r', status: 'open' }).map((i) => i.id)).toEqual([created.id])
    const reopened = store.events.listEventsSince(0).filter((e) => e.kind === 'issue.reopened')
    expect(reopened).toHaveLength(1)
  })

  it('machineId persists through the store and clears via update(null)', () => {
    const { svc, store } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false, machineId: 'mach-b' })
    expect(store.issues.getIssue(w.id)?.machineId).toBe('mach-b')
    expect(svc.update(w.id, { machineId: null }).machineId).toBeUndefined()
    expect(store.issues.getIssue(w.id)?.machineId).toBeNull()
  })

  it('create(startNow=true) starts immediately', async () => {
    const { svc } = harness()
    const wire = await svc.createAndMaybeStart({ repoPath: '/r', title: 'X', startNow: true })
    expect(wire.stage).toBe('in_progress')
    expect(wire.worktreePath).not.toBeNull()
  })

  it('start fails clearly when the worktree op fails', async () => {
    const { svc, deps } = harness()
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      output: 'fatal: branch exists',
    })
    const created = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await expect(svc.start(created.id)).rejects.toThrow(/fatal: branch exists/)
  })

  it('start auto-claims the issue (assignee = agent, stage = in_progress)', async () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const started = await svc.start(a.id)
    expect(started.assignee).toBe('agent:claude-code')
    expect(started.stage).toBe('in_progress')
  })

  it('uses an explicitly selected agent when starting an unstarted issue', async () => {
    const { svc, deps } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const started = await svc.start(a.id, 'codex')
    expect(started.defaultAgent).toBe('codex')
    expect(started.assignee).toBe('agent:codex')
    expect(deps.spawnSession).toHaveBeenCalledWith({
      cwd: '/r/.worktrees/issue-1-a',
      agentKind: 'codex',
      model: 'auto',
      effort: 'auto',
      spawnedBy: `issue:${a.id}`,
    })
  })

  it('captures a chosen model + effort on the issue and spawns with them', async () => {
    const { svc, deps } = harness()
    const a = svc.create({
      repoPath: '/r',
      title: 'A',
      startNow: false,
      defaultModel: 'opus',
      defaultEffort: 'high',
    })
    expect(a.defaultModel).toBe('opus')
    expect(a.defaultEffort).toBe('high')
    const started = await svc.start(a.id)
    expect(started.defaultModel).toBe('opus')
    expect(deps.spawnSession).toHaveBeenCalledWith({
      cwd: '/r/.worktrees/issue-1-a',
      agentKind: 'claude-code',
      model: 'opus',
      effort: 'high',
      spawnedBy: `issue:${a.id}`,
    })
  })

  it("addSession/addShell tag the spawn with the issue's provenance (issue #60)", async () => {
    const { svc, deps } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    await svc.start(a.id)
    svc.addSession(a.id, 'codex')
    expect(deps.spawnSession).toHaveBeenLastCalledWith({
      cwd: '/r/.worktrees/issue-1-a',
      agentKind: 'codex',
      model: 'auto',
      effort: 'auto',
      spawnedBy: `issue:${a.id}`,
    })
    svc.addShell(a.id)
    expect(deps.spawnSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentKind: 'shell', spawnedBy: `issue:${a.id}` }),
    )
  })
})

describe('IssueService.action', () => {
  async function started() {
    const { svc, deps } = harness()
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.start(c.id)
    return { svc, deps, id: c.id }
  }

  it('rebase calls repoOp on the worktree with the parent branch', async () => {
    const { svc, deps, id } = await started()
    const r = await svc.action(id, 'rebase')
    expect(r.ok).toBe(true)
    expect(deps.repoOp).toHaveBeenCalledWith('rebase', '/r/.worktrees/issue-1-x', {
      parentBranch: 'main',
    })
  })

  it('pr captures the PR url from output', async () => {
    const { svc, deps, id } = await started()
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      output: 'https://github.com/o/r/pull/42',
    })
    const r = await svc.action(id, 'pr')
    expect(r.issue.prUrl).toBe('https://github.com/o/r/pull/42')
  })

  it('merge auto-rebases then ff-merges in the repo root', async () => {
    const { svc, deps, id } = await started()
    const calls: string[] = []
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => {
      calls.push(op)
      return { ok: true, output: op === 'status' ? '## main...origin/main' : '' }
    })
    await svc.action(id, 'merge')
    expect(calls).toEqual(['rebase', 'status', 'mergeFfOnly'])
    expect(deps.repoOp).toHaveBeenCalledWith('mergeFfOnly', '/r', { branch: 'issue/1-x' })
  })

  it('merge auto-closes the issue on success', async () => {
    const { svc, deps, id } = await started()
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => ({
      ok: true,
      output: op === 'status' ? '## main...origin/main' : '',
    }))
    const res = await svc.action(id, 'merge')
    expect(res.ok).toBe(true)
    expect(res.issue.stage).toBe('done')
    expect(res.issue.closedReason).toBe('done')
  })

  it('merge does NOT close the issue when the merge fails', async () => {
    const { svc, deps, id } = await started()
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => ({
      ok: op !== 'mergeFfOnly', // rebase/status ok, mergeFfOnly fails
      output: op === 'status' ? '## main...origin/main' : 'merge conflict',
    }))
    const res = await svc.action(id, 'merge')
    expect(res.ok).toBe(false)
    expect(res.issue.stage).not.toBe('done')
  })

  it('merge short-circuits when the rebase fails and never ff-merges', async () => {
    const { svc, deps, id } = await started()
    const calls: string[] = []
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => {
      calls.push(op)
      if (op === 'rebase') return { ok: false, output: 'CONFLICT' }
      return { ok: true, output: '' }
    })
    const r = await svc.action(id, 'merge')
    expect(r.ok).toBe(false)
    expect(r.output).toBe('CONFLICT')
    expect(calls).toEqual(['rebase'])
    expect(calls).not.toContain('mergeFfOnly')
  })

  it('merge refuses (no ff-merge) when the repo root is not on the parent branch', async () => {
    const { svc, deps, id } = await started()
    const calls: string[] = []
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => {
      calls.push(op)
      return { ok: true, output: op === 'status' ? '## some-other-branch' : '' }
    })
    const r = await svc.action(id, 'merge')
    expect(r.ok).toBe(false)
    expect(r.output).toContain("is on 'some-other-branch'")
    expect(r.output).toContain("not the parent branch 'main'")
    expect(calls).toEqual(['rebase', 'status'])
    expect(calls).not.toContain('mergeFfOnly')
  })

  it('merge refuses (no ff-merge) when the repo root is detached', async () => {
    const { svc, deps, id } = await started()
    const calls: string[] = []
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => {
      calls.push(op)
      return { ok: true, output: op === 'status' ? '## HEAD (no branch)' : '' }
    })
    const r = await svc.action(id, 'merge')
    expect(r.ok).toBe(false)
    expect(r.output).toContain("is on 'null'")
    expect(calls).not.toContain('mergeFfOnly')
  })
})

describe('IssueService.parseCurrentBranch', () => {
  // parseCurrentBranch is private; exercise it through the merge guard, which only
  // proceeds to mergeFfOnly when the parsed branch === parentBranch ('main').
  async function startedSvc() {
    const { svc, deps } = harness()
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.start(c.id)
    return { svc, deps, id: c.id }
  }
  async function mergedBranch(
    statusOutput: string,
  ): Promise<{ ok: boolean; output: string; calls: string[] }> {
    const { svc, deps, id } = await startedSvc()
    const calls: string[] = []
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => {
      calls.push(op)
      return { ok: true, output: op === 'status' ? statusOutput : '' }
    })
    const r = await svc.action(id, 'merge')
    return { ok: r.ok, output: r.output, calls }
  }

  it('parses a plain branch (## main) and allows the ff-merge', async () => {
    const { calls } = await mergedBranch('## main')
    expect(calls).toContain('mergeFfOnly')
  })

  it('parses a branch with an upstream (## main...origin/main) and allows the ff-merge', async () => {
    const { calls } = await mergedBranch('## main...origin/main')
    expect(calls).toContain('mergeFfOnly')
  })

  it('treats detached HEAD (## HEAD (no branch)) as null and refuses the ff-merge', async () => {
    const { ok, calls } = await mergedBranch('## HEAD (no branch)')
    expect(ok).toBe(false)
    expect(calls).not.toContain('mergeFfOnly')
  })
})

describe('IssueService.linearSearch', () => {
  it('returns [] when no key configured', async () => {
    const { svc } = harness()
    expect(await svc.linearSearch('login')).toEqual([])
  })
})

describe('IssueService derived status (P1)', () => {
  it('new issue is ready (open, no blockers) with defaults', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(w.priority).toBe(2)
    expect(w.type).toBe('task')
    expect(w.pinned).toBe(false)
    expect(w.labels).toEqual([])
    expect(w.deps).toEqual([])
    expect(w.ready).toBe(true)
    expect(w.blocked).toBe(false)
    expect(w.deferred).toBe(false)
  })

  it('a blocks-dependency on an open issue makes the dependent blocked (not ready)', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    store.issues.addIssueDep(a.id, b.id, 'blocks')
    const reloaded = svc.get(a.id)!
    expect(reloaded.blocked).toBe(true)
    expect(reloaded.ready).toBe(false)
    expect(reloaded.deps).toEqual([{ id: b.id, type: 'blocks' }])
  })

  it('closing the blocker (stage=done) unblocks the dependent', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    store.issues.addIssueDep(a.id, b.id, 'blocks')
    svc.update(b.id, { stage: 'done' })
    expect(svc.get(a.id)!.ready).toBe(true)
  })

  it('a future defer_until marks the issue deferred and not ready', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const deferred = svc.update(a.id, { deferUntil: '2999-01-01' })
    expect(deferred.deferred).toBe(true)
    expect(deferred.ready).toBe(false)
  })

  it('epic counts reflect children by parentId', () => {
    const { svc, store } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'Epic', startNow: false })
    const c1 = svc.create({ repoPath: '/r', title: 'c1', startNow: false })
    const c2 = svc.create({ repoPath: '/r', title: 'c2', startNow: false })
    svc.update(c1.id, { parentId: epic.id })
    svc.update(c2.id, { parentId: epic.id, stage: 'done' })
    const e = svc.get(epic.id)!
    expect(e.childCount).toBe(2)
    expect(e.childDoneCount).toBe(1)
  })
})

describe('IssueService assistant', () => {
  function harnessWithLlm(json: string) {
    const { deps } = harness([])
    deps.llm = (() => ({
      label: 'fake',
      complete: async () => ({ text: json, toolCalls: [] }),
    })) as never
    deps.repoOp = vi.fn(async (op: string) => ({
      ok: true,
      output: op === 'status' ? '## issue/1-x' : 'abc plan',
    })) as never
    deps.getSettings = () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
        issues: { assistantEnabled: true },
        workLlm: { kind: 'api', provider: 'openrouter', model: 'm' },
      })
    return { svc: new IssueService(deps), deps }
  }

  it('refreshAssistant writes activity notes + suggestion and broadcasts', async () => {
    const { svc } = harnessWithLlm(
      '{"activityNotes":"making progress","suggestedStage":"in_progress","suggestedReason":"plan done","blockedBy":[],"dependencyNote":""}',
    )
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(c.id, { worktreePath: '/r/wt', branch: 'issue/1-x', stage: 'planning' })
    const wire = await svc.refreshAssistant(c.id)
    expect(wire.activityNotes).toBe('making progress')
    expect(wire.suggestedStage).toBe('in_progress')
  })

  it('applySuggestion moves the stage and clears the suggestion', async () => {
    const { svc } = harnessWithLlm(
      '{"activityNotes":"x","suggestedStage":"in_progress","suggestedReason":"r","blockedBy":[],"dependencyNote":""}',
    )
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(c.id, { worktreePath: '/r/wt', branch: 'issue/1-x', stage: 'planning' })
    await svc.refreshAssistant(c.id)
    const moved = svc.applySuggestion(c.id)
    expect(moved.stage).toBe('in_progress')
    expect(moved.suggestedStage).toBeUndefined()
  })

  it('dismissSuggestion clears without moving', async () => {
    const { svc } = harnessWithLlm(
      '{"activityNotes":"x","suggestedStage":"in_progress","suggestedReason":"r","blockedBy":[],"dependencyNote":""}',
    )
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(c.id, { worktreePath: '/r/wt', branch: 'issue/1-x', stage: 'planning' })
    await svc.refreshAssistant(c.id)
    const d = svc.dismissSuggestion(c.id)
    expect(d.stage).toBe('planning')
    expect(d.suggestedStage).toBeUndefined()
  })
})

describe('IssueService field mutations (P1)', () => {
  it('setLabels persists and surfaces on the wire', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(svc.setLabels(a.id, ['ui', 'p1']).labels).toEqual(['p1', 'ui'])
  })

  // #175: comment bodies left IssueWire — the wire carries only commentCount;
  // the thread itself is served by IssueService.comments (issues.comments proc).
  it('addComment appends a comment; wire carries the count, comments() the bodies', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const w = svc.addComment(a.id, 'mike', 'looks good')
    expect(w.commentCount).toBe(1)
    expect(w.comments).toBeUndefined()
    const thread = svc.comments(a.id)
    expect(thread.map((c) => c.body)).toEqual(['looks good'])
    expect(thread[0]!.author).toBe('mike')
  })

  // #175 payload win: serializing the full list runs ONE batched comment-count
  // query (no per-issue comment queries) and the wire carries no comment bodies.
  it('list() batches comment counts and puts no comment bodies on the wire', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.create({ repoPath: '/r', title: 'C', startNow: false })
    svc.addComment(a.id, 'mike', 'secret-body-marker')
    svc.addComment(a.id, 'mike', 'second note')
    const perIssueList = vi.spyOn(store.issues, 'listIssueComments')
    const perIssueCount = vi.spyOn(store.issues, 'countIssueComments')
    const batched = vi.spyOn(store.issues, 'countIssueCommentsByIssue')
    const wires = svc.list('/r')
    expect(perIssueList).not.toHaveBeenCalled()
    expect(perIssueCount).not.toHaveBeenCalled()
    expect(batched).toHaveBeenCalledTimes(1)
    expect(wires.find((w) => w.id === a.id)?.commentCount).toBe(2)
    expect(wires.every((w) => w.comments === undefined)).toBe(true)
    expect(JSON.stringify(wires)).not.toContain('secret-body-marker')
  })

  it('addDep blocks ready; rejects self-dep and cycles', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    expect(svc.addDep(a.id, b.id).blocked).toBe(true)
    expect(() => svc.addDep(a.id, a.id)).toThrow(/self/)
    expect(() => svc.addDep(b.id, a.id)).toThrow(/cycle/) // a->b already; b->a closes the loop
  })

  it('claim sets assignee + in_progress; close sets done + reason', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const claimed = svc.claim(a.id, 'agent:claude')
    expect(claimed.assignee).toBe('agent:claude')
    expect(claimed.stage).toBe('in_progress')
    const closed = svc.close(a.id, 'wontfix')
    expect(closed.stage).toBe('done')
    expect(closed.closedReason).toBe('wontfix')
  })

  it('setNeedsHuman/clearNeedsHuman toggle the flag + question', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const flagged = svc.setNeedsHuman(a.id, 'which key?')
    expect(flagged.needsHuman).toBe(true)
    expect(flagged.humanQuestion).toBe('which key?')
    const cleared = svc.clearNeedsHuman(a.id)
    expect(cleared.needsHuman).toBe(false)
    expect(cleared.humanQuestion).toBeUndefined()
  })

  it('ancestorIds walks the parent chain nearest-first', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'epic', startNow: false })
    const mid = svc.create({ repoPath: '/r', title: 'mid', startNow: false, parentId: epic.id })
    const leaf = svc.create({ repoPath: '/r', title: 'leaf', startNow: false, parentId: mid.id })
    expect(svc.ancestorIds(leaf.id)).toEqual([mid.id, epic.id])
    expect(svc.ancestorIds(epic.id)).toEqual([])
  })

  it('reparent stores the parent ONLY in parent_id; the wire synthesizes the edge (#164)', () => {
    const { svc, store } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    svc.reparent(child.id, epic.id)
    expect(store.issues.listIssueDeps(child.id)).toEqual([]) // no mirrored dep row
    expect(svc.get(child.id)!.parentId).toBe(epic.id)
    expect(svc.get(child.id)!.deps).toEqual([{ id: epic.id, type: 'parent-child' }]) // synthesized
    svc.reparent(child.id, null)
    expect(svc.get(child.id)!.parentId).toBeUndefined()
    expect(svc.get(child.id)!.deps).toEqual([])
  })
})

describe('IssueService hierarchy reconciliation (P2a / I2)', () => {
  it('create({parentId}) sets parent_id; wire deps/dependents synthesize the edge (#164)', () => {
    const { svc, store } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'C', parentId: epic.id, startNow: false })
    expect(store.issues.listIssueDeps(child.id)).toEqual([]) // single storage: no dep row
    expect(svc.get(child.id)!.deps).toEqual([{ id: epic.id, type: 'parent-child' }])
    expect(svc.get(epic.id)!.dependents).toEqual([{ id: child.id, type: 'parent-child' }])
    expect(svc.get(epic.id)!.childCount).toBe(1)
  })

  it('update({parentId}) moves the synthesized edge with the column', () => {
    const { svc } = harness()
    const e1 = svc.create({ repoPath: '/r', title: 'E1', startNow: false })
    const e2 = svc.create({ repoPath: '/r', title: 'E2', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    svc.update(c.id, { parentId: e1.id })
    expect(svc.get(c.id)!.deps).toEqual([{ id: e1.id, type: 'parent-child' }])
    svc.update(c.id, { parentId: e2.id })
    expect(svc.get(c.id)!.deps).toEqual([{ id: e2.id, type: 'parent-child' }])
    expect(svc.get(e1.id)!.dependents).toEqual([])
    svc.update(c.id, { parentId: null })
    expect(svc.get(c.id)!.deps).toEqual([])
  })

  it('a parentId change that forms a cycle is rejected via create or update', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', parentId: a.id, startNow: false })
    expect(() => svc.update(a.id, { parentId: b.id })).toThrow(/cycle/)
  })

  it('a cycle-throw on reparent leaves the old parent intact', () => {
    const { svc } = harness()
    const old = svc.create({ repoPath: '/r', title: 'OLD', startNow: false })
    const x = svc.create({ repoPath: '/r', title: 'X', parentId: old.id, startNow: false })
    const nw = svc.create({ repoPath: '/r', title: 'NEW', parentId: x.id, startNow: false })
    // OLD <- X <- NEW. Reparenting X under its descendant NEW must throw AND change nothing.
    expect(() => svc.update(x.id, { parentId: nw.id })).toThrow(/cycle/)
    expect(svc.get(x.id)!.parentId).toBe(old.id)
    expect(svc.get(old.id)!.dependents).toContainEqual({ id: x.id, type: 'parent-child' })
  })

  it('dependency cycles ignore parent-child containment edges (#413)', () => {
    const { svc } = harness()
    const root = svc.create({ repoPath: '/r', title: 'Root', startNow: false })
    const parent = svc.create({ repoPath: '/r', title: 'Parent', startNow: false })
    const child = svc.create({
      repoPath: '/r',
      title: 'Child',
      parentId: parent.id,
      startNow: false,
    })
    svc.addDep(parent.id, root.id, 'blocks')

    expect(() => svc.addDep(root.id, child.id, 'blocks')).not.toThrow()
    expect(svc.get(root.id)!.deps).toContainEqual({ id: child.id, type: 'blocks' })
    expect(svc.doctor('/r').cycles).toEqual([])
  })

  it('dependency-cycle errors name the offending dependency path (#413)', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    svc.addDep(a.id, b.id)
    svc.addDep(b.id, c.id)

    expect(() => svc.addDep(c.id, a.id)).toThrow(
      `dependency ${c.id} -> ${a.id} would create a dependency cycle: ${c.id} -> ${a.id} -> ${b.id} -> ${c.id}`,
    )
  })

  it('addDep rejects parent-child (reparent owns the hierarchy edge)', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    expect(() => svc.addDep(a.id, b.id, 'parent-child')).toThrow(/parent-child/)
  })

  it('removeDep rejects explicit parent-child and leaves the hierarchy intact', () => {
    const { svc } = harness()
    const e = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', parentId: e.id, startNow: false })
    expect(() => svc.removeDep(c.id, e.id, 'parent-child')).toThrow(/parent-child/)
    expect(svc.get(c.id)!.parentId).toBe(e.id)
  })

  it('removeDep with no type removes real dep rows but never the hierarchy', () => {
    const { svc, store } = harness()
    const e = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', parentId: e.id, startNow: false })
    store.issues.addIssueDep(c.id, e.id, 'related') // a real edge on the same pair
    svc.removeDep(c.id, e.id) // no type → bulk
    expect(store.issues.listIssueDeps(c.id)).toEqual([])
    expect(svc.get(c.id)!.parentId).toBe(e.id) // hierarchy untouched (parent_id)
    expect(svc.get(c.id)!.deps).toEqual([{ id: e.id, type: 'parent-child' }])
  })
})

describe('IssueService ready/blocked lists (P2a)', () => {
  it('readyList returns only ready issues, priority then seq ordered', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', priority: 3, startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', priority: 0, startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    store.issues.addIssueDep(a.id, c.id, 'blocks') // a blocked by open c
    svc.update(c.id, {}) // no-op to ensure persisted
    const ready = svc.readyList('/r').map((w) => w.title)
    expect(ready).toEqual(['B', 'C']) // A is blocked; B(p0) before C(p2)
  })

  it('blockedList returns only blocked issues', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    store.issues.addIssueDep(a.id, b.id, 'blocks')
    expect(svc.blockedList('/r').map((w) => w.title)).toEqual(['A'])
  })
})

describe('IssueService graph (P2a)', () => {
  it('returns nodes for repo issues and edges from issue_deps', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.create({ repoPath: '/other', title: 'X', startNow: false })
    store.issues.addIssueDep(a.id, b.id, 'blocks')
    const g = svc.graph('/r')
    expect(g.nodes.map((n) => n.title).sort()).toEqual(['A', 'B'])
    expect(g.edges).toEqual([{ from: a.id, to: b.id, type: 'blocks' }])
    expect(g.nodes.find((n) => n.title === 'A')!.blocked).toBe(true)
  })
})

describe('IssueService epic status (P2a)', () => {
  it('epicStatus reports child completion; closeEligibleEpics lists fully-done epics', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', type: 'epic', startNow: false })
    const c1 = svc.create({ repoPath: '/r', title: 'c1', parentId: epic.id, startNow: false })
    const c2 = svc.create({ repoPath: '/r', title: 'c2', parentId: epic.id, startNow: false })
    expect(svc.epicStatus(epic.id)).toEqual({
      id: epic.id,
      childCount: 2,
      childDoneCount: 0,
      complete: false,
    })
    expect(svc.closeEligibleEpics('/r')).toEqual([])
    svc.close(c1.id)
    svc.close(c2.id)
    expect(svc.epicStatus(epic.id)).toEqual({
      id: epic.id,
      childCount: 2,
      childDoneCount: 2,
      complete: true,
    })
    expect(svc.closeEligibleEpics('/r').map((w) => w.id)).toEqual([epic.id])
  })
})

describe('IssueService.tree (issue #82)', () => {
  it('returns the whole subtree in one payload with blocks-deps as seqs', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'Epic', type: 'epic', startNow: false })
    const c1 = svc.create({
      repoPath: '/r',
      title: 'C1',
      parentId: epic.id,
      startNow: false,
      description: 'do  the\nthing',
    })
    const c2 = svc.create({ repoPath: '/r', title: 'C2', parentId: epic.id, startNow: false })
    const g1 = svc.create({ repoPath: '/r', title: 'G1', parentId: c1.id, startNow: false })
    svc.addDep(c1.id, c2.id, 'blocks')
    svc.close(c2.id)
    const t = svc.tree(String(epic.seq)) // resolves display seq refs too
    expect(t.totalNodes).toBe(4)
    expect(t.omitted).toBe(0)
    expect(t.root.seq).toBe(epic.seq)
    const [n1, n2] = t.root.children
    expect(n1!.seq).toBe(c1.seq)
    expect(n1!.blocksDeps).toEqual([c2.seq])
    expect(n1!.blocked).toBe(false) // c2 closed → not blocking
    expect(n1!.description).toBe('do the thing') // whitespace collapsed to one line
    expect(n1!.children[0]!.seq).toBe(g1.seq)
    expect(n2!.closed).toBe(true)
  })

  it('caps depth and total nodes, counting omissions per parent and in total', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', type: 'epic', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', parentId: epic.id, startNow: false })
    const g = svc.create({ repoPath: '/r', title: 'G', parentId: c.id, startNow: false })
    const gg = svc.create({ repoPath: '/r', title: 'GG', parentId: g.id, startNow: false })
    svc.create({ repoPath: '/r', title: 'GGG', parentId: gg.id, startNow: false }) // depth 4 → omitted
    const t = svc.tree(epic.id)
    expect(t.totalNodes).toBe(4)
    expect(t.omitted).toBe(1)
    const deepest = t.root.children[0]!.children[0]!.children[0]!
    expect(deepest.title).toBe('GG')
    expect(deepest.omittedChildren).toBe(1)

    const wide = svc.create({ repoPath: '/r', title: 'W', type: 'epic', startNow: false })
    for (let i = 0; i < 5; i++)
      svc.create({ repoPath: '/r', title: `k${i}`, parentId: wide.id, startNow: false })
    const capped = svc.tree(wide.id, { maxNodes: 3 })
    expect(capped.totalNodes).toBe(3)
    expect(capped.root.children.length).toBe(2)
    expect(capped.root.omittedChildren).toBe(3)
    expect(capped.omitted).toBe(3)
  })

  it('truncates descriptions to 300 chars and throws on an unknown ref', () => {
    const { svc } = harness()
    const e = svc.create({
      repoPath: '/r',
      title: 'E',
      startNow: false,
      description: 'x'.repeat(500),
    })
    expect(svc.tree(e.id).root.description.length).toBe(300)
    expect(() => svc.tree('iss_nope')).toThrow()
  })
})

describe('IssueService supersede/duplicate (P2b)', () => {
  it('supersede closes old with reason + supersededBy + supersedes dep', () => {
    const { svc, store } = harness()
    const oldI = svc.create({ repoPath: '/r', title: 'old', startNow: false })
    const newI = svc.create({ repoPath: '/r', title: 'new', startNow: false })
    const w = svc.supersede(oldI.id, newI.id)
    expect(w.stage).toBe('done')
    expect(w.closedReason).toBe('superseded')
    expect(w.supersededBy).toBe(newI.id)
    expect(store.issues.listIssueDeps(oldI.id)).toEqual([{ toId: newI.id, type: 'supersedes' }])
  })

  it('duplicate closes id with reason + duplicateOf + related dep', () => {
    const { svc, store } = harness()
    const dup = svc.create({ repoPath: '/r', title: 'dup', startNow: false })
    const canon = svc.create({ repoPath: '/r', title: 'canon', startNow: false })
    const w = svc.duplicate(dup.id, canon.id)
    expect(w.closedReason).toBe('duplicate')
    expect(w.duplicateOf).toBe(canon.id)
    expect(store.issues.listIssueDeps(dup.id)).toEqual([{ toId: canon.id, type: 'related' }])
  })

  it('supersede throws on unknown id', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'a', startNow: false })
    expect(() => svc.supersede(a.id, 'iss_missing')).toThrow()
  })
})

describe('IssueService findDuplicates (P2b)', () => {
  it('flags near-identical open issues above threshold', () => {
    const { svc } = harness()
    svc.create({
      repoPath: '/r',
      title: 'Fix login bug',
      description: 'cannot sign in',
      startNow: false,
    })
    svc.create({
      repoPath: '/r',
      title: 'Fix login bug',
      description: 'cannot sign in',
      startNow: false,
    })
    svc.create({
      repoPath: '/r',
      title: 'Add dark mode',
      description: 'theme toggle',
      startNow: false,
    })
    const dups = svc.findDuplicates('/r', 0.6)
    expect(dups.length).toBe(1)
    expect(dups[0]!.score).toBe(1)
  })
})

describe('IssueService stale/lint (P2b)', () => {
  it('staleList returns issues older than the cutoff (open only)', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'old', startNow: false })
    // backdate updatedAt directly in the store, then refresh the in-memory row
    const row = store.issues.getIssue(a.id)!
    row.updatedAt = '2000-01-01T00:00:00.000Z'
    store.issues.upsertIssue(row)
    svc.reload() // re-hydrate this.rows from the store (see Step 3)
    const stale = svc.staleList('/r', 30, Date.parse('2026-06-30T00:00:00.000Z'))
    expect(stale.map((w) => w.title)).toEqual(['old'])
  })

  it('lint flags a feature with no acceptance', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'F', description: 'd', type: 'feature', startNow: false })
    const findings = svc.lint('/r')
    expect(findings.length).toBe(1)
    expect(findings[0]!.findings).toEqual(['missing acceptance criteria'])
  })
})

describe('IssueService search/count/stats (P2b)', () => {
  it('search filters by text + priority + status', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'Login fails', priority: 0, startNow: false })
    svc.create({ repoPath: '/r', title: 'Dark mode', priority: 2, startNow: false })
    const done = svc.create({ repoPath: '/r', title: 'Login done', startNow: false })
    svc.close(done.id)
    expect(
      svc
        .search({ repoPath: '/r', text: 'login' })
        .map((w) => w.title)
        .sort(),
    ).toEqual(['Login done', 'Login fails'])
    expect(
      svc.search({ repoPath: '/r', text: 'login', status: 'open' }).map((w) => w.title),
    ).toEqual(['Login fails'])
    expect(svc.search({ repoPath: '/r', priority: 0 }).map((w) => w.title)).toEqual(['Login fails'])
  })

  it('count groups and stats totals', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'A', priority: 0, type: 'bug', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.close(b.id)
    expect(svc.count('/r').byPriority['0']).toBe(1)
    expect(svc.count('/r').byType['bug']).toBe(1)
    const s = svc.stats('/r')
    expect(s.total).toBe(2)
    expect(s.closed).toBe(1)
    expect(s.open).toBe(1)
  })
})

describe('IssueService doctor/preflight (P2b)', () => {
  it('doctor reports dangling deps and clean preflight when none', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    // A dangling edge can no longer be written through the store (FKs since
    // migration 006) — inject it with enforcement off, simulating corruption
    // by an external writer. doctor stays as read-side defense in depth.
    const raw = (store as unknown as { db: { exec(q: string): void } }).db
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.exec(
      `INSERT INTO issue_deps (from_id, to_id, type) VALUES ('${a.id}', 'iss_ghost', 'blocks')`,
    )
    raw.exec('PRAGMA foreign_keys = ON')
    const d = svc.doctor('/r')
    expect(d.danglingDeps).toEqual([{ from: a.id, to: 'iss_ghost', type: 'blocks' }])
    expect(svc.preflight('/r').ok).toBe(false)
  })

  it('preflight ok when no cycles or dangling deps', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(svc.preflight('/r').ok).toBe(true)
  })
})

describe('IssueService orphans (P2b)', () => {
  it('flags open issues referenced in commit messages', async () => {
    const { svc, deps } = harness()
    const a = svc.create({ repoPath: '/r', title: 'Add login', startNow: false }) // seq 1
    svc.create({ repoPath: '/r', title: 'Other', startNow: false }) // seq 2, not referenced
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      output: 'abc123 feat: implement login (#1)\ndef456 chore: tidy',
    })
    const orphans = await svc.orphans('/r')
    expect(orphans.map((o) => o.seq)).toEqual([1])
    expect(orphans[0]!.id).toBe(a.id)
  })

  it('returns [] when repoOp(log) fails', async () => {
    const { svc, deps } = harness()
    svc.create({ repoPath: '/r', title: 'X', startNow: false })
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, output: '' })
    expect(await svc.orphans('/r')).toEqual([])
  })
})

describe('IssueService.prime (P1a)', () => {
  it('prime renders a bound issue with its children and blockers', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'Epic', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'Child', startNow: false, parentId: epic.id })
    const out = svc.prime({ repoPath: '/r', boundIssueId: epic.id })
    expect(out).toContain('Epic')
    expect(out).toContain(child.title)
    expect(out).toMatch(/discovered-from|Workflow|track work as issues/i)
    expect(out).toContain('reparent')
    expect(out).toContain('--outside-scope')
    expect(out).toContain('operator-only')
  })

  it('prime tells the agent to report worktree moves via `podium worktree`', () => {
    const { svc } = harness()
    const issue = svc.create({ repoPath: '/r', title: 'Bound', startNow: false })
    expect(svc.prime({ repoPath: '/r', boundIssueId: issue.id })).toContain('podium worktree')
    expect(svc.prime({ repoPath: '/r', boundIssueId: null })).toContain('podium worktree')
  })

  it('prime renders a lobby when unbound', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'Ready one', startNow: false })
    const out = svc.prime({ repoPath: '/r', boundIssueId: null })
    expect(out).toMatch(/No issue bound|Ready work/i)
    expect(out).toContain('Ready one')
  })

  it('prime renders structural blockers and parent as #seq (open only)', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'Epic', startNow: false })
    const dep = svc.create({ repoPath: '/r', title: 'Dep', startNow: false })
    const closedDep = svc.create({ repoPath: '/r', title: 'ClosedDep', startNow: false })
    const me = svc.create({ repoPath: '/r', title: 'Me', startNow: false, parentId: epic.id })
    svc.addDep(me.id, dep.id, 'blocks')
    svc.addDep(me.id, closedDep.id, 'blocks')
    // A resolved (closed) blocker no longer blocks — computeBlocked ignores closed
    // targets, so prime's "Blocked by:" line must match and drop it too.
    svc.close(closedDep.id)
    const out = svc.prime({ repoPath: '/r', boundIssueId: me.id })
    expect(out).toContain(`Parent epic: #${epic.seq}`)
    const blockedLine = out.split('\n').find((l) => l.startsWith('Blocked by:'))
    expect(blockedLine).toContain(`#${dep.seq}`)
    expect(blockedLine).not.toContain(`#${closedDep.seq}`)
  })
})

describe('IssueService.purgeEmptyDraft (internal hard-delete seam)', () => {
  it('removes the issue from the list and broadcasts', () => {
    const { svc, store, deps } = harness()
    const a = svc.create({ repoPath: '/r', title: 'gone', startNow: false })
    svc.create({ repoPath: '/r', title: 'stays', startNow: false })
    ;(deps.broadcast as ReturnType<typeof vi.fn>).mockClear()
    svc.purgeEmptyDraft(a.id)
    expect(svc.get(a.id)).toBeNull()
    expect(svc.list('/r').map((w) => w.title)).toEqual(['stays'])
    expect(store.issues.getIssue(a.id)).toBeNull()
    expect(deps.broadcast).toHaveBeenCalled()
  })
  it('throws on unknown id', () => {
    const { svc } = harness()
    expect(() => svc.purgeEmptyDraft('iss_missing')).toThrow()
  })
  it('deleting an issue clears scalar back-references on other issues', () => {
    const { svc, store } = harness()
    const parent = svc.create({ repoPath: '/r', title: 'P', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'C', parentId: parent.id, startNow: false })
    svc.purgeEmptyDraft(parent.id)
    expect(svc.get(child.id)!.parentId).toBeUndefined() // wire omits null parentId
    expect(store.issues.getIssue(child.id)!.parentId).toBeNull()
  })
})

describe('IssueService.issueForCwd (P1b)', () => {
  it('issueForCwd resolves a cwd inside an issue worktree', async () => {
    const { svc } = harness()
    const i = svc.create({ repoPath: '/r', title: 'W', startNow: false })
    await svc.start(i.id) // sets worktreePath
    const wt = svc.get(i.id)!.worktreePath as string
    expect(svc.issueForCwd(wt)).toBe(i.id)
    expect(svc.issueForCwd(`${wt}/sub/dir`)).toBe(i.id)
    expect(svc.issueForCwd('/somewhere/else')).toBeNull()
  })
})

describe('IssueService.resolveRef (display seq → internal id)', () => {
  it('passes internal ids and unknown refs through unchanged', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(svc.resolveRef(w.id)).toBe(w.id)
    expect(svc.resolveRef('garbage')).toBe('garbage')
    expect(svc.resolveRef('999')).toBe('999')
  })

  it('resolves bare and #-prefixed seqs to the internal id', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(svc.resolveRef(String(w.seq))).toBe(w.id)
    expect(svc.resolveRef(`#${w.seq}`)).toBe(w.id)
  })

  it('throws on a seq that exists in several repos (per-repo counters collide)', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r1', title: 'A', startNow: false })
    svc.create({ repoPath: '/r2', title: 'B', startNow: false })
    expect(() => svc.resolveRef('1')).toThrow(/ambiguous issue ref #1/)
  })

  it('resolves repo-qualified refs — the exact form the ambiguity error prints', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/home/u/r1', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/home/u/r2', title: 'B', startNow: false })
    // full repoPath#seq (copy-pasted from the ambiguity error) resolves
    expect(svc.resolveRef(`/home/u/r1#${a.seq}`)).toBe(a.id)
    expect(svc.resolveRef(`/home/u/r2#${b.seq}`)).toBe(b.id)
    // trailing path segment works when unique
    expect(svc.resolveRef(`r1#${a.seq}`)).toBe(a.id)
    // unknown repo-qualified refs fall through unchanged (caller's unknown-issue error fires)
    expect(svc.resolveRef('/nope#1')).toBe('/nope#1')
  })

  it('the ambiguity error is copy-paste actionable: its printed refs resolve', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/home/u/r1', title: 'A', startNow: false })
    svc.create({ repoPath: '/home/u/r2', title: 'B', startNow: false })
    let message = ''
    try {
      svc.resolveRef('1')
    } catch (e) {
      message = (e as Error).message
    }
    const printed = message.match(/\S+#\d+/g) ?? []
    expect(printed.length).toBeGreaterThanOrEqual(2)
    // every ref the error tells the user about must itself resolve
    expect(svc.resolveRef(printed[0]!)).toBe(a.id)
  })

  it('a suffix ref matching several repos throws instead of guessing', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/a/podium', title: 'A', startNow: false })
    svc.create({ repoPath: '/b/podium', title: 'B', startNow: false })
    expect(() => svc.resolveRef('podium#1')).toThrow(/ambiguous issue ref podium#1/)
  })

  it('every id-taking mutation accepts a display seq and persists the INTERNAL id', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })

    // comment: stored against iss_… not the raw seq string
    svc.addComment(String(a.seq), 'agent', 'hello')
    expect(store.issues.listIssueComments(a.id).map((c) => c.body)).toContain('hello')

    // deps: edge rows carry internal ids so blocked/ready derive correctly
    svc.addDep(String(b.seq), `#${a.seq}`, 'blocks')
    expect(svc.get(b.id)?.blocked).toBe(true)
    svc.close(String(a.seq))
    expect(svc.get(b.id)?.ready).toBe(true)

    // labels + update + claim + needs-human by seq
    svc.setLabels(String(b.seq), ['x'])
    expect(svc.get(String(b.seq))?.labels).toContain('x')
    svc.claim(`#${b.seq}`, 'agent:test')
    expect(svc.get(b.id)?.assignee).toBe('agent:test')
    svc.setNeedsHuman(String(b.seq), 'q?')
    expect(svc.get(b.id)?.needsHuman).toBe(true)
  })

  it('reparent + supersede + duplicate resolve BOTH sides (no raw refs in columns)', () => {
    const { svc, store } = harness()
    const parent = svc.create({ repoPath: '/r', title: 'P', type: 'epic', startNow: false })
    const kid = svc.create({ repoPath: '/r', title: 'K', startNow: false })
    const repl = svc.create({ repoPath: '/r', title: 'R', startNow: false })

    svc.reparent(String(kid.seq), `#${parent.seq}`)
    expect(store.issues.getIssue(kid.id)?.parentId).toBe(parent.id)

    svc.supersede(String(kid.seq), String(repl.seq))
    expect(store.issues.getIssue(kid.id)?.supersededBy).toBe(repl.id)

    const dup = svc.create({ repoPath: '/r', title: 'D', startNow: false })
    svc.duplicate(String(dup.seq), `#${repl.seq}`)
    expect(store.issues.getIssue(dup.id)?.duplicateOf).toBe(repl.id)
  })
})

describe('IssueService.cleanup (issue #71)', () => {
  const WT = '/r/.worktrees/issue-1-x'
  const BR = 'issue/1-x'
  const CLEAN_STATUS = '## issue/1-x'

  /** Create a started issue (worktree+branch recorded) and optionally close it. */
  function prepared(h: ReturnType<typeof harness>, opts: { closed?: boolean } = { closed: true }) {
    const w = h.svc.create({ repoPath: '/r', title: 'X', parentBranch: 'main', startNow: false })
    h.svc.update(w.id, { worktreePath: WT, branch: BR })
    if (opts.closed !== false) h.svc.close(w.id)
    return w
  }

  /** Script repoOp per (op) name; records every call for exact-args assertions. */
  function scriptRepoOp(
    deps: IssueDeps,
    impl: Record<string, { ok: boolean; output: string }>,
  ): Array<{ op: string; cwd: string; args?: Record<string, string> }> {
    const calls: Array<{ op: string; cwd: string; args?: Record<string, string> }> = []
    deps.repoOp = vi.fn(async (op, cwd, args) => {
      calls.push({ op, cwd, ...(args ? { args } : {}) })
      return impl[op] ?? { ok: true, output: '' }
    })
    return calls
  }

  it('refuses an OPEN issue with no side effects (no repoOp at all)', async () => {
    const h = harness()
    const w = prepared(h, { closed: false })
    const calls = scriptRepoOp(h.deps, {})
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/still open/)
    expect(calls).toEqual([])
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBe(WT)
    expect(h.store.issues.getIssue(w.id)?.branch).toBe(BR)
  })

  it('refuses when no worktree/branch is recorded', async () => {
    const h = harness()
    const w = h.svc.create({ repoPath: '/r', title: 'X', startNow: false })
    h.svc.close(w.id)
    const calls = scriptRepoOp(h.deps, {})
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/nothing to clean up/)
    expect(calls).toEqual([])
  })

  it('missing worktree on disk: clears the columns, comments, reports already gone', async () => {
    const h = harness()
    const w = prepared(h)
    const calls = scriptRepoOp(h.deps, {
      status: { ok: false, output: `fatal: cannot change to '${WT}': No such file or directory` },
    })
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/already gone/)
    expect(calls.map((c) => c.op)).toEqual(['status']) // nothing destructive ran
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBeNull()
    expect(h.store.issues.getIssue(w.id)?.branch).toBeNull()
    const comments = h.store.issues.listIssueComments(w.id)
    expect(comments.some((c) => c.author === 'system:cleanup' && /already gone/.test(c.body))).toBe(
      true,
    )
    // second call is a clean no-op refusal
    const r2 = await h.svc.cleanup(w.id)
    expect(r2.ok).toBe(false)
    expect(r2.output).toMatch(/nothing to clean up/)
  })

  it('refuses an UNMERGED branch (is-ancestor false) before any destructive op', async () => {
    const h = harness()
    const w = prepared(h)
    const calls = scriptRepoOp(h.deps, {
      status: { ok: true, output: CLEAN_STATUS },
      isMergedInto: { ok: false, output: '' },
    })
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/not fully merged into 'main'/)
    expect(calls.map((c) => c.op)).toEqual(['status', 'isMergedInto'])
    // ancestor check is read-only against the repo ROOT ref db
    expect(calls[1]).toEqual({
      op: 'isMergedInto',
      cwd: '/r',
      args: { branch: BR, parentBranch: 'main' },
    })
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBe(WT)
    expect(h.store.issues.getIssue(w.id)?.branch).toBe(BR)
  })

  it('refuses a DIRTY worktree before any destructive op', async () => {
    const h = harness()
    const w = prepared(h)
    const calls = scriptRepoOp(h.deps, {
      status: { ok: true, output: `${CLEAN_STATUS}\n M src/a.ts\n?? junk.txt` },
    })
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/uncommitted changes/)
    expect(r.output).toContain('M src/a.ts')
    expect(calls.map((c) => c.op)).toEqual(['status', 'isMergedInto'])
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBe(WT)
  })

  it('happy path: exact op sequence, columns cleared, audit comment, event', async () => {
    const h = harness()
    const w = prepared(h)
    const calls = scriptRepoOp(h.deps, { status: { ok: true, output: CLEAN_STATUS } })
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([
      { op: 'status', cwd: WT },
      { op: 'isMergedInto', cwd: '/r', args: { branch: BR, parentBranch: 'main' } },
      { op: 'worktreeRemove', cwd: '/r', args: { path: WT } },
      { op: 'branchDelete', cwd: '/r', args: { branch: BR } },
    ])
    // never touches the root checkout state: no rebase/merge/checkout-style ops at all
    expect(calls.every((c) => !['rebase', 'mergeFfOnly', 'worktreeAdd'].includes(c.op))).toBe(true)
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBeNull()
    expect(h.store.issues.getIssue(w.id)?.branch).toBeNull()
    const comments = h.store.issues.listIssueComments(w.id)
    expect(
      comments.some(
        (c) => c.author === 'system:cleanup' && c.body.includes(WT) && c.body.includes(BR),
      ),
    ).toBe(true)
    const events = h.store.events.listEventsSince(0, { kinds: ['issue.cleaned'] })
    expect(events.length).toBe(1)
  })

  it('partial failure: worktree removed but branch delete refused → precise report, branch kept', async () => {
    const h = harness()
    const w = prepared(h)
    const calls = scriptRepoOp(h.deps, {
      status: { ok: true, output: CLEAN_STATUS },
      branchDelete: { ok: false, output: `error: the branch '${BR}' is not fully merged` },
    })
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/worktree .* removed, but branch delete refused/)
    expect(calls.map((c) => c.op)).toEqual([
      'status',
      'isMergedInto',
      'worktreeRemove',
      'branchDelete',
    ])
    // columns reflect reality: worktree gone, branch still recorded
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBeNull()
    expect(h.store.issues.getIssue(w.id)?.branch).toBe(BR)
    const comments = h.store.issues.listIssueComments(w.id)
    expect(comments.some((c) => c.author === 'system:cleanup' && /NOT deleted/.test(c.body))).toBe(
      true,
    )
  })

  it('worktree remove refused by git: surfaces the message, nothing cleared', async () => {
    const h = harness()
    const w = prepared(h)
    scriptRepoOp(h.deps, {
      status: { ok: true, output: CLEAN_STATUS },
      worktreeRemove: {
        ok: false,
        output: `fatal: '${WT}' contains modified or untracked files, use --force to delete it`,
      },
    })
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/worktree remove failed/)
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBe(WT)
    expect(h.store.issues.getIssue(w.id)?.branch).toBe(BR)
  })
})

describe('IssueService.cleanup follow-ups (retry + strict gone detection)', () => {
  const WT = '/r/.worktrees/issue-1-x'
  const BR = 'issue/1-x'
  const CLEAN_STATUS = '## issue/1-x'

  function prepared(h: ReturnType<typeof harness>) {
    const w = h.svc.create({ repoPath: '/r', title: 'X', parentBranch: 'main', startNow: false })
    h.svc.update(w.id, { worktreePath: WT, branch: BR })
    h.svc.close(w.id)
    return w
  }
  function scriptRepoOp(deps: IssueDeps, impl: Record<string, { ok: boolean; output: string }>) {
    const calls: Array<{ op: string; cwd: string; args?: Record<string, string> }> = []
    deps.repoOp = vi.fn(async (op, cwd, args) => {
      calls.push({ op, cwd, ...(args ? { args } : {}) })
      return impl[op] ?? { ok: true, output: '' }
    })
    return calls
  }

  it('retry after partial failure deletes the branch via the worktree-less path', async () => {
    const h = harness()
    const w = prepared(h)
    scriptRepoOp(h.deps, {
      status: { ok: true, output: CLEAN_STATUS },
      branchDelete: { ok: false, output: `error: the branch '${BR}' is not fully merged` },
    })
    const r1 = await h.svc.cleanup(w.id)
    expect(r1.ok).toBe(false)
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBeNull()
    expect(h.store.issues.getIssue(w.id)?.branch).toBe(BR)

    // second call: parent chain has merged, -d now succeeds
    const calls2 = scriptRepoOp(h.deps, {})
    const r2 = await h.svc.cleanup(w.id)
    expect(r2.ok).toBe(true)
    expect(r2.output).toContain(`deleted branch ${BR}`)
    // worktree-less path: NO status/worktreeRemove — just ancestry + delete
    expect(calls2).toEqual([
      { op: 'isMergedInto', cwd: '/r', args: { branch: BR, parentBranch: 'main' } },
      { op: 'branchDelete', cwd: '/r', args: { branch: BR } },
    ])
    expect(h.store.issues.getIssue(w.id)?.branch).toBeNull()
    const comments = h.store.issues.listIssueComments(w.id)
    expect(
      comments.some((c) => c.author === 'system:cleanup' && /deleted merged branch/.test(c.body)),
    ).toBe(true)
  })

  it('stacked retry still refused by -d gives the precise stacked message, not "nothing to clean up"', async () => {
    const h = harness()
    const w = prepared(h)
    scriptRepoOp(h.deps, {
      status: { ok: true, output: CLEAN_STATUS },
      branchDelete: { ok: false, output: `error: the branch '${BR}' is not fully merged` },
    })
    await h.svc.cleanup(w.id) // partial: worktree removed, branch kept
    const r2 = await h.svc.cleanup(w.id) // retry, -d still refuses (parent not on root HEAD yet)
    expect(r2.ok).toBe(false)
    expect(r2.output).not.toMatch(/nothing to clean up/)
    expect(r2.output).toMatch(/IS merged into 'main'/)
    expect(r2.output).toMatch(/retry cleanup after|delete the branch manually/)
    expect(h.store.issues.getIssue(w.id)?.branch).toBe(BR)
  })

  it('retry path still refuses an unmerged branch', async () => {
    const h = harness()
    const w = prepared(h)
    h.svc.update(w.id, { worktreePath: null }) // simulate branch-only state directly
    const calls = scriptRepoOp(h.deps, { isMergedInto: { ok: false, output: '' } })
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/not fully merged into 'main'/)
    expect(calls.map((c) => c.op)).toEqual(['isMergedInto'])
    expect(h.store.issues.getIssue(w.id)?.branch).toBe(BR)
  })

  it('permission-denied status error REFUSES and keeps the columns (no false already-gone)', async () => {
    const h = harness()
    const w = prepared(h)
    const calls = scriptRepoOp(h.deps, {
      status: { ok: false, output: `fatal: cannot change to '${WT}': Permission denied` },
    })
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/cannot inspect worktree/)
    expect(calls.map((c) => c.op)).toEqual(['status'])
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBe(WT)
    expect(h.store.issues.getIssue(w.id)?.branch).toBe(BR)
  })

  it('"not a working tree" REFUSES with a files-still-on-disk hint', async () => {
    const h = harness()
    const w = prepared(h)
    scriptRepoOp(h.deps, {
      status: { ok: false, output: `fatal: not a working tree: '${WT}'` },
    })
    const r = await h.svc.cleanup(w.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/files are still on disk/)
    expect(h.store.issues.getIssue(w.id)?.worktreePath).toBe(WT)
  })
})

describe('IssueService.integrate (issue #70)', () => {
  const INT_BR = 'integrate/1-e'
  const INT_WT = '/r/.worktrees/integrate-1-e'
  const GONE = {
    ok: false,
    output: `fatal: cannot change to '${INT_WT}': No such file or directory`,
  }

  type Call = { op: string; cwd: string; args?: Record<string, string> }

  /** repoOp stub scripted per call: `impl(op, cwd, args, call#)`; records every call. */
  function scriptOps(
    deps: IssueDeps,
    impl: (
      op: string,
      args?: Record<string, string>,
    ) => { ok: boolean; output: string } | undefined,
  ): Call[] {
    const calls: Call[] = []
    deps.repoOp = vi.fn(async (op, cwd, args) => {
      calls.push({ op, cwd, ...(args ? { args } : {}) })
      return impl(op, args) ?? { ok: true, output: '' }
    })
    return calls
  }

  /** Epic (seq 1, title 'E') + closed children with recorded branches. */
  function epicWith(
    h: ReturnType<typeof harness>,
    kids: Array<{ branch?: string | null; closed?: boolean }>,
  ) {
    const epic = h.svc.create({
      repoPath: '/r',
      title: 'E',
      type: 'epic',
      parentBranch: 'main',
      startNow: false,
    })
    const children = kids.map((k, i) => {
      const c = h.svc.create({ repoPath: '/r', title: `K${i}`, parentId: epic.id, startNow: false })
      if (k.branch !== null) h.svc.update(c.id, { branch: k.branch ?? `issue/${c.seq}-k${i}` })
      if (k.closed !== false) h.svc.close(c.id)
      return h.svc.get(c.id)!
    })
    return { epic, children }
  }

  it('refuses a target with no children (no repoOp at all)', async () => {
    const h = harness()
    const epic = h.svc.create({ repoPath: '/r', title: 'E', type: 'epic', startNow: false })
    const calls = scriptOps(h.deps, () => undefined)
    const r = await h.svc.integrate(epic.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/no children/)
    expect(calls).toEqual([])
  })

  it('refuses when no closed child has a recorded branch', async () => {
    const h = harness()
    const { epic } = epicWith(h, [{ closed: false }, { branch: null, closed: true }])
    const calls = scriptOps(h.deps, () => undefined)
    const r = await h.svc.integrate(epic.id)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/no closed child .* recorded branch/)
    expect(calls).toEqual([])
  })

  it('fresh run: rebuild-reset op order (worktreeAddReset from root, ff merges in worktree), comment + event', async () => {
    const h = harness()
    const { epic, children } = epicWith(h, [{}, {}])
    const calls = scriptOps(h.deps, (op) => (op === 'status' ? GONE : undefined))
    const r = await h.svc.integrate(epic.id)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([
      { op: 'status', cwd: INT_WT },
      {
        op: 'worktreeAddReset',
        cwd: '/r',
        args: { path: INT_WT, branch: INT_BR, startPoint: 'main' },
      },
      { op: 'mergeFfOnly', cwd: INT_WT, args: { branch: children[0]!.branch! } },
      { op: 'mergeFfOnly', cwd: INT_WT, args: { branch: children[1]!.branch! } },
    ])
    // boundary: the ONLY op with the repo root as cwd is the worktree add itself
    expect(calls.filter((c) => c.cwd === '/r').map((c) => c.op)).toEqual(['worktreeAddReset'])
    const comments = h.store.issues.listIssueComments(epic.id)
    expect(comments.filter((c) => c.author === 'system:integrate').length).toBe(1)
    expect(comments[0]!.body).toContain(`rebuilt '${INT_BR}' from 'main'`)
    expect(comments[0]!.body).toContain(`#${children[0]!.seq}, #${children[1]!.seq}`)
    const ev = h.store.events.listEventsSince(0, { kinds: ['issue.integration'] })
    expect(ev.length).toBe(1)
    expect(ev[0]!.payload).toEqual({ epicSeq: 1, integrated: [children[0]!.seq, children[1]!.seq] })
  })

  it('existing worktree: resets the integration branch to the parent tip (checkoutReset), no worktreeAdd', async () => {
    const h = harness()
    const { epic } = epicWith(h, [{}])
    const calls = scriptOps(h.deps, () => undefined) // status ok → worktree exists
    const r = await h.svc.integrate(epic.id)
    expect(r.ok).toBe(true)
    expect(calls[0]).toEqual({ op: 'status', cwd: INT_WT })
    // defensive un-wedge before the reset (result ignored; healthy = "no rebase in progress")
    expect(calls[1]).toEqual({ op: 'rebaseAbort', cwd: INT_WT })
    expect(calls[2]).toEqual({
      op: 'checkoutReset',
      cwd: INT_WT,
      args: { branch: INT_BR, startPoint: 'main' },
    })
    expect(calls.some((c) => c.op === 'worktreeAdd' || c.op === 'worktreeAddReset')).toBe(false)
  })

  it('in-flight guard: a concurrent second integrate() refuses cleanly; exactly one op sequence runs', async () => {
    const h = harness()
    const { epic } = epicWith(h, [{}, {}])
    const calls = scriptOps(h.deps, () => undefined)
    const [r1, r2] = await Promise.all([h.svc.integrate(epic.id), h.svc.integrate(epic.id)])
    const refused = [r1, r2].filter((r) => /integration already running for #1/.test(r.output))
    const ran = [r1, r2].filter((r) => r.ok)
    expect(refused.length).toBe(1)
    expect(ran.length).toBe(1)
    expect(calls.filter((c) => c.op === 'status').length).toBe(1) // one rebuild, not two interleaved
    // guard released: a later run proceeds normally
    const r3 = await h.svc.integrate(epic.id)
    expect(r3.ok).toBe(true)
  })

  it('self-healing: a wedged worktree (failed conflict recovery) is un-wedged by the next run', async () => {
    const h = harness()
    const { epic, children } = epicWith(h, [{}])
    const child = children[0]!
    // Run 1: non-ff, rebase conflicts, and the recovery rebaseAbort ITSELF fails →
    // worktree left mid-rebase.
    let run = 1
    const calls = scriptOps(h.deps, (op, args) => {
      if (run === 1) {
        if (op === 'mergeFfOnly' && args?.branch === child.branch) {
          return { ok: false, output: 'fatal: Not possible to fast-forward, aborting.' }
        }
        if (op === 'rebase')
          return { ok: false, output: 'CONFLICT (content): Merge conflict in src/a.ts' }
        if (op === 'rebaseAbort') return { ok: false, output: 'error: could not abort' }
      }
      return undefined
    })
    const r1 = await h.svc.integrate(epic.id)
    expect(r1.ok).toBe(false)
    // Run 2: worktree exists (status ok) → defensive rebaseAbort BEFORE checkoutReset
    // un-wedges it and the rebuild completes.
    run = 2
    calls.length = 0
    const r2 = await h.svc.integrate(epic.id)
    expect(r2.ok).toBe(true)
    expect(calls.slice(0, 3).map((c) => c.op)).toEqual(['status', 'rebaseAbort', 'checkoutReset'])
  })

  it('topological order: A blocks B ⇒ A integrates first (beats seq order)', async () => {
    const h = harness()
    const { epic, children } = epicWith(h, [{}, {}]) // B=children[0] (seq 2), A=children[1] (seq 3)
    const [b, a] = children
    h.svc.addDep(b!.id, a!.id, 'blocks') // B is blocked by A ⇒ A first
    const calls = scriptOps(h.deps, () => undefined)
    await h.svc.integrate(epic.id)
    const merges = calls.filter((c) => c.op === 'mergeFfOnly').map((c) => c.args?.branch)
    expect(merges).toEqual([a!.branch, b!.branch])
    const ev = h.store.events.listEventsSince(0, { kinds: ['issue.integration'] })
    expect((ev[0]!.payload as { integrated: number[] }).integrated).toEqual([a!.seq, b!.seq])
  })

  it('non-ff child: rebases a TEMP ref (never the child branch) then ff-merges it', async () => {
    const h = harness()
    const { epic, children } = epicWith(h, [{}])
    const child = children[0]!
    const temp = `integrate-tmp/${child.seq}`
    let ffTried = false
    const calls = scriptOps(h.deps, (op, args) => {
      if (op === 'mergeFfOnly' && args?.branch === child.branch && !ffTried) {
        ffTried = true
        return { ok: false, output: 'fatal: Not possible to fast-forward, aborting.' }
      }
      return undefined
    })
    const r = await h.svc.integrate(epic.id)
    expect(r.ok).toBe(true)
    expect(calls.slice(3)).toEqual([
      { op: 'mergeFfOnly', cwd: INT_WT, args: { branch: child.branch! } },
      { op: 'checkoutReset', cwd: INT_WT, args: { branch: temp, startPoint: child.branch! } },
      { op: 'rebase', cwd: INT_WT, args: { parentBranch: INT_BR } },
      { op: 'checkout', cwd: INT_WT, args: { branch: INT_BR } },
      { op: 'mergeFfOnly', cwd: INT_WT, args: { branch: temp } },
      { op: 'branchDeleteForce', cwd: INT_WT, args: { branch: temp } },
    ])
    const ev = h.store.events.listEventsSince(0, { kinds: ['issue.integration'] })
    expect((ev[0]!.payload as { integrated: number[] }).integrated).toEqual([child.seq])
  })

  it('conflict: aborts cleanly, restores the last good head, sets needs_human, stops — later children untouched', async () => {
    const h = harness()
    const { epic, children } = epicWith(h, [{}, {}, {}])
    const [ok1, bad, never] = children
    const temp = `integrate-tmp/${bad!.seq}`
    const calls = scriptOps(h.deps, (op, args) => {
      if (op === 'mergeFfOnly' && args?.branch === bad!.branch) {
        return { ok: false, output: 'fatal: Not possible to fast-forward, aborting.' }
      }
      if (op === 'rebase')
        return {
          ok: false,
          output: 'CONFLICT (content): Merge conflict in src/a.ts\nerror: could not apply abc123',
        }
      return undefined
    })
    const r = await h.svc.integrate(epic.id)
    expect(r.ok).toBe(false)
    // cleanup after the conflicted rebase, in order
    const tail = calls.slice(calls.findIndex((c) => c.op === 'rebase') + 1)
    expect(tail).toEqual([
      { op: 'rebaseAbort', cwd: INT_WT },
      { op: 'checkout', cwd: INT_WT, args: { branch: INT_BR } },
      { op: 'branchDeleteForce', cwd: INT_WT, args: { branch: temp } },
    ])
    // never touches the third child
    expect(calls.some((c) => c.args?.branch === never!.branch)).toBe(false)
    // epic flagged for a human with the precise blocker
    const row = h.store.issues.getIssue(epic.id)!
    expect(row.needsHuman).toBe(true)
    expect(row.humanQuestion).toMatch(new RegExp(`integration blocked at #${bad!.seq}: CONFLICT`))
    // one summary comment: what landed vs what blocked
    const comments = h.store.issues
      .listIssueComments(epic.id)
      .filter((c) => c.author === 'system:integrate')
    expect(comments.length).toBe(1)
    expect(comments[0]!.body).toContain(`integrated #${ok1!.seq}`)
    expect(comments[0]!.body).toContain(`blocked at #${bad!.seq}`)
    const ev = h.store.events.listEventsSince(0, { kinds: ['issue.integration'] })
    expect(ev[0]!.payload).toEqual({ epicSeq: 1, integrated: [ok1!.seq], blockedAt: bad!.seq })
  })

  it('re-run idempotence: unchanged outcome posts NO duplicate comment (events still record each run)', async () => {
    const h = harness()
    const { epic } = epicWith(h, [{}, {}])
    scriptOps(h.deps, () => undefined)
    const r1 = await h.svc.integrate(epic.id)
    const r2 = await h.svc.integrate(epic.id)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(r2.output).toBe(r1.output)
    const comments = h.store.issues
      .listIssueComments(epic.id)
      .filter((c) => c.author === 'system:integrate')
    expect(comments.length).toBe(1)
    const ev = h.store.events.listEventsSince(0, { kinds: ['issue.integration'] })
    expect(ev.length).toBe(2)
    // a CHANGED outcome (new child closes) does comment again
    const extra = h.svc.create({ repoPath: '/r', title: 'K2', parentId: epic.id, startNow: false })
    h.svc.update(extra.id, { branch: 'issue/4-k2' })
    h.svc.close(extra.id)
    await h.svc.integrate(epic.id)
    expect(
      h.store.issues.listIssueComments(epic.id).filter((c) => c.author === 'system:integrate')
        .length,
    ).toBe(2)
  })

  it('closed-but-branchless siblings are skipped, not fatal', async () => {
    const h = harness()
    const { epic, children } = epicWith(h, [{}, { branch: null }])
    const calls = scriptOps(h.deps, () => undefined)
    const r = await h.svc.integrate(epic.id)
    expect(r.ok).toBe(true)
    expect(calls.filter((c) => c.op === 'mergeFfOnly').map((c) => c.args?.branch)).toEqual([
      children[0]!.branch,
    ])
  })
})

describe('IssueService children + depReport (epic ergonomics)', () => {
  it('children lists direct subissues sorted by seq; recursive walks the subtree', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', type: 'epic', startNow: false })
    const c2 = svc.create({ repoPath: '/r', title: 'c2', parentId: epic.id, startNow: false })
    const c1 = svc.create({ repoPath: '/r', title: 'c1', parentId: epic.id, startNow: false })
    const grand = svc.create({ repoPath: '/r', title: 'g', parentId: c1.id, startNow: false })
    svc.create({ repoPath: '/r', title: 'unrelated', startNow: false })
    expect(svc.children(epic.id).map((w) => w.title)).toEqual(['c2', 'c1'])
    expect(svc.children(epic.id, true).map((w) => w.id)).toEqual([c2.id, c1.id, grand.id])
    // seq refs resolve like everywhere else
    expect(svc.children(`#${epic.seq}`).length).toBe(2)
    expect(() => svc.children('iss_nope')).toThrow(/unknown issue/)
  })

  it('depReport over an epic subtree marks ready/blocked and resolves edges', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', type: 'epic', startNow: false })
    const a = svc.create({ repoPath: '/r', title: 'a', parentId: epic.id, startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'b', parentId: epic.id, startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'c', parentId: epic.id, startNow: false })
    svc.addDep(b.id, a.id) // b waits on a
    svc.addDep(c.id, b.id, 'related')
    svc.close(c.id)
    const report = svc.depReport({ id: epic.id })
    expect(report.map((e) => e.seq)).toEqual([epic.seq, a.seq, b.seq, c.seq])
    const byTitle = Object.fromEntries(report.map((e) => [e.title, e]))
    expect(byTitle.a!.ready).toBe(true)
    expect(byTitle.a!.dependents).toEqual([
      { seq: b.seq, title: 'b', type: 'blocks', closed: false },
    ])
    expect(byTitle.b!.blocked).toBe(true)
    expect(byTitle.b!.deps).toEqual([{ seq: a.seq, title: 'a', type: 'blocks', closed: false }])
    expect(byTitle.c!.closed).toBe(true)
    expect(byTitle.c!.ready).toBe(false)
    // a closed blocker unblocks: close a, b becomes ready
    svc.close(a.id)
    const after = svc.depReport({ id: epic.id })
    expect(after.find((e) => e.title === 'b')!.ready).toBe(true)
  })

  it('depReport without id covers the repo', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'x', startNow: false })
    svc.create({ repoPath: '/other', title: 'y', startNow: false })
    expect(svc.depReport({ repoPath: '/r' }).map((e) => e.title)).toEqual(['x'])
    expect(svc.depReport({}).length).toBe(2)
  })
})

describe('IssueService panelApply (agent-published human panel)', () => {
  it('todo ops: add, done, undone, remove, clear — 1-based, bad index throws', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.panelApply(w.id, { op: 'todo-add', text: 'first' })
    const after = svc.panelApply(w.id, { op: 'todo-add', text: 'second' })
    expect(after.panel?.todos).toEqual([
      { text: 'first', done: false },
      { text: 'second', done: false },
    ])
    expect(svc.panelApply(w.id, { op: 'todo-done', index: 2 }).panel?.todos[1]?.done).toBe(true)
    expect(svc.panelApply(w.id, { op: 'todo-undone', index: 2 }).panel?.todos[1]?.done).toBe(false)
    expect(svc.panelApply(w.id, { op: 'todo-remove', index: 1 }).panel?.todos).toEqual([
      { text: 'second', done: false },
    ])
    expect(() => svc.panelApply(w.id, { op: 'todo-done', index: 9 })).toThrow(/no item 9/)
    expect(svc.panelApply(w.id, { op: 'todo-clear' }).panel?.todos).toEqual([])
  })

  it('artifact add replaces same-path entries; deferred add/remove; persists across reload', () => {
    const { svc, store, deps } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    svc.panelApply(w.id, { op: 'artifact-add', path: 'shots/a.png', title: 'v1' })
    const re = svc.panelApply(w.id, { op: 'artifact-add', path: 'shots/a.png', title: 'v2' })
    expect(re.panel?.artifacts).toHaveLength(1)
    expect(re.panel?.artifacts[0]?.title).toBe('v2')
    svc.panelApply(w.id, { op: 'deferred-add', text: 'dark mode later' })
    const wire = svc.panelApply(w.id, { op: 'deferred-remove', index: 1 })
    expect(wire.panel?.deferred).toEqual([])
    // reload from the same store: panel round-trips through the DB
    const svc2 = new IssueService(deps)
    expect(svc2.get(w.id)?.panel?.artifacts[0]?.title).toBe('v2')
    expect(store.issues.getIssue(w.id)?.panel).toContain('a.png')
  })

  it('no panel published → wire has no panel field', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    expect(w.panel).toBeUndefined()
  })
})

describe('IssueService setState (agent-posted current state → activityNotes)', () => {
  it('writes activityNotes + notesUpdatedAt and broadcasts', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    const wire = svc.setState(w.id, 'halfway there; blocked on review')
    expect(wire.activityNotes).toBe('halfway there; blocked on review')
    expect(wire.notesUpdatedAt).toBe('2026-06-30T00:00:00.000Z')
    expect(svc.get(`#${w.seq}`)?.activityNotes).toContain('halfway')
  })
})

describe('IssueService agent mail (#103)', () => {
  it('sendMail stores an unread message and fires the delivery hook', () => {
    const { svc, deps } = harness()
    ;(deps as { onMailSent?: unknown }).onMailSent = vi.fn()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const m = svc.sendMail(`#${a.seq}`, 'issue:#9', 'please rebase')
    expect(m).toMatchObject({ issueId: a.id, fromAuthor: 'issue:#9', status: 'unread' })
    expect(m.id).toMatch(/^msg_/)
    expect(deps.onMailSent).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }), m)
  })

  it('a delivery-hook failure never fails the send', () => {
    const { svc, deps } = harness()
    ;(deps as { onMailSent?: unknown }).onMailSent = vi.fn(() => {
      throw new Error('nudge exploded')
    })
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const m = svc.sendMail(a.id, 'operator', 'hi')
    expect(svc.mailPending(a.id)).toEqual({ unread: 1 })
    expect(m.status).toBe('unread')
  })

  it('mailInbox is read-on-list: returns wasUnread, subsequent lists are read', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.sendMail(a.id, 'operator', 'one')
    const first = svc.mailInbox(a.id)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ wasUnread: true, status: 'read', body: 'one' })
    expect(svc.mailPending(a.id)).toEqual({ unread: 0 })
    const second = svc.mailInbox(a.id)
    expect(second[0]).toMatchObject({ wasUnread: false, status: 'read' })
  })

  it('mailClaim: first wins, second reports claimed=false with the winning message', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const m = svc.sendMail(a.id, 'operator', 'act on this')
    const r1 = svc.mailClaim(m.id, 'issue:#5')
    expect(r1.claimed).toBe(true)
    expect(r1.message).toMatchObject({ status: 'claimed', claimedBy: 'issue:#5' })
    const r2 = svc.mailClaim(m.id, 'issue:#6')
    expect(r2.claimed).toBe(false)
    expect(r2.message.claimedBy).toBe('issue:#5')
    expect(() => svc.mailClaim('msg_nope', 'x')).toThrow(/unknown mail message/)
  })

  it('prime (bound) surfaces the unread mail count', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(svc.prime({ boundIssueId: a.id })).not.toContain('unread mail')
    svc.sendMail(a.id, 'operator', 'x')
    svc.sendMail(a.id, 'operator', 'y')
    expect(svc.prime({ boundIssueId: a.id })).toContain(
      "You have 2 unread mail message(s): run 'podium issue mail inbox'",
    )
  })
})

describe('IssueService surfaces daemon argv-hardening rejections (issue #81)', () => {
  it('action(pr) with a crafted leading-dash branch returns the readable unsafe-ref error', async () => {
    const { svc, deps } = harness()
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.start(c.id)
    // A tampered stored branch column. The mock mirrors the daemon: it builds
    // argv via the real repoOpCommand and returns builder errors as ok:false.
    svc.update(c.id, { branch: '-D' })
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op, _cwd, args) => {
      const cmd = repoOpCommand(op as never, args as never)
      return 'error' in cmd ? { ok: false, output: cmd.error } : { ok: true, output: '' }
    })
    const r = await svc.action(c.id, 'pr')
    expect(r.ok).toBe(false)
    expect(r.output).toBe("unsafe branch: must not start with '-' (got '-D')")
  })
})
