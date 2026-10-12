import { asMachineId } from '@podium/model'
import type { GitRepositoryWire, HarnessAgent, MachineWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  activationAgentIsInstalled,
  activationAgentIsReady,
  activationAgentReadiness,
  agentCanLaunch,
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
  type Logins = Partial<Record<HarnessAgent, 'in' | 'out'>>
  const studio = (logins: Logins): MachineWire => {
    const base = machine(null)
    return {
      ...base,
      inventory: {
        ...base.inventory!,
        agents: Object.entries(logins).map(([kind, login]) => ({
          kind: kind as HarnessAgent,
          installed: true,
          login: { state: login },
        })),
      },
    }
  }
  const pick = (logins: Logins, picked?: 'claude-code' | 'opencode' | null) =>
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

  it('reads a null pick as no pick, as the harness parsers spell it', () => {
    expect(pick({ 'claude-code': 'out', opencode: 'in' }, null)).toBe('opencode')
  })

  it('never swaps a harness the operator picked', () => {
    expect(pick({ 'claude-code': 'out', opencode: 'in' }, 'claude-code')).toBe('claude-code')
  })
})

describe('whether a launch may go ahead (POD-3911)', () => {
  const on = (agent: Parameters<typeof machine>[0]) =>
    activationAgentReadiness(repo, [machine(agent)], 'codex')

  it('lets a signed-out harness start headed, where its terminal can sign it in', () => {
    const signedOut = on({ installed: true, login: 'out' })
    expect(signedOut.state).toBe('logged-out')
    expect(agentCanLaunch(signedOut, { headed: true })).toBe(true)
  })

  it('still refuses a signed-out harness headless, which has no screen to sign in on', () => {
    expect(agentCanLaunch(on({ installed: true, login: 'out' }), { headed: false })).toBe(false)
  })

  it('loosens nothing else: a missing or still-checking harness is refused either way', () => {
    const inventoryless = machine(null)
    delete inventoryless.inventory
    const checking = activationAgentReadiness(repo, [inventoryless], 'codex')
    expect(checking.state).toBe('checking')
    for (const headed of [true, false]) {
      expect(agentCanLaunch(on({ installed: false, login: 'unknown' }), { headed })).toBe(false)
      expect(agentCanLaunch(checking, { headed })).toBe(false)
    }
  })

  it('lets a ready harness start either way', () => {
    const ready = on({ installed: true, login: 'in' })
    expect(agentCanLaunch(ready, { headed: true })).toBe(true)
    expect(agentCanLaunch(ready, { headed: false })).toBe(true)
  })
})
