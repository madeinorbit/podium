import { recoverTerminalHost } from './session'
import { canonicalDriverId } from '@podium/harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionHandle } from '@podium/agent-runtime'
import { asSessionId } from '@podium/model'
import type { SpawnOptions } from '@podium/process/screen'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'

/** Keep any launch artifacts inside a disposable test directory. */
const settingsDir = mkdtempSync(join(tmpdir(), 'podium-plain-terminal-'))
afterAll(() => rmSync(settingsDir, { recursive: true, force: true }))

let captured: SpawnOptions | undefined
const dispose = vi.fn()
vi.mock('../runtime/server-reap', () => ({ beginServerDriverReap: vi.fn(async () => {}) }))
vi.mock('../runtime/instance-process-reaper', () => ({
  reapInstanceSessionProcesses: vi.fn(async () => ({ examined: 0, remaining: 0 })),
}))
vi.mock('../session-uploads', () => ({ removeSessionUploads: vi.fn() }))

vi.mock('../runtime/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/registry')>()
  return { ...actual, terminalProfileFor: vi.fn(actual.terminalProfileFor) }
})

vi.mock('@podium/process/screen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/process/screen')>()
  return {
    ...actual,
    spawnAgent: (opts: SpawnOptions) => {
      captured = opts
      return {
        pid: 4242,
        onFrame: () => () => {},
        onTitle: () => () => {},
        onExit: () => () => {},
        write: () => {},
        resize: () => {},
        redraw: () => {},
        geometry: () => ({ cols: opts.cols, rows: opts.rows }),
        dispose,
      }
    },
  }
})

const { launchSpawn, launchServerDriverSession, sessionHandlers } = await import('./session')
const { terminalProfileFor } = await import('../runtime/registry')

function contextForSpawn(): DaemonContext {
  return {
    send: () => {},
    instanceId: 'default',
    backend: 'none',
    machineId: 'plain-terminal-test-machine',
    settingsDir,
    launch: (_kind: string, opts: { cwd: string }) => ({
      cmd: '/bin/true',
      args: [],
      cwd: opts.cwd,
    }),
    bridges: new Map(),
    durableLabels: new Map(),
    pendingResizes: new Map(),
    durableLabelFor: (id: string) => `podium-${id}`,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    composerEngine: { attach: () => false, onData: () => {}, detach: () => {}, has: () => false },
    outputScheduler: { enqueue: () => {}, remove: () => {}, priorityOf: () => 1 },
    observers: { initSessionObservers: () => {}, clearSession: () => {}, trackedState: () => undefined },
    tailSeedGate: () => {},
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    primeInjector: { reset: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as DaemonContext
}

beforeEach(() => {
  captured = undefined
  dispose.mockClear()
  vi.mocked(terminalProfileFor).mockClear()
})

// Exercise the actual launch fork with an available runtime and contract ON.
// The process boundary is mocked: no shell, login CLI, daemon or service starts.
it.each([
  { name: 'shell', agentKind: 'shell' },
  { name: 'native login shell', agentKind: 'shell', loginHarness: 'claude-code' },
  // A profile-bearing kind isolates the login exemption from the no-profile one.
  { name: 'profile-bearing login', agentKind: 'claude-code', loginHarness: 'claude-code' },
  { name: 'profile-less host', agentKind: 'codex', missingProfile: true },
] as const)('keeps $name on a plain terminal', async (row) => {
  if ('missingProfile' in row) vi.mocked(terminalProfileFor).mockReturnValueOnce(undefined)
  const createTerminal = vi.fn()
  const ctx = contextForSpawn()
  ctx.agentRuntime = {
    createTerminal,
    bindTerminal: vi.fn(),
    handleFor: () => undefined,
    has: () => false,
  } as unknown as DaemonContext['agentRuntime']
  ctx.send = vi.fn()
  await launchSpawn(ctx, {
    type: 'spawn',
    sessionId: `plain-${row.name}`,
    agentKind: row.agentKind,
    ...('loginHarness' in row ? { loginHarness: row.loginHarness } : {}),
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
    runtimeContract: true,
  } as Parameters<typeof launchSpawn>[1])
  expect(createTerminal).not.toHaveBeenCalled()
  expect(ctx.agentRuntime?.bindTerminal).not.toHaveBeenCalled()
  expect(captured).toBeDefined()
  expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'bind' }))
  expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'spawnError' }))
})

function spawnMessage(agentKind: 'codex' | 'claude-code' | 'grok' | 'opencode' | 'cursor' = 'codex') {
  return {
    type: 'spawn' as const,
    sessionId: asSessionId(`admission-${agentKind}`),
    agentKind,
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
  }
}

function installRuntime(ctx: DaemonContext, failure?: 'throw' | 'no-handle' | 'wrong-driver') {
  const handles = new Map<string, AgentSessionHandle>()
  const bindTerminal = vi.fn(async (...[registration, profile]: Parameters<NonNullable<DaemonContext['agentRuntime']>['bindTerminal']>) => {
    if (failure === 'throw') throw new Error('driver binding failed')
    if (failure === 'no-handle') return
    const handle = {
      binding: {
        sessionId: registration.sessionId,
        harness: registration.agentKind,
        family: 'terminal',
        driver: failure === 'wrong-driver' ? 'codex-app-server' : profile.driverId,
      },
    } as AgentSessionHandle
    handles.set(registration.sessionId, handle)
    return handle
  })
  const createTerminal = vi.fn(async (...[id, _spec, _profile, launch]: Parameters<NonNullable<DaemonContext['agentRuntime']>['createTerminal']>) => {
    await launch({ args: [] })
    return handles.get(id)
  })
  const recoverTerminal = vi.fn(async (...[msg, profile]: Parameters<NonNullable<DaemonContext['agentRuntime']>['recoverTerminal']>) => {
    if (typeof msg.runtimeContract === 'string' && canonicalDriverId(msg.runtimeContract) !== profile.driverId) {
      throw new Error(`runtime driver '${msg.runtimeContract}' cannot recover as '${profile.driverId}'`)
    }
    await bindTerminal({ sessionId: msg.sessionId, agentKind: msg.agentKind, cwd: msg.cwd, resume: msg.resume ?? null, rebind: true }, profile)
    await recoverTerminalHost(ctx, msg, () => {})
    return handles.get(msg.sessionId)
  })
  ctx.agentRuntime = {
    createTerminal,
    bindTerminal,
    recoverTerminal,
    handleFor: (id: string) => handles.get(id),
    has: (id: string) => handles.has(id),
    clearTerminal: (id: string) => handles.delete(id),
    adoptJournalled: async () => ({ found: false }),
  } as unknown as DaemonContext['agentRuntime']
  ctx.send = vi.fn()
  return { createTerminal, bindTerminal, handles }
}

it.each(['codex', 'claude-code', 'grok', 'opencode', 'cursor'] as const)(
  'admits omitted-request %s with a verified headed handle even with the rollout disabled',
  async (agentKind) => {
    const ctx = contextForSpawn()
    const { createTerminal, bindTerminal } = installRuntime(ctx)
    const msg = spawnMessage(agentKind)
    await launchSpawn(ctx, msg)
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(bindTerminal).toHaveBeenCalledOnce()
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bind', runtimeContract: true, driverId: terminalProfileFor(agentKind)!.driverId,
    }))
    expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'spawnError' }))
  },
)

// Exercise admission after createTerminal returns, independently of the check
// inside its launch callback. A factory resolving is not proof of a valid handle.
it.each(['no-handle', 'sessionId', 'harness', 'family', 'driver'] as const)(
  'rejects createTerminal returning with %s handle corruption',
  async (corruption) => {
    const ctx = contextForSpawn()
    const { createTerminal, handles } = installRuntime(ctx)
    const msg = spawnMessage()
    createTerminal.mockImplementationOnce(async (id, _spec, profile) => {
      if (corruption === 'no-handle') return undefined
      const binding = {
        sessionId: id,
        harness: msg.agentKind,
        family: 'terminal',
        driver: profile.driverId,
        [corruption]: {
          sessionId: 'another-session',
          harness: 'claude-code',
          family: 'server',
          driver: 'codex-app-server',
        }[corruption],
      }
      // Deliberately malformed registry output at the runtime boundary.
      const handle = { binding } as unknown as AgentSessionHandle
      handles.set(id, handle)
      return handle
    })

    await expect(launchSpawn(ctx, msg, {}, undefined, true)).rejects.toThrow(
      `terminal driver '${terminalProfileFor(msg.agentKind)!.driverId}' did not establish a handle`,
    )
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spawnError',
      message: expect.stringContaining('did not establish a handle'),
    }))
    expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bind' }))
  },
)

it('refuses an agent before starting its process when the runtime is missing', async () => {
  const ctx = contextForSpawn()
  ctx.send = vi.fn()
  await launchSpawn(ctx, spawnMessage())
  expect(captured).toBeUndefined()
  expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'spawnError', message: expect.stringContaining('agent runtime is unavailable'),
  }))
})

it.each(['throw', 'no-handle', 'wrong-driver'] as const)(
  'reaps the started process and reports %s admission failure without a success bind',
  async (failure) => {
    const ctx = contextForSpawn()
    installRuntime(ctx, failure)
    const msg = spawnMessage()
    await launchSpawn(ctx, msg)
    expect(captured).toBeDefined()
    expect(dispose).toHaveBeenCalledOnce()
    expect(ctx.bridges.has(msg.sessionId)).toBe(false)
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'spawnError' }))
    expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bind' }))
  },
)

function reconnectMessage() {
  return {
    ...spawnMessage(),
    type: 'reattach' as const,
    durableLabel: 'podium-admission-codex',
    lastKnownGeometry: { cols: 80, rows: 24 },
    binding: {
      transitionId: 'reattach-admission',
      machineAccess: 'allowed',
      sessionAccess: 'allowed',
      principal: { kind: 'system' },
    },
  } as Parameters<typeof sessionHandlers.reattach>[1]
}

it.each([undefined, 'generic-pty', 'claude-pty'] as const)(
  'reconnects an old or terminal-selected row (%s) with a verified handle',
  async (runtimeContract) => {
    const ctx = contextForSpawn()
    const { bindTerminal } = installRuntime(ctx)
    const msg = reconnectMessage()
    ctx.sessionBinding.transition = vi.fn(async () => ({ status: 'unchanged' })) as never
    ctx.bridges.set(msg.sessionId, { redraw: vi.fn(), dispose } as never)
    sessionHandlers.reattach(ctx, { ...msg, ...(runtimeContract ? { runtimeContract } : {}) })
    await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bind', runtimeContract: true, driverId: terminalProfileFor('codex')!.driverId,
    })))
    expect(bindTerminal).toHaveBeenCalledWith(expect.objectContaining({ rebind: true }), expect.anything())
    expect(dispose).not.toHaveBeenCalled()
  },
)

it('reports and reaps a reconnect whose handle cannot be constructed', async () => {
  const ctx = contextForSpawn()
  installRuntime(ctx, 'throw')
  const msg = reconnectMessage()
  ctx.sessionBinding.transition = vi.fn(async () => ({ status: 'unchanged' })) as never
  ctx.bridges.set(msg.sessionId, { redraw: vi.fn(), dispose } as never)
  sessionHandlers.reattach(ctx, msg)
  await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'reattachFailed', reason: 'driver binding failed',
  })))
  expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bind' }))
  expect(dispose).toHaveBeenCalledOnce()
})

it.each(['codex-app-server', 'codex-pty', 'unknown-driver'])(
  'refuses unavailable explicit reconnect driver %s instead of binding a PTY', async (driver) => {
  const ctx = contextForSpawn()
  const { bindTerminal } = installRuntime(ctx)
  ctx.sessionBinding.transition = vi.fn(async () => ({ status: 'unchanged' })) as never
  ctx.bridges.set(reconnectMessage().sessionId, { redraw: vi.fn(), dispose } as never)
  sessionHandlers.reattach(ctx, { ...reconnectMessage(), runtimeContract: driver })
  await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'reattachFailed', reason: expect.stringContaining(driver),
  })))
  expect(bindTerminal).not.toHaveBeenCalled()
})

it('keeps omitted launch intent headed despite a headless machine default', async () => {
  vi.stubEnv('PODIUM_RUNTIME_DRIVER', 'codex-app-server')
  try {
    const ctx = contextForSpawn()
    installRuntime(ctx)
    const probe = vi.fn()
    expect(await launchServerDriverSession(ctx, spawnMessage(), probe)).toEqual({ handled: false })
    expect(probe).not.toHaveBeenCalled()
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'driverSelected', driverId: terminalProfileFor('codex')!.driverId,
    }))
  } finally {
    vi.unstubAllEnvs()
  }
})
