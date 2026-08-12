import { asMachineId } from '@podium/model'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { activationAgentReadiness } from './agent-readiness'

const machineId = asMachineId('machine-a')
const repo: GitRepositoryWire = {
  path: '/work/repo',
  kind: 'repository',
  worktrees: [],
  machineId,
}

function machine(
  agent: { installed: boolean; login: 'in' | 'out' | 'unknown' } | null,
  overrides: Partial<MachineWire> = {},
): MachineWire {
  return {
    id: machineId,
    name: 'Studio Mac',
    hostname: 'studio',
    online: true,
    lastSeenAt: new Date(0).toISOString(),
    inventory: {
      os: 'darwin',
      arch: 'arm64',
      agents: agent
        ? [{ kind: 'codex', installed: agent.installed, login: { state: agent.login } }]
        : [],
      tools: [],
    },
    ...overrides,
  }
}

describe('activation agent readiness', () => {
  it('distinguishes ready, logged-out, and missing installations', () => {
    expect(
      activationAgentReadiness(repo, [machine({ installed: true, login: 'in' })], 'codex').state,
    ).toBe('ready')
    expect(
      activationAgentReadiness(repo, [machine({ installed: true, login: 'out' })], 'codex').state,
    ).toBe('logged-out')
    expect(
      activationAgentReadiness(repo, [machine({ installed: false, login: 'out' })], 'codex').state,
    ).toBe('missing')
  })

  it('does not call an inventory-less or denied machine ready', () => {
    const inventoryless = machine(null)
    delete inventoryless.inventory
    expect(activationAgentReadiness(repo, [inventoryless], 'codex').state).toBe('checking')
    expect(activationAgentReadiness(repo, [machine(null, { use: 'denied' })], 'codex').state).toBe(
      'unauthorized',
    )
  })
})
