import type { AgentSessionHandle, DriverId, RuntimeDriver } from '@podium/agent-runtime'
import type { Inventory, SessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { createDaemonMachineRuntime } from './machine-runtime'

const SESSION = 'machine-runtime-session' as SessionId
const NEW_SESSION = 'new-server-session' as SessionId
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
  const handles = new Map<SessionId, AgentSessionHandle>()
  if (input.handle) handles.set(input.handle.binding.sessionId, input.handle)
  const launch = vi.fn(async (launchInput: { sessionId: SessionId; cwd: string }) => {
    const launched = {
      binding: {
        sessionId: launchInput.sessionId,
        driver: id,
        family: 'server',
        harness,
        workdir: launchInput.cwd,
        resume: null,
        process: { key: `${id}:${launchInput.sessionId}` },
        bindingVersion: 1,
      },
    } as unknown as AgentSessionHandle
    handles.set(launchInput.sessionId, launched)
  })
  const adoptFromJournal = vi.fn(async (sessionId: SessionId) => handles.get(sessionId))
  const capabilities = { marker: id, placement: 'dedicated' as const }
  return {
    driver: {
      id,
      harness,
      family: 'server',
      capabilities: () => capabilities,
    } as unknown as RuntimeDriver,
    handleFor: (sessionId: SessionId) => handles.get(sessionId),
    bindings: () => [...handles.values()].map((handle) => handle.binding),
    has: (sessionId: SessionId) => handles.has(sessionId),
    journal: {
      read: (sessionId: SessionId) => (sessionId === SESSION ? input.journal : undefined),
      clear: vi.fn(),
    },
    launch,

    adoptFromJournal,
    dispose: vi.fn(),
  }
}

function claude() {
  return {
    driver: {
      id: 'claude-sdk',
      harness: 'claude-code',
      family: 'embedded',
      capabilities: () => ({ placement: 'dedicated' }),
      adopt: vi.fn(),
    } as unknown as RuntimeDriver,
    handleFor: () => undefined,
    bindings: () => [],
    launch: vi.fn(),
    processEvent: vi.fn(),
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
    const opencode2 = server('opencode2-server', 'opencode')
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
      claude: claude(),
      opencode,
      opencode2,
      codex,
      grok,
      inventory,
    } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])
    expect(runtime.primitiveSupport).toEqual({
      import: { supported: false, reason: expect.stringContaining('POD-2415') },
      list: { scope: 'registered-only' },
    })

    await expect(runtime.inventory()).resolves.toBe(INVENTORY)
    expect(
      runtime.resolveDriver({
        agentKind: 'grok',
        requested: 'grok-acp',
        machineDefault: undefined,
        available: ['generic-pty', 'grok-acp'],
        platform: 'linux',
        auth: 'subscription',
      }),
    ).toEqual({
      ok: true,
      driverId: 'grok-acp',
      capabilities: { marker: 'grok-acp', placement: 'dedicated' },
    })
    expect(runtime.capabilities('grok', 'grok-acp')).toEqual({
      marker: 'grok-acp',
      placement: 'dedicated',
    })
    expect(runtime.handleFor(SESSION)).toBe(handle)

    await runtime.create(
      {
        harness: 'grok',
        selection: {
          auth: 'subscription',
          platform: 'linux',
          available: ['grok-acp'],
          preference: 'grok-acp',
        },
        workdir: '/tmp/grok',
        model: {},
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
      },
      NEW_SESSION,
    )
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
  it('registers every server family so full-reap close cannot skip one', () => {
    const cases = [
      {
        sessionId: 'machine-opencode' as SessionId,
        driver: 'opencode-server' as DriverId,
        harness: 'opencode',
      },
      {
        sessionId: 'machine-codex' as SessionId,
        driver: 'codex-app-server' as DriverId,
        harness: 'codex',
      },
      {
        sessionId: 'machine-grok' as SessionId,
        driver: 'grok-acp' as DriverId,
        harness: 'grok',
      },
    ].map((input) => ({
      ...input,
      handle: {
        binding: {
          sessionId: input.sessionId,
          driver: input.driver,
          family: 'server',
          harness: input.harness,
          workdir: '/tmp/server-reap',
          resume: null,
          process: { key: `${input.driver}:${input.sessionId}`, pid: 42 },
          bindingVersion: 1,
        },
      } as unknown as AgentSessionHandle,
    }))
    const opencode2 = server('opencode2-server', 'opencode')
    const [opencode, codex, grok] = cases.map(({ driver, harness, handle }) =>
      server(driver, harness, { handle }),
    )
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
      claude: claude(),
      opencode,
      opencode2,
      codex,
      grok,
      inventory: async () => INVENTORY,
    } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])
    expect(runtime.registeredBindings()).toEqual(cases.map(({ handle }) => handle.binding))
    for (const { sessionId, handle } of cases) {
      expect(runtime.serverHandleFor(sessionId)).toBe(handle)
    }
  })
})
