import { describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@podium/protocol'
import { SessionStore } from './store'
import { IssueService, type IssueDeps } from './issues'

function harness(sessions: SessionMeta[] = []) {
  const store = new SessionStore(':memory:')
  const deps: IssueDeps = {
    store,
    listSessions: () => sessions,
    getSettings: () => ({ gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true }, sessionDefaults: { agent: 'claude-code' } }) as never,
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    seedDraft: vi.fn(),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    broadcast: vi.fn(),
    now: () => 't0',
  }
  return { store, deps, svc: new IssueService(deps) }
}

const sess = (cwd: string, phase = 'working'): SessionMeta =>
  ({ sessionId: cwd, agentKind: 'claude-code', title: 't', cwd, status: 'live', controllerId: null,
     geometry: { cols: 80, rows: 24 }, epoch: 0, clientCount: 0, createdAt: 't', lastActiveAt: 't',
     origin: { kind: 'spawn' }, archived: false, agentState: { phase, since: 't', openTaskCount: 0 } }) as unknown as SessionMeta

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
    const { svc } = harness([sess('/r/wt', 'working'), sess('/r/wt/pkg', 'idle'), sess('/elsewhere')])
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
})

describe('IssueService.start', () => {
  it('creates a worktree off parent, spawns the agent, seeds the draft, moves to planning', async () => {
    const { svc, deps } = harness()
    const created = svc.create({ repoPath: '/r', title: 'Fix login', description: 'do the thing', startNow: false })
    const started = await svc.start(created.id)
    expect(started.stage).toBe('planning')
    expect(started.branch).toBe('issue/1-fix-login')
    expect(started.worktreePath).toBe('/r/.worktrees/issue-1-fix-login')
    expect(deps.repoOp).toHaveBeenCalledWith('worktreeAdd', '/r',
      { path: '/r/.worktrees/issue-1-fix-login', branch: 'issue/1-fix-login', startPoint: 'main' })
    expect(deps.spawnSession).toHaveBeenCalledWith({ cwd: '/r/.worktrees/issue-1-fix-login', agentKind: 'claude-code' })
    expect(deps.seedDraft).toHaveBeenCalledWith('s1', 'do the thing')
  })

  it('create(startNow=true) starts immediately', async () => {
    const { svc } = harness()
    const wire = await svc.createAndMaybeStart({ repoPath: '/r', title: 'X', startNow: true })
    expect(wire.stage).toBe('planning')
    expect(wire.worktreePath).not.toBeNull()
  })

  it('start fails clearly when the worktree op fails', async () => {
    const { svc, deps } = harness()
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, output: 'fatal: branch exists' })
    const created = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await expect(svc.start(created.id)).rejects.toThrow(/fatal: branch exists/)
  })
})
