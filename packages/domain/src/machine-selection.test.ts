import { describe, expect, it } from 'vitest'
import { handoffAvailability, handoffSource, handoffTargets } from './machine-selection'

const repos = [
  {
    repoId: 'r1',
    machines: [
      { machineId: 'source', path: '/a' },
      { machineId: 'target', path: '/b' },
    ],
    worktrees: [
      { path: '/a', isMain: true, machineId: 'source' },
      { path: '/a/.worktrees/x', isMain: false, machineId: 'source' },
      { path: '/b', isMain: true, machineId: 'target' },
    ],
  },
]
const agent = (state: 'in' | 'out' | 'unknown', installed = true) => ({
  kind: 'codex',
  installed,
  login: { state },
})
const issue = { branch: 'issue/1-x', worktreePath: '/a/.worktrees/x' }

describe('handoffTargets', () => {
  it('requires another online repo machine with the harness installed and not logged out', () => {
    const session = { cwd: '/a/.worktrees/x', machineId: 'source', agentKind: 'codex' }
    const machines = [
      { id: 'source', online: true, inventory: { agents: [agent('in')] } },
      { id: 'target', online: true, inventory: { agents: [agent('unknown')] } },
      { id: 'offline', online: false, inventory: { agents: [agent('in')] } },
    ]
    expect(handoffTargets(session, repos, machines).map((m) => m.id)).toEqual(['target'])
    expect(
      handoffTargets(session, repos, [{ ...machines[1]!, inventory: { agents: [agent('out')] } }]),
    ).toEqual([])
  })

  it('rejects main checkouts, unsupported harnesses, and missing inventory', () => {
    const target = { id: 'target', online: true }
    expect(
      handoffTargets({ cwd: '/a', machineId: 'source', agentKind: 'codex' }, repos, [target]),
    ).toEqual([])
    expect(
      handoffTargets({ cwd: '/a/.worktrees/x', machineId: 'source', agentKind: 'shell' }, repos, [
        target,
      ]),
    ).toEqual([])
  })

  it('offers a drifted session its issue worktree ([spec:SP-3f7a])', () => {
    const drifted = { cwd: '/a', machineId: 'source', agentKind: 'codex' }
    const machines = [{ id: 'target', online: true, inventory: { agents: [agent('in')] } }]
    expect(handoffTargets(drifted, repos, machines)).toEqual([])
    expect(handoffTargets(drifted, repos, machines, issue).map((m) => m.id)).toEqual(['target'])
  })
})

describe('handoffSource ([spec:SP-3f7a])', () => {
  const at = (cwd: string, machineId = 'source') => ({ cwd, machineId, agentKind: 'codex' })

  it('resolves the worktree CONTAINING the cwd, carrying the subpath', () => {
    expect(handoffSource(at('/a/.worktrees/x/apps/web'), repos)).toMatchObject({
      worktreePath: '/a/.worktrees/x',
      subpath: 'apps/web',
      via: 'cwd',
    })
    expect(handoffSource(at('/a/.worktrees/x'), repos)).toMatchObject({
      worktreePath: '/a/.worktrees/x',
      subpath: '',
      via: 'cwd',
    })
  })

  it('never sources a main checkout, at its root or in a subdir', () => {
    expect(handoffSource(at('/a'), repos)).toBeNull()
    expect(handoffSource(at('/a/apps/web'), repos)).toBeNull()
    // Even with an issue attached, the issue's own worktree is the source — the
    // main checkout is never handed off, and the drifted subpath is not carried.
    expect(handoffSource(at('/a/apps/web'), repos, issue)).toMatchObject({
      worktreePath: '/a/.worktrees/x',
      subpath: '',
      via: 'issue',
    })
  })

  it('falls back to the issue worktree only when it exists on the session machine', () => {
    expect(handoffSource(at('/a'), repos, issue)).toMatchObject({ via: 'issue' })
    // Issue with a branch but no worktree, and a worktree the scan doesn't know.
    expect(handoffSource(at('/a'), repos, { branch: 'issue/1-x', worktreePath: null })).toBeNull()
    expect(
      handoffSource(at('/a'), repos, { branch: 'issue/1-x', worktreePath: '/a/.worktrees/gone' }),
    ).toBeNull()
    // The issue's worktree lives on another machine.
    expect(handoffSource(at('/a', 'target'), repos, issue)).toBeNull()
  })

  it('anchors on the worktree even when the issue has no branch recorded', () => {
    // The handoff reads its branch from git in the worktree, so a null issue
    // branch is a bookkeeping gap, not a missing workspace (live data: 19
    // sessions sit on issues with a worktree and no branch).
    expect(
      handoffSource(at('/a'), repos, { branch: null, worktreePath: '/a/.worktrees/x' }),
    ).toMatchObject({ worktreePath: '/a/.worktrees/x', via: 'issue' })
  })

  it('never anchors on an issue whose worktreePath IS the main checkout', () => {
    // Live data has exactly this: an issue row pointing at the repo root.
    expect(handoffSource(at('/a'), repos, { branch: 'main', worktreePath: '/a' })).toBeNull()
  })

  it('prefers the cwd worktree over the issue worktree', () => {
    const sibling = { branch: 'issue/2-y', worktreePath: '/a/.worktrees/y' }
    const withSibling = [
      {
        ...repos[0]!,
        worktrees: [
          ...repos[0]!.worktrees,
          { path: '/a/.worktrees/y', isMain: false, machineId: 'source' },
        ],
      },
    ]
    expect(handoffSource(at('/a/.worktrees/x'), withSibling, sibling)).toMatchObject({
      worktreePath: '/a/.worktrees/x',
      via: 'cwd',
    })
  })

  it('returns null when the cwd is outside every known repo', () => {
    expect(handoffSource(at('/tmp/scratch'), repos, issue)).toBeNull()
  })
})

describe('handoffAvailability (POD-821)', () => {
  const session = { cwd: '/a/.worktrees/x', machineId: 'source', agentKind: 'codex' }

  it('names the blocker that stops a session moving anywhere', () => {
    const machines = [{ id: 'target', online: true, inventory: { agents: [agent('in')] } }]
    expect(handoffAvailability({ ...session, agentKind: 'shell' }, repos, machines)).toEqual({
      blocker: 'harness',
      candidates: [],
    })
    // Main checkout, no issue to anchor on.
    expect(handoffAvailability({ ...session, cwd: '/a' }, repos, machines)).toEqual({
      blocker: 'no-worktree',
      candidates: [],
    })
    const noId = [{ ...repos[0]!, repoId: undefined }]
    expect(handoffAvailability(session, noId, machines)).toEqual({
      blocker: 'repo-unregistered',
      candidates: [],
    })
  })

  it('reports every other repo machine with its rejection, and none for the eligible', () => {
    const machines = [
      { id: 'source', online: true, inventory: { agents: [agent('in')] } },
      { id: 'target', online: true, inventory: { agents: [agent('in')] } },
    ]
    // The session's own machine is never a candidate — it is not a refusal to explain.
    expect(handoffAvailability(session, repos, machines)).toEqual({
      candidates: [{ machine: machines[1] }],
    })
    const rejected = <T>(list: T[]): unknown[] =>
      handoffAvailability(session, repos, list as never).candidates.map((c) => c.rejection)
    expect(
      rejected([{ id: 'target', online: false, inventory: { agents: [agent('in')] } }]),
    ).toEqual(['offline'])
    expect(
      rejected([{ id: 'target', online: true, inventory: { agents: [agent('out')] } }]),
    ).toEqual(['logged-out'])
    expect(
      rejected([{ id: 'target', online: true, inventory: { agents: [agent('in', false)] } }]),
    ).toEqual(['harness-missing'])
    // No inventory at all reads as "the harness isn't there", not as eligible.
    expect(rejected([{ id: 'target', online: true }])).toEqual(['harness-missing'])
    // Offline wins over a stale inventory: being offline is the actionable fact.
    expect(
      rejected([{ id: 'target', online: false, inventory: { agents: [agent('out')] } }]),
    ).toEqual(['offline'])
  })

  it('offers no candidates when no other machine has the repo', () => {
    expect(
      handoffAvailability(session, repos, [
        { id: 'source', online: true, inventory: { agents: [agent('in')] } },
        { id: 'stranger', online: true, inventory: { agents: [agent('in')] } },
      ]),
    ).toEqual({ candidates: [] })
  })

  it('a session on a worktree the scan has not seen yet is blocked, not silently empty', () => {
    // POD-821 live repro: the handoff import ran `git worktree add` on the target,
    // so the moved session's cwd is a worktree absent from the client's repo list.
    // Its cwd is then merely CONTAINED by the target's main checkout, and the issue
    // still anchors on the SOURCE machine's worktree — the gate finds no source.
    const macSession = { cwd: '/b/.worktrees/x', machineId: 'target', agentKind: 'codex' }
    const staleIssue = { branch: 'issue/1-x', worktreePath: '/a/.worktrees/x' }
    const machines = [{ id: 'source', online: true, inventory: { agents: [agent('in')] } }]
    expect(handoffAvailability(macSession, repos, machines, staleIssue)).toEqual({
      blocker: 'no-worktree',
      candidates: [],
    })
    // Once the worktree is known, the cwd layer resolves it and the stale issue
    // anchor stops mattering — a refreshed repo list alone restores the menu.
    const fresh = [
      {
        ...repos[0]!,
        worktrees: [
          ...repos[0]!.worktrees,
          { path: '/b/.worktrees/x', isMain: false, machineId: 'target' },
        ],
      },
    ]
    expect(handoffAvailability(macSession, fresh, machines, staleIssue)).toEqual({
      candidates: [{ machine: machines[0] }],
    })
  })
})
