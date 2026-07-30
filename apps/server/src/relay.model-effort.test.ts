import type { ControlMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

/**
 * The relay seam: a per-session model/effort override must ride the `spawn` control
 * message to the daemon (which maps it to the CLI flags — see agent-bridge launch).
 * 'auto' is the sentinel for "no flag", and cursor never gets an effort flag.
 */
function captureSpawn(over: {
  agentKind: 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor' | 'shell'
  model?: string
  effort?: string
}) {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'm1', name: 'one', hostname: 'one', tokenHash: 'x' })
  store.machines.setMachineInventory(
    'm1',
    JSON.stringify({
      os: 'linux',
      arch: 'x64',
      agents: [{ kind: over.agentKind, installed: true, login: { state: 'in' } }],
      tools: [],
    }),
  )
  const registry = new SessionRegistry(store)
  const sent: ControlMessage[] = []
  registry.modules.sessions.attachDaemon('m1', (m) => sent.push(m))
  registry.modules.sessions.createSession({ cwd: '/wt', machineId: 'm1', ...over })
  const spawn = sent.find((m) => m.type === 'spawn')
  registry.dispose()
  return spawn as Extract<ControlMessage, { type: 'spawn' }> | undefined
}

describe('relay threads per-session model + effort onto the spawn message', () => {
  it('forwards an explicit model + effort override', () => {
    const spawn = captureSpawn({ agentKind: 'claude-code', model: 'opus', effort: 'high' })
    expect(spawn).toMatchObject({ agentKind: 'claude-code', model: 'opus', effort: 'high' })
  })

  it("'auto' means no flag — neither model nor effort is set", () => {
    const spawn = captureSpawn({ agentKind: 'claude-code', model: 'auto', effort: 'auto' })
    expect(spawn).toBeDefined()
    expect(spawn).not.toHaveProperty('model')
    expect(spawn).not.toHaveProperty('effort')
  })

  it('cursor carries a model but never an effort flag', () => {
    const spawn = captureSpawn({ agentKind: 'cursor', model: 'gpt-5.2', effort: 'high' })
    expect(spawn?.model).toBe('gpt-5.2')
    expect(spawn).not.toHaveProperty('effort')
  })
})
