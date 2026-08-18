import { asMachineId } from '@podium/model'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  activationAgentIsInstalled,
  activationAgentIsReady,
  activationAgentReadiness,
} from './agent-readiness'

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
    const ready = activationAgentReadiness(
      repo,
      [machine({ installed: true, login: 'in' })],
      'codex',
    )
    const loggedOut = activationAgentReadiness(
      repo,
      [machine({ installed: true, login: 'out' })],
      'codex',
    )
    const missing = activationAgentReadiness(
      repo,
      [machine({ installed: false, login: 'out' })],
      'codex',
    )

    expect(ready.state).toBe('ready')
    expect(loggedOut.state).toBe('logged-out')
    expect(missing.state).toBe('missing')
    expect(activationAgentIsReady(loggedOut)).toBe(false)
    expect(activationAgentIsInstalled(loggedOut)).toBe(true)
    expect(activationAgentIsInstalled(missing)).toBe(false)
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
