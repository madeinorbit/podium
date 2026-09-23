import { asMachineId } from '@podium/model'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  activationAgentIsInstalled,
  activationAgentIsReady,
  activationAgentReadiness,
  agentReadinessOnMachines,
  launchAgentKind,
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
    serviceAssignment: { server: false, agentExecution: true },
    availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
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

describe('the harness a launch starts on (POD-4639)', () => {
  const studio = (logins: Record<string, 'in' | 'out'>): MachineWire => {
    const base = machine(null)
    return {
      ...base,
      inventory: {
        ...base.inventory!,
        agents: Object.entries(logins).map(([kind, login]) => ({
          kind,
          installed: true,
          login: { state: login },
        })),
      },
    }
  }
  const pick = (logins: Record<string, 'in' | 'out'>, picked?: 'claude-code' | 'opencode') =>
    launchAgentKind({
      picked,
      preferred: 'claude-code',
      candidates: ['claude-code', 'codex', 'opencode'] as const,
      readiness: (agent) => agentReadinessOnMachines([studio(logins)], agent),
    })

  it('keeps a ready default', () => {
    expect(pick({ 'claude-code': 'in', opencode: 'in' })).toBe('claude-code')
  })

  it('steps a signed-out default aside for the first ready harness', () => {
    expect(pick({ 'claude-code': 'out', opencode: 'in' })).toBe('opencode')
  })

  it('keeps the default when nothing is ready, so the caller refuses it', () => {
    expect(pick({ 'claude-code': 'out' })).toBe('claude-code')
  })

  it('never swaps a harness the operator picked', () => {
    expect(pick({ 'claude-code': 'out', opencode: 'in' }, 'claude-code')).toBe('claude-code')
  })
})
