import type { AgentSessionHandle, DriverId, RuntimeDriver } from '@podium/agent-runtime'
import type { Inventory, SessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { createDaemonMachineRuntime } from './machine-runtime'

const SESSION = 'machine-runtime-session' as SessionId
const INVENTORY: Inventory = {
  os: 'linux',
  arch: 'x64',
  agents: [],
  tools: [],
}

function server(
  id: DriverId,
  harness: string,
  input: {
    handle?: AgentSessionHandle
    journal?: Record<string, unknown>
  } = {},
) {
  const launch = vi.fn(async () => {})
  const adoptFromJournal = vi.fn(async () => input.handle)
  const capabilities = { marker: id }
  return {
    driver: {
      id,
      harness,
      family: 'server',
      capabilities: () => capabilities,
    } as unknown as RuntimeDriver,
    handleFor: (sessionId: SessionId) => (sessionId === SESSION ? input.handle : undefined),
    bindings: () => (input.handle ? [input.handle.binding] : []),
    has: (sessionId: SessionId) => sessionId === SESSION && input.handle !== undefined,
    journal: {
      read: (sessionId: SessionId) => (sessionId === SESSION ? input.journal : undefined),
      clear: vi.fn(),
    },
    launch,
    adoptFromJournal,
    dispose: vi.fn(),
  }
}

describe('daemon machine runtime composition', () => {
  it('routes inventory, capabilities, launch, lookup, and journal adoption through one root', async () => {
    const handle = {
      binding: {
        sessionId: SESSION,
        driver: 'grok-acp',
        family: 'server',
        harness: 'grok',
        workdir: '/tmp/grok',
        resume: { kind: 'grok-session', value: 'native-grok' },
        process: { key: 'grok:machine-runtime-session', pid: 42 },
        bindingVersion: 1,
      },
    } as unknown as AgentSessionHandle
    const opencode = server('opencode-server', 'opencode')
    const codex = server('codex-app-server', 'codex')
    const grok = server('grok-acp', 'grok', {
      handle,
      journal: {
        sessionId: SESSION,
        grokSessionId: 'native-grok',
        workdir: '/tmp/grok',
        process: handle.binding.process,
        bindingVersion: 1,
      },
    })
    const inventory = vi.fn(async () => INVENTORY)
    const terminal = {
      driverFor: vi.fn(),
      handleFor: () => undefined,
      bindings: () => [],
      observe: vi.fn(),
      onHookPayload: vi.fn(),
      register: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    }

    const runtime = createDaemonMachineRuntime({
      terminal,
      opencode,
      codex,
      grok,
      inventory,
    } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])
    expect(runtime.inventoryScope).toBe('registered-only')

    await expect(runtime.inventory()).resolves.toBe(INVENTORY)
    expect(runtime.capabilities('grok', 'grok-acp')).toEqual({ marker: 'grok-acp' })
    expect(runtime.handleFor(SESSION)).toBe(handle)

    await runtime.launchServer('grok-acp', {
      sessionId: 'new-server-session' as SessionId,
      cwd: '/tmp/grok',
    })
    expect(grok.launch).toHaveBeenCalledOnce()
    expect(opencode.launch).not.toHaveBeenCalled()
    expect(codex.launch).not.toHaveBeenCalled()

    await expect(runtime.adoptJournalled(SESSION)).resolves.toEqual({
      found: true,
      what: 'grok agent stdio',
      workdir: '/tmp/grok',
      handle,
    })
    expect(grok.adoptFromJournal).toHaveBeenCalledWith(SESSION)
  })
})
