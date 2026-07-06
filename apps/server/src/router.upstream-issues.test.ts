import type { IssueWire } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { OPERATOR, SCOPED_TARGET } from './issue-authz'
import type { IssueUpstreamForwarder } from './relay'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

// Router-level forwarding detection (docs/spec/node-hub-issues.md §2.2): EVERY
// issues.* write proc targeting a viaHub id routes to the UpstreamForwarder
// instead of the local IssueService; local targets are untouched; constrained
// (agent) capabilities are gated off hub issues entirely; issues.create stays
// local and rejects hub-only repoPaths.

const HUB_ID = 'iss_hub1'
const HUB_REPO = '/hub/only/repo'

function hubIssue(id: string): IssueWire {
  return {
    id,
    repoPath: HUB_REPO,
    seq: 1,
    title: 'hub issue',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: 't',
    updatedAt: 't',
    archived: false,
    origin: 'human' as const,
    draft: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
  }
}

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function makeNode(repoPaths: string[] = []) {
  const registry = new SessionRegistry()
  registries.push(registry)
  registry.attachDaemon('local', () => {})
  const forwarded: { proc: string; input: Record<string, unknown> }[] = []
  const forwarder: IssueUpstreamForwarder = {
    async forward(proc, input) {
      forwarded.push({ proc, input })
      return { queued: true }
    },
    entries: () => [],
  }
  registry.setUpstreamForwarder(forwarder)
  registry.setUpstreamIssues([hubIssue(HUB_ID)])
  const caller = (capability = OPERATOR, overrideScope?: boolean) =>
    appRouter.createCaller({
      registry,
      repos: { list: () => repoPaths } as never,
      superagent: {} as never,
      capability,
      ...(overrideScope !== undefined ? { overrideScope } : {}),
    })
  return { registry, forwarded, caller }
}

/** Minimal valid input per write proc, targeting the hub issue. Keyed to
 *  SCOPED_TARGET so a NEW write proc fails the completeness assertion below
 *  until it gets a forwarding test input. */
const FORWARD_INPUTS: Record<string, Record<string, unknown>> = {
  claim: { id: HUB_ID, assignee: 'me' },
  update: { id: HUB_ID, patch: { title: 'T' } },
  close: { id: HUB_ID },
  defer: { id: HUB_ID, until: null },
  setNeedsHuman: { id: HUB_ID },
  clearNeedsHuman: { id: HUB_ID },
  addComment: { id: HUB_ID, author: 'op', body: 'hi' },
  panelApply: { id: HUB_ID, op: 'todo-add', text: 'x' },
  setState: { id: HUB_ID, text: 'x' },
  action: { id: HUB_ID, kind: 'rebase' },
  applySuggestion: { id: HUB_ID },
  dismissSuggestion: { id: HUB_ID },
  refreshAssistant: { id: HUB_ID },
  start: { id: HUB_ID },
  addSession: { id: HUB_ID },
  addShell: { id: HUB_ID },
  depAdd: { fromId: HUB_ID, toId: 'iss_other' },
  archive: { id: HUB_ID },
  delete: { id: HUB_ID },
  setLabels: { id: HUB_ID, labels: ['x'] },
  reparent: { id: HUB_ID, parentId: null },
  depRemove: { fromId: HUB_ID, toId: 'iss_other' },
  supersede: { oldId: HUB_ID, newId: 'iss_other' },
  duplicate: { id: HUB_ID, canonicalId: 'iss_other' },
}

/** Write procs deliberately EXCLUDED from hub forwarding, with the reason. cleanup
 *  acts on LOCAL git state (worktree dir + branch via this node's daemon) — the hub
 *  cannot clean this node's worktree, so its router proc refuses viaHub ids instead
 *  of forwarding (see the cleanup proc in router.ts). Tested below. */
const NOT_FORWARDED = new Set(['cleanup', 'integrate'])

describe('viaHub forwarding detection (per proc)', () => {
  it('covers every SCOPED_TARGET write proc (forwarded or explicitly excluded)', () => {
    const covered = [...Object.keys(FORWARD_INPUTS), ...NOT_FORWARDED].sort()
    expect(covered).toEqual(Object.keys(SCOPED_TARGET).sort())
  })

  it('issues.cleanup on a viaHub id REFUSES (local-only; never forwards)', async () => {
    const { forwarded, caller } = makeNode()
    await expect(caller().issues.cleanup({ id: HUB_ID })).rejects.toThrow(/cleanup is local-only/)
    expect(forwarded).toHaveLength(0)
  })

  it('issues.integrate on a viaHub id REFUSES (local-only; never forwards)', async () => {
    const { forwarded, caller } = makeNode()
    await expect(caller().issues.integrate({ id: HUB_ID })).rejects.toThrow(
      /integrate is local-only/,
    )
    expect(forwarded).toHaveLength(0)
  })

  for (const [proc, input] of Object.entries(FORWARD_INPUTS)) {
    it(`issues.${proc} on a viaHub id forwards (and returns { queued: true } offline)`, async () => {
      const { forwarded, caller } = makeNode()
      const procs = caller().issues as unknown as Record<
        string,
        (i: Record<string, unknown>) => Promise<unknown>
      >
      const res = await procs[proc]?.(input)
      expect(res).toEqual({ queued: true })
      expect(forwarded).toHaveLength(1)
      expect(forwarded[0]?.proc).toBe(proc)
      // Invariant 2: the forwarded input carries a mutationId.
      expect(typeof forwarded[0]?.input.mutationId).toBe('string')
    })
  }
})

describe('viaHub forwarding boundaries', () => {
  it('a LOCAL target never forwards (IssueService handles it as before)', async () => {
    const { forwarded, caller } = makeNode()
    const c = caller()
    const local = await c.issues.create({ repoPath: '/r', title: 'mine', startNow: false })
    const moved = await c.issues.update({ id: local.id, patch: { stage: 'planning' } })
    if ('queued' in moved) throw new Error('local update unexpectedly queued')
    expect(moved.stage).toBe('planning')
    expect(forwarded).toHaveLength(0)
  })

  it('constrained (agent) capabilities are FORBIDDEN on hub issues — no autonomous viaHub actions', async () => {
    const { forwarded, caller } = makeNode()
    const agent = caller({ role: 'worker', scope: { kind: 'subtree', rootId: 'iss_local_root' } })
    await expect(agent.issues.update({ id: HUB_ID, patch: { title: 'nope' } })).rejects.toThrow(
      /managed via the hub/,
    )
    // Not even --outside-scope overrides the hub gate (it is not a scope confirm).
    const overriding = caller(
      { role: 'worker', scope: { kind: 'subtree', rootId: 'iss_local_root' } },
      true,
    )
    await expect(overriding.issues.close({ id: HUB_ID })).rejects.toThrow(/managed via the hub/)
    expect(forwarded).toHaveLength(0)
  })

  it('the role gate still applies to forwarded writes (viewer cannot write hub issues)', async () => {
    const { forwarded, caller } = makeNode()
    const viewer = caller({ role: 'viewer', scope: { kind: 'all' } })
    await expect(viewer.issues.update({ id: HUB_ID, patch: {} })).rejects.toThrow(/not allowed/)
    expect(forwarded).toHaveLength(0)
  })

  it('issues.create stays local: a hub-only repoPath is rejected with a clear error', async () => {
    const { caller } = makeNode(['/local/repo'])
    const c = caller()
    await expect(
      c.issues.create({ repoPath: HUB_REPO, title: 'nope', startNow: false }),
    ).rejects.toThrow(/exists only on the hub/)
    // A locally-known repo (even if the hub ALSO has issues for it) creates fine.
    const ok = await c.issues.create({ repoPath: '/local/repo', title: 'fine', startNow: false })
    expect(ok.title).toBe('fine')
  })
})
