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
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    broadcast: vi.fn(),
    now: () => '2026-06-30T00:00:00.000Z',
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
  it('creates a worktree off parent, spawns the agent with the description as initialPrompt, moves to planning', async () => {
    const { svc, deps } = harness()
    const created = svc.create({ repoPath: '/r', title: 'Fix login', description: 'do the thing', startNow: false })
    const started = await svc.start(created.id)
    expect(started.stage).toBe('planning')
    expect(started.branch).toBe('issue/1-fix-login')
    expect(started.worktreePath).toBe('/r/.worktrees/issue-1-fix-login')
    expect(deps.repoOp).toHaveBeenCalledWith('worktreeAdd', '/r',
      { path: '/r/.worktrees/issue-1-fix-login', branch: 'issue/1-fix-login', startPoint: 'main' })
    expect(deps.spawnSession).toHaveBeenCalledWith({
      cwd: '/r/.worktrees/issue-1-fix-login',
      agentKind: 'claude-code',
      initialPrompt: 'do the thing',
    })
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
    store.addIssueDep(a.id, b.id, 'blocks')
    const reloaded = svc.get(a.id)!
    expect(reloaded.blocked).toBe(true)
    expect(reloaded.ready).toBe(false)
    expect(reloaded.deps).toEqual([{ id: b.id, type: 'blocks' }])
  })

  it('closing the blocker (stage=done) unblocks the dependent', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    store.addIssueDep(a.id, b.id, 'blocks')
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

describe('IssueService field mutations (P1)', () => {
  it('setLabels persists and surfaces on the wire', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(svc.setLabels(a.id, ['ui', 'p1']).labels).toEqual(['p1', 'ui'])
  })

  it('addComment appends a comment', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const w = svc.addComment(a.id, 'mike', 'looks good')
    expect(w.comments.map((c) => c.body)).toEqual(['looks good'])
    expect(w.comments[0]!.author).toBe('mike')
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

  it('reparent maintains a parent-child edge', () => {
    const { svc, store } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    svc.reparent(child.id, epic.id)
    expect(store.listIssueDeps(child.id)).toEqual([{ toId: epic.id, type: 'parent-child' }])
    svc.reparent(child.id, null)
    expect(store.listIssueDeps(child.id)).toEqual([])
  })
})

describe('IssueService hierarchy reconciliation (P2a / I2)', () => {
  it('create({parentId}) maintains the parent-child edge AND childCount', () => {
    const { svc, store } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'C', parentId: epic.id, startNow: false })
    expect(store.listIssueDeps(child.id)).toEqual([{ toId: epic.id, type: 'parent-child' }])
    expect(svc.get(child.id)!.deps).toEqual([{ id: epic.id, type: 'parent-child' }])
    expect(svc.get(epic.id)!.dependents).toEqual([{ id: child.id, type: 'parent-child' }])
    expect(svc.get(epic.id)!.childCount).toBe(1)
  })

  it('update({parentId}) maintains the edge; changing parent moves the edge', () => {
    const { svc, store } = harness()
    const e1 = svc.create({ repoPath: '/r', title: 'E1', startNow: false })
    const e2 = svc.create({ repoPath: '/r', title: 'E2', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    svc.update(c.id, { parentId: e1.id })
    expect(store.listIssueDeps(c.id)).toEqual([{ toId: e1.id, type: 'parent-child' }])
    svc.update(c.id, { parentId: e2.id })
    expect(store.listIssueDeps(c.id)).toEqual([{ toId: e2.id, type: 'parent-child' }])
    svc.update(c.id, { parentId: null })
    expect(store.listIssueDeps(c.id)).toEqual([])
  })

  it('a parentId change that forms a cycle is rejected via create or update', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', parentId: a.id, startNow: false })
    expect(() => svc.update(a.id, { parentId: b.id })).toThrow(/cycle/)
  })
})
