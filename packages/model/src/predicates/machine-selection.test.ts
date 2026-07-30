import { describe, expect, it } from 'vitest'
import {
  agentCapabilityRejection,
  handoffAvailability,
  handoffSource,
  handoffTargets,
  machinesForAgent,
  machinesForRepoOrClone,
  onlineMachinesForRepoOrClone,
  resolveTargetMachineForAgent,
} from './machine-selection'

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

describe('agent machine capability', () => {
  const repo = {
    machines: [
      { machineId: 'a', path: '/a' },
      { machineId: 'b', path: '/b' },
    ],
  }
  const sessions = [{ machineId: 'a', createdAt: '2026-01-02' }]

  it('requires an online installed harness that is not explicitly logged out', () => {
    expect(agentCapabilityRejection({ id: 'a', online: false }, 'codex')).toBe('offline')
    expect(agentCapabilityRejection({ id: 'a', online: true }, 'codex')).toBe('harness-missing')
    expect(
      agentCapabilityRejection(
        { id: 'a', online: true, inventory: { agents: [agent('out')] } },
        'codex',
      ),
    ).toBe('logged-out')
    expect(
      agentCapabilityRejection(
        { id: 'a', online: true, inventory: { agents: [agent('unknown')] } },
        'codex',
      ),
    ).toBeUndefined()
  })

  // POD-303 / readiness §3.1.4 M5: "an unreachable-vs-unauthorized distinction
  // must be visible, since 'denied' and 'offline' produce the same empty list
  // otherwise". These four cases are the shape that makes the distinction real,
  // and each fixture carries the COUNTERFACTUAL — the machine that would have
  // been accepted, or refused for the other reason.
  it('refuses a denied machine as unauthorized, not as offline', () => {
    const runnable = { inventory: { agents: [agent('in')] } }
    // Same machine, three verdicts: eligible with no `use` decision, offline with
    // no decision, denied while otherwise perfectly runnable. If the projection
    // flattened denied into offline, the first two assertions would still pass and
    // only this one would fail.
    expect(agentCapabilityRejection({ id: 'a', online: true, ...runnable }, 'codex')).toBeUndefined()
    expect(agentCapabilityRejection({ id: 'a', online: false, ...runnable }, 'codex')).toBe('offline')
    expect(
      agentCapabilityRejection({ id: 'a', online: true, use: 'denied', ...runnable }, 'codex'),
    ).toBe('unauthorized')
    // …and the two reasons are genuinely different values, which is the whole
    // point: a caller can tell "ask the owner for access" from "wake it up".
    expect(
      agentCapabilityRejection({ id: 'a', online: true, use: 'denied', ...runnable }, 'codex'),
    ).not.toBe(agentCapabilityRejection({ id: 'a', online: false, ...runnable }, 'codex'))
  })

  it('reports unauthorized ahead of liveness, inventory and the shell shortcut', () => {
    // Fails closed: a denied machine must not answer with its `use`-gated detail
    // (§3.1.4 M2), and per §3.1.5 the refusal must not vary with the hidden state
    // or it becomes an oracle for it. The counterfactuals are the SAME machine
    // without `use: 'denied'`, which each yield a different, state-revealing answer.
    const denied = { id: 'a', use: 'denied' } as const
    expect(agentCapabilityRejection({ ...denied, online: false }, 'codex')).toBe('unauthorized')
    expect(agentCapabilityRejection({ id: 'a', online: false }, 'codex')).toBe('offline')
    expect(agentCapabilityRejection({ ...denied, online: true }, 'codex')).toBe('unauthorized')
    expect(agentCapabilityRejection({ id: 'a', online: true }, 'codex')).toBe('harness-missing')
    expect(
      agentCapabilityRejection(
        { ...denied, online: true, inventory: { agents: [agent('out')] } },
        'codex',
      ),
    ).toBe('unauthorized')
    // Spawning a shell is `use` too — the shell shortcut must not bypass the gate.
    expect(agentCapabilityRejection({ ...denied, online: true }, 'shell')).toBe('unauthorized')
    expect(agentCapabilityRejection({ id: 'a', online: true }, 'shell')).toBeUndefined()
  })

  it('leaves an unevaluated use decision permissive rather than inventing a grant', () => {
    // Absence means NOT EVALUATED — today's single-operator world. This test pins
    // that today's behaviour is unchanged (the ONLY reason the field is optional),
    // and pairs the absent case with the explicit ones so a future change that
    // starts defaulting the field has to update this file deliberately.
    const runnable = { id: 'a', online: true, inventory: { agents: [agent('in')] } }
    expect(agentCapabilityRejection(runnable, 'codex')).toBeUndefined()
    expect(agentCapabilityRejection({ ...runnable, use: 'granted' }, 'codex')).toBeUndefined()
    expect(agentCapabilityRejection({ ...runnable, use: 'denied' }, 'codex')).toBe('unauthorized')
  })

  it('degrades an unknown harness id to harness-missing instead of throwing or guessing', () => {
    // POD-303's open-wire rule at the availability seam: a HarnessId from a newer
    // peer is compared by VALUE against the machine's inventory, never dispatched
    // through a closed switch. The counterfactual is in the same fixture — a
    // machine that DOES carry an installed, logged-in codex — so "degrades" cannot
    // pass by the machine simply having no inventory at all.
    const machine = { id: 'a', online: true, inventory: { agents: [agent('in')] } }
    expect(agentCapabilityRejection(machine, 'codex')).toBeUndefined()
    expect(agentCapabilityRejection(machine, 'some-harness-from-2027')).toBe('harness-missing')
    // Excluded from the offer rather than crashing it, and the machine that CAN
    // run codex is still offered — one unknown id does not poison the list.
    expect(machinesForAgent([machine], 'some-harness-from-2027')).toEqual([])
    expect(machinesForAgent([machine], 'codex')).toEqual([machine])
  })

  it('treats shell as a daemon capability and chooses an agent-capable repo machine', () => {
    expect(agentCapabilityRejection({ id: 'a', online: true }, 'shell')).toBeUndefined()
    const machines = [
      { id: 'a', online: true, inventory: { agents: [agent('out')] } },
      { id: 'b', online: true, inventory: { agents: [agent('in')] } },
    ]
    expect(resolveTargetMachineForAgent(repo, sessions, machines, 'codex')).toBe('b')
  })

  it('offers online fresh machines when an origin makes the repo cloneable', () => {
    const cloneable = { ...repo, originUrl: 'https://example.test/repo.git' }
    const machines = [
      { id: 'a', online: true, inventory: { agents: [agent('in')] } },
      { id: 'fresh', online: true, inventory: { agents: [agent('in')] } },
      { id: 'offline', online: false, inventory: { agents: [agent('in')] } },
    ]
    expect(machinesForRepoOrClone(cloneable, machines).map((machine) => machine.id)).toEqual([
      'a',
      'fresh',
      'offline',
    ])
    expect(onlineMachinesForRepoOrClone(cloneable, machines).map((machine) => machine.id)).toEqual([
      'a',
      'fresh',
    ])
    expect(resolveTargetMachineForAgent(cloneable, [], machines, 'codex')).toBe('a')
  })
})

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

  it('denies handoff to a machine the principal may not use, rather than retargeting it', () => {
    // §3.1.4 M5: handoff to a machine without `use` is DENIED — it stays in the
    // candidate list wearing its reason, so the menu states its case instead of
    // vanishing, and it is excluded from the eligible targets. The fixture holds
    // BOTH a denied and an eligible target, so "excluded" cannot pass by the list
    // being empty for some other reason.
    const machines = [
      { id: 'source', online: true, inventory: { agents: [agent('in')] } },
      { id: 'target', online: true, use: 'denied' as const, inventory: { agents: [agent('in')] } },
      { id: 'other', online: true, inventory: { agents: [agent('in')] } },
    ]
    const withOther = [
      { ...repos[0]!, machines: [...repos[0]!.machines, { machineId: 'other', path: '/c' }] },
    ]
    expect(handoffAvailability(session, withOther, machines).candidates).toEqual([
      { machine: machines[1], rejection: 'unauthorized' },
      { machine: machines[2] },
    ])
    expect(handoffTargets(session, withOther, machines).map((m) => m.id)).toEqual(['other'])
  })

  it('offers no candidates when no other machine has the repo', () => {
    expect(
      handoffAvailability(session, repos, [
        { id: 'source', online: true, inventory: { agents: [agent('in')] } },
        { id: 'stranger', online: true, inventory: { agents: [agent('in')] } },
      ]),
    ).toEqual({
      candidates: [
        {
          machine: { id: 'stranger', online: true, inventory: { agents: [agent('in')] } },
          rejection: 'repo-missing',
        },
      ],
    })
  })

  it('offers a capable machine without the repo when a clone URL is available', () => {
    const cloneable = [{ ...repos[0]!, originUrl: 'https://example.com/repo.git' }]
    const stranger = { id: 'stranger', online: true, inventory: { agents: [agent('in')] } }
    expect(handoffAvailability(session, cloneable, [stranger])).toEqual({
      candidates: [{ machine: stranger }],
    })
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
