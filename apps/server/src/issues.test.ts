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
  it('creates a worktree off parent, spawns the agent with the description as initialPrompt, moves to in_progress', async () => {
    const { svc, deps } = harness()
    const created = svc.create({ repoPath: '/r', title: 'Fix login', description: 'do the thing', startNow: false })
    const started = await svc.start(created.id)
    expect(started.stage).toBe('in_progress')
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
    expect(wire.stage).toBe('in_progress')
    expect(wire.worktreePath).not.toBeNull()
  })

  it('start fails clearly when the worktree op fails', async () => {
    const { svc, deps } = harness()
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, output: 'fatal: branch exists' })
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

  it('ancestorIds walks the parent chain nearest-first', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'epic', startNow: false })
    const mid = svc.create({ repoPath: '/r', title: 'mid', startNow: false, parentId: epic.id })
    const leaf = svc.create({ repoPath: '/r', title: 'leaf', startNow: false, parentId: mid.id })
    expect(svc.ancestorIds(leaf.id)).toEqual([mid.id, epic.id])
    expect(svc.ancestorIds(epic.id)).toEqual([])
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

  it('a cycle-throw on reparent leaves the old parent edge + column intact (no divergence)', () => {
    const { svc, store } = harness()
    const old = svc.create({ repoPath: '/r', title: 'OLD', startNow: false })
    const x = svc.create({ repoPath: '/r', title: 'X', parentId: old.id, startNow: false })
    const nw = svc.create({ repoPath: '/r', title: 'NEW', parentId: x.id, startNow: false })
    // OLD <- X <- NEW. Reparenting X under its descendant NEW must throw AND change nothing.
    expect(() => svc.update(x.id, { parentId: nw.id })).toThrow(/cycle/)
    expect(store.listIssueDeps(x.id)).toEqual([{ toId: old.id, type: 'parent-child' }])
    expect(svc.get(x.id)!.parentId).toBe(old.id)
    expect(svc.get(old.id)!.dependents).toContainEqual({ id: x.id, type: 'parent-child' })
  })

  it('addDep rejects parent-child (reparent owns the hierarchy edge)', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    expect(() => svc.addDep(a.id, b.id, 'parent-child')).toThrow(/parent-child/)
  })

  it('removeDep rejects explicit parent-child and leaves the edge intact', () => {
    const { svc, store } = harness()
    const e = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', parentId: e.id, startNow: false })
    expect(() => svc.removeDep(c.id, e.id, 'parent-child')).toThrow(/parent-child/)
    expect(store.listIssueDeps(c.id)).toEqual([{ toId: e.id, type: 'parent-child' }])
  })

  it('removeDep with no type removes other dep types but preserves parent-child', () => {
    const { svc, store } = harness()
    const e = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', parentId: e.id, startNow: false })
    store.addIssueDep(c.id, e.id, 'related') // a second edge on the same pair
    svc.removeDep(c.id, e.id) // no type → bulk
    expect(store.listIssueDeps(c.id)).toEqual([{ toId: e.id, type: 'parent-child' }])
  })
})

describe('IssueService ready/blocked lists (P2a)', () => {
  it('readyList returns only ready issues, priority then seq ordered', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', priority: 3, startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', priority: 0, startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    store.addIssueDep(a.id, c.id, 'blocks') // a blocked by open c
    svc.update(c.id, {}) // no-op to ensure persisted
    const ready = svc.readyList('/r').map((w) => w.title)
    expect(ready).toEqual(['B', 'C']) // A is blocked; B(p0) before C(p2)
  })

  it('blockedList returns only blocked issues', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    store.addIssueDep(a.id, b.id, 'blocks')
    expect(svc.blockedList('/r').map((w) => w.title)).toEqual(['A'])
  })
})

describe('IssueService graph (P2a)', () => {
  it('returns nodes for repo issues and edges from issue_deps', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.create({ repoPath: '/other', title: 'X', startNow: false })
    store.addIssueDep(a.id, b.id, 'blocks')
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
    expect(svc.epicStatus(epic.id)).toEqual({ id: epic.id, childCount: 2, childDoneCount: 0, complete: false })
    expect(svc.closeEligibleEpics('/r')).toEqual([])
    svc.close(c1.id)
    svc.close(c2.id)
    expect(svc.epicStatus(epic.id)).toEqual({ id: epic.id, childCount: 2, childDoneCount: 2, complete: true })
    expect(svc.closeEligibleEpics('/r').map((w) => w.id)).toEqual([epic.id])
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
    expect(store.listIssueDeps(oldI.id)).toEqual([{ toId: newI.id, type: 'supersedes' }])
  })

  it('duplicate closes id with reason + duplicateOf + related dep', () => {
    const { svc, store } = harness()
    const dup = svc.create({ repoPath: '/r', title: 'dup', startNow: false })
    const canon = svc.create({ repoPath: '/r', title: 'canon', startNow: false })
    const w = svc.duplicate(dup.id, canon.id)
    expect(w.closedReason).toBe('duplicate')
    expect(w.duplicateOf).toBe(canon.id)
    expect(store.listIssueDeps(dup.id)).toEqual([{ toId: canon.id, type: 'related' }])
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
    svc.create({ repoPath: '/r', title: 'Fix login bug', description: 'cannot sign in', startNow: false })
    svc.create({ repoPath: '/r', title: 'Fix login bug', description: 'cannot sign in', startNow: false })
    svc.create({ repoPath: '/r', title: 'Add dark mode', description: 'theme toggle', startNow: false })
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
    const row = store.getIssue(a.id)!
    row.updatedAt = '2000-01-01T00:00:00.000Z'
    store.upsertIssue(row)
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
    expect(svc.search({ repoPath: '/r', text: 'login' }).map((w) => w.title).sort())
      .toEqual(['Login done', 'Login fails'])
    expect(svc.search({ repoPath: '/r', text: 'login', status: 'open' }).map((w) => w.title))
      .toEqual(['Login fails'])
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
    store.addIssueDep(a.id, 'iss_ghost', 'blocks') // target does not exist
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

describe('IssueService.delete (P4b)', () => {
  it('removes the issue from the list and broadcasts', () => {
    const { svc, store, deps } = harness()
    const a = svc.create({ repoPath: '/r', title: 'gone', startNow: false })
    svc.create({ repoPath: '/r', title: 'stays', startNow: false })
    ;(deps.broadcast as ReturnType<typeof vi.fn>).mockClear()
    svc.delete(a.id)
    expect(svc.get(a.id)).toBeNull()
    expect(svc.list('/r').map((w) => w.title)).toEqual(['stays'])
    expect(store.getIssue(a.id)).toBeNull()
    expect(deps.broadcast).toHaveBeenCalled()
  })
  it('throws on unknown id', () => {
    const { svc } = harness()
    expect(() => svc.delete('iss_missing')).toThrow()
  })
  it('deleting an issue clears scalar back-references on other issues', () => {
    const { svc, store } = harness()
    const parent = svc.create({ repoPath: '/r', title: 'P', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'C', parentId: parent.id, startNow: false })
    svc.delete(parent.id)
    expect(svc.get(child.id)!.parentId).toBeUndefined() // wire omits null parentId
    expect(store.getIssue(child.id)!.parentId).toBeNull()
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
