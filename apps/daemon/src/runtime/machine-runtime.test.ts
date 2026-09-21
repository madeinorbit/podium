import type { AgentSessionHandle, DriverId, RuntimeDriver } from '@podium/harness/driver/host'
import { EngineBindUnrecoverable } from '@podium/harness/driver/host'
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

const DESCRIBE: Record<DriverId, string> = {
  'opencode-server': 'opencode serve',
  'opencode2-server': 'opencode2 serve',
  'codex-app-server': 'codex app-server',
  'grok-acp': 'grok agent stdio',
  'claude-sdk': 'claude-sdk',
  'generic-pty': 'generic-pty',
  fake: 'fake',
  headless: 'headless',
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
    describe: DESCRIBE[id],
    journalEntry: (sessionId: SessionId) => {
      const raw = sessionId === SESSION ? input.journal : undefined
      if (!raw) return undefined
      const { workdir, process } = raw as { workdir: string; process: { key: string } }
      return { workdir, process };
    },
    clearJournal: vi.fn(),
    launch,

    adoptFromJournal,
    reportOomKill: vi.fn(),
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
      servers: [opencode, opencode2, codex, grok],
      headless: {
        driverFor: () => undefined,
        handleFor: () => undefined,
        bindings: () => [],
      },
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
      servers: [opencode, opencode2, codex, grok],
      headless: {
        driverFor: () => undefined,
        handleFor: () => undefined,
        bindings: () => [],
      },
      inventory: async () => INVENTORY,
    } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])
    expect(runtime.registeredBindings()).toEqual(cases.map(({ handle }) => handle.binding))
    for (const { sessionId, handle } of cases) {
      expect(runtime.serverHandleFor(sessionId)).toBe(handle)
    }
  })
})

describe('daemon machine runtime adoption failures', () => {
  it('reports an unrecoverable adopt as found-with-reason, never as silently missing', async () => {
    // §4.8: the session adapter propagates a driver refusal (unrecoverable
    // protocol state) instead of swallowing it. The machine root turns the
    // cause into an honest reattach failure — the shape the lifecycle owner
    // reads to invalidate pending turns — rather than "session not found".
    const sessionId = 'machine-unrecoverable' as SessionId
    const grok = {
      driver: {
        id: 'grok-acp',
        harness: 'grok',
        family: 'server',
        capabilities: () => ({ placement: 'dedicated' as const }),
      },
      handleFor: () => undefined,
      bindings: () => [],
      describe: 'grok agent stdio',
      journalEntry: () => ({
        workdir: '/tmp/grok',
        process: { key: 'grok:machine-unrecoverable' },
        bindingVersion: 1,
      }),
      clearJournal: () => {},
      launch: async () => {},
      adoptFromJournal: async () => {
        throw new Error('grok-acp cannot adopt machine-unrecoverable: session/load failed')
      },
      reportOomKill: () => {},
      dispose: () => {},
    }
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
      servers: [grok],
      headless: {
        driverFor: () => undefined,
        handleFor: () => undefined,
        bindings: () => [],
      },
      inventory: async () => INVENTORY,
    } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])
    await expect(runtime.adoptJournalled(sessionId)).resolves.toMatchObject({
      found: true,
      what: 'grok agent stdio',
      workdir: '/tmp/grok',
      reason: expect.stringContaining('session/load failed'),
    })
  })

  it('carries the typed §4.8 bind failure beside the reason, so the lifecycle owner can keep the engine', async () => {
    // §4.8: the family kept a live-but-undriveable engine. The reason stays
    // the human sentence every existing reader uses; `bindFailure` carries
    // the typed signal (address, credential, phase) the lifecycle owner reads
    // to invalidate pending turns and record the survivor (POD-4490) instead
    // of reaping it as a failed adoption.
    const sessionId = 'machine-bind-failure' as SessionId
    const typed = new EngineBindUnrecoverable(
      sessionId,
      'launch',
      'http://127.0.0.1:41234',
      new Error('serve did not answer'),
      's3cret',
    )
    const grok = {
      driver: {
        id: 'grok-acp',
        harness: 'grok',
        family: 'server',
        capabilities: () => ({ placement: 'dedicated' as const }),
      },
      handleFor: () => undefined,
      bindings: () => [],
      describe: 'grok agent stdio',
      journalEntry: () => ({
        workdir: '/tmp/grok',
        process: { key: 'grok:machine-bind-failure' },
        bindingVersion: 1,
      }),
      clearJournal: () => {},
      launch: async () => {},
      adoptFromJournal: async () => {
        throw typed
      },
      reportOomKill: () => {},
      dispose: () => {},
    }
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
      servers: [grok],
      headless: {
        driverFor: () => undefined,
        handleFor: () => undefined,
        bindings: () => [],
      },
      inventory: async () => INVENTORY,
    } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])
    const adoption = await runtime.adoptJournalled(sessionId)
    expect(adoption).toMatchObject({
      found: true,
      what: 'grok agent stdio',
      workdir: '/tmp/grok',
      reason: expect.stringContaining('did not bind during launch'),
    })
    expect(adoption.found && adoption.bindFailure).toBe(typed)
  })
})
