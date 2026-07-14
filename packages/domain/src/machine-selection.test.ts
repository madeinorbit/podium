import { describe, expect, it } from 'vitest'
import { handoffTargets } from './machine-selection'

const repos = [
  {
    repoId: 'r1',
    machines: [
      { machineId: 'source', path: '/a' },
      { machineId: 'target', path: '/b' },
    ],
    worktrees: [{ path: '/a/.worktrees/x', isMain: false, machineId: 'source' }],
  },
]
const agent = (state: 'in' | 'out' | 'unknown', installed = true) => ({
  kind: 'codex',
  installed,
  login: { state },
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
})
