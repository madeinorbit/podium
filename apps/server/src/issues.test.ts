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
    expect(deps.repoOp).toHaveBeenCalledWith('rebase', '/r/.worktrees/issue-1-x', { parentBranch: 'main' })
  })

  it('pr captures the PR url from output', async () => {
    const { svc, deps, id } = await started()
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, output: 'https://github.com/o/r/pull/42' })
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
  async function mergedBranch(statusOutput: string): Promise<{ ok: boolean; output: string; calls: string[] }> {
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

describe('IssueService assistant', () => {
  function harnessWithLlm(json: string) {
    const { deps } = harness([])
    deps.llm = (() => ({ label: 'fake', complete: async () => ({ text: json, toolCalls: [] }) })) as never
    deps.repoOp = vi.fn(async (op: string) => ({ ok: true, output: op === 'status' ? '## issue/1-x' : 'abc plan' })) as never
    deps.getSettings = (() => ({
      gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
      sessionDefaults: { agent: 'claude-code' }, integrations: { linearApiKey: '' },
      issues: { assistantEnabled: true }, workLlm: { kind: 'api', provider: 'openrouter', model: 'm' }, apiKeys: {},
    })) as never
    return { svc: new IssueService(deps), deps }
  }

  it('refreshAssistant writes activity notes + suggestion and broadcasts', async () => {
    const { svc } = harnessWithLlm('{"activityNotes":"making progress","suggestedStage":"in_progress","suggestedReason":"plan done","blockedBy":[],"dependencyNote":""}')
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(c.id, { worktreePath: '/r/wt', branch: 'issue/1-x', stage: 'planning' })
    const wire = await svc.refreshAssistant(c.id)
    expect(wire.activityNotes).toBe('making progress')
    expect(wire.suggestedStage).toBe('in_progress')
  })

  it('applySuggestion moves the stage and clears the suggestion', async () => {
    const { svc } = harnessWithLlm('{"activityNotes":"x","suggestedStage":"in_progress","suggestedReason":"r","blockedBy":[],"dependencyNote":""}')
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(c.id, { worktreePath: '/r/wt', branch: 'issue/1-x', stage: 'planning' })
    await svc.refreshAssistant(c.id)
    const moved = svc.applySuggestion(c.id)
    expect(moved.stage).toBe('in_progress')
    expect(moved.suggestedStage).toBeUndefined()
  })

  it('dismissSuggestion clears without moving', async () => {
    const { svc } = harnessWithLlm('{"activityNotes":"x","suggestedStage":"in_progress","suggestedReason":"r","blockedBy":[],"dependencyNote":""}')
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(c.id, { worktreePath: '/r/wt', branch: 'issue/1-x', stage: 'planning' })
    await svc.refreshAssistant(c.id)
    const d = svc.dismissSuggestion(c.id)
    expect(d.stage).toBe('planning')
    expect(d.suggestedStage).toBeUndefined()
  })
})
