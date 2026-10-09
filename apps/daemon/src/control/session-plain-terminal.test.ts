import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionHandle, SessionBinding, SessionSpec } from '@podium/harness/driver/host'
import { type AgentKind, asSessionId, type ResumeRef, type SessionId } from '@podium/model'
import type { SpawnOptions } from '@podium/process/screen'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { attachTestTerminal, stubDurable, testSessions } from '../session/testing.js'

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

/** Stands in for the pty: a context with no durable process refuses to spawn (POD-4617). */
const fakeSpawn = (opts: SpawnOptions) => {
  captured = opts
  return {
    pid: 4242,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    resize: () => {},
    dispose,
  }
}

const {
  launchSpawn,
  launchServerDriverSession,
  launchTerminalProcess,
  launchTerminalSpawn,
  recoverTerminalProcess,
  sessionHandlers,
} = await import('./session')
const { terminalProfileFor } = await import('../runtime/registry')

function contextForSpawn(): DaemonContext {
  return {
    send: () => {},
    instanceId: 'default',
    backend: 'none',
    durable: stubDurable(fakeSpawn),
    machineId: 'plain-terminal-test-machine',
    settingsDir,
    launch: (_kind: string, opts: { cwd: string }) => ({
      cmd: '/bin/true',
      args: [],
      cwd: opts.cwd,
    }),
    sessions: testSessions(),
    durableLabelFor: (id: string) => `podium-${id}`,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    composerEngine: { attach: () => false, onData: () => {}, detach: () => {}, has: () => false },
    outputScheduler: { enqueue: () => {}, remove: () => {}, priorityOf: () => 1 },
    observers: { initSessionObservers: () => {}, clearSession: () => {}, trackedState: () => undefined },
    tailSeedGate: () => {},
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as DaemonContext
}

beforeEach(() => {
  captured = undefined
  dispose.mockClear()
  vi.mocked(terminalProfileFor).mockClear()
})

// Exercise the actual launch fork with an available runtime and NO env.
// Every profiled kind binds unconditionally; shells and logins stay plain.
it.each([
  { name: 'shell', agentKind: 'shell' },
  { name: 'native login shell', agentKind: 'shell', loginHarness: 'claude-code' },
  // A profile-bearing kind isolates the login exemption from the no-profile one.
  { name: 'profile-bearing login', agentKind: 'claude-code', loginHarness: 'claude-code' },
] as const)('keeps $name on a plain terminal', async (row) => {
  const create = vi.fn()
  const ctx = contextForSpawn()
  ctx.agentRuntime = {
    create,
    resume: vi.fn(),
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
  } as Parameters<typeof launchSpawn>[1])
  expect(create).not.toHaveBeenCalled()
  expect(ctx.agentRuntime?.resume).not.toHaveBeenCalled()
  expect(captured).toBeDefined()
  expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'bind' }))
  expect(ctx.send).toHaveBeenCalledWith(
    expect.not.objectContaining({ type: 'bind', driverId: expect.anything() }),
  )
  expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'spawnError' }))
})

it('refuses a non-shell kind with no manifest instead of opening an undrivable session', async () => {
  // Coordinator 4414: !profile conflates shells (deliberately driverless) with
  // unknown harnesses (nothing can drive them). The latter must refuse loudly
  // with the kind named — after POD-4427 there is no legacy path left to catch it.
  const create = vi.fn()
  const ctx = contextForSpawn()
  ctx.agentRuntime = {
    create,
    resume: vi.fn(),
    handleFor: () => undefined,
    has: () => false,
  } as unknown as DaemonContext['agentRuntime']
  ctx.send = vi.fn()
  await launchSpawn(ctx, {
    type: 'spawn',
    sessionId: 'plain-unknown-harness',
    agentKind: 'not-a-harness',
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
  } as unknown as Parameters<typeof launchSpawn>[1])
  expect(captured).toBeUndefined()
  expect(create).not.toHaveBeenCalled()
  expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'spawnError',
    message: expect.stringContaining('not-a-harness'),
  }))
  expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bind' }))
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

/**
 * The machine runtime as the daemon drives it: `create`/`resume` launch through
 * the terminal host port from the spec, register a handle, and announce — the
 * family's order. `failure` corrupts the registration the way a broken driver
 * would.
 */
function installRuntime(ctx: DaemonContext, failure?: 'throw' | 'no-handle' | 'wrong-driver') {
  const handles = new Map<string, AgentSessionHandle>()
  const register = vi.fn((registration: { sessionId: string; agentKind: string; rebind?: boolean }, driverId: string) => {
    if (failure === 'throw') throw new Error('driver binding failed')
    if (failure === 'no-handle') return undefined
    const handle = {
      binding: {
        sessionId: registration.sessionId,
        harness: registration.agentKind,
        family: 'terminal',
        driver: failure === 'wrong-driver' ? 'codex-app-server' : driverId,
      },
    } as AgentSessionHandle
    handles.set(registration.sessionId, handle)
    return handle
  })
  const launchAndRegister = async (sessionId: SessionId, spec: SessionSpec, resume?: ResumeRef) => {
    const launched = await launchTerminalProcess(ctx, {
      sessionId,
      spec,
      instrumentation: { args: [] },
      ...(resume ? { resume } : {}),
    })
    const handle = register({ sessionId, agentKind: spec.harness }, spec.selection.preference ?? '')
    launched.announce()
    return handle
  }
  const create = vi.fn(async (spec: SessionSpec, sessionId: SessionId) => launchAndRegister(sessionId, spec))
  const resume = vi.fn(async (ref: ResumeRef, spec: SessionSpec, sessionId: SessionId) =>
    launchAndRegister(sessionId, spec, ref),
  )
  // `runtime.adopt` as the terminal family runs it: the host re-attaches, the
  // driver re-registers, the host announces (POD-5841).
  const adopt = vi.fn(async (binding: SessionBinding) => {
    const recovered = await recoverTerminalProcess(ctx, {
      sessionId: binding.sessionId,
      agentKind: binding.harness as AgentKind,
      workdir: binding.workdir,
      lease: {},
    })
    const handle = register({ sessionId: binding.sessionId, agentKind: binding.harness, rebind: true }, binding.driver)
    recovered?.announce()
    return handle
  })
  ctx.agentRuntime = {
    create,
    resume,
    adopt,
    handleFor: (id: string) => handles.get(id),
    has: (id: string) => handles.has(id),
    clearTerminal: (id: string) => handles.delete(id),
    adoptJournalled: async () => ({ found: false }),
  } as unknown as DaemonContext['agentRuntime']
  ctx.send = vi.fn()
  return { create, register, handles }
}

it.each(['codex', 'claude-code', 'grok', 'opencode', 'cursor'] as const)(
  'admits omitted-request %s with a verified headed handle and no env set',
  async (agentKind) => {
    const ctx = contextForSpawn()
    const { create, register } = installRuntime(ctx)
    const msg = spawnMessage(agentKind)
    await launchTerminalSpawn(ctx, msg)
    expect(create).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledOnce()
    const bind = vi.mocked(ctx.send).mock.calls.map(([m]) => m).find((m) => m.type === 'bind')
    expect(bind).toMatchObject({ driverId: terminalProfileFor(agentKind)!.driverId })
    // driverId presence is the driven signal.
    expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'spawnError' }))
  },
)

// Admission after `create` returns, independently of the gate inside the
// announcement. A factory resolving is not proof of a valid handle.
it.each(['no-handle', 'sessionId', 'harness', 'family', 'driver'] as const)(
  'rejects create returning with %s handle corruption',
  async (corruption) => {
    const ctx = contextForSpawn()
    const { create, handles } = installRuntime(ctx)
    const msg = spawnMessage()
    const driverId = terminalProfileFor(msg.agentKind)!.driverId
    create.mockImplementationOnce(async (_spec, id) => {
      if (corruption === 'no-handle') return undefined as unknown as AgentSessionHandle
      const binding = {
        sessionId: id,
        harness: msg.agentKind,
        family: 'terminal',
        driver: driverId,
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

    await launchTerminalSpawn(ctx, msg)
    expect(create).toHaveBeenCalledOnce()
    expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spawnError',
      message: expect.stringContaining(`terminal driver '${driverId}' did not establish a handle`),
    }))
    expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bind' }))
  },
)

it.each(['plain', 'agent'] as const)(
  'launches a %s spawn under the durable label its frame names',
  async (path) => {
    const ctx = contextForSpawn()
    installRuntime(ctx)
    const msg = { ...spawnMessage(), durableLabel: 'podium-named-label' }
    if (path === 'plain') await launchSpawn(ctx, { ...msg, agentKind: 'shell' } as never)
    else await launchTerminalSpawn(ctx, msg)
    expect((captured as { label?: string } | undefined)?.label).toBe('podium-named-label')
    expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'spawnError' }))
  },
)

it('refuses an agent before starting its process when the runtime is missing', async () => {
  const ctx = contextForSpawn()
  ctx.send = vi.fn()
  await launchTerminalSpawn(ctx, spawnMessage())
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
    await launchTerminalSpawn(ctx, msg)
    expect(captured).toBeDefined()
    expect(dispose).toHaveBeenCalledOnce()
    expect((ctx.sessions.get(msg.sessionId)?.attached ?? false)).toBe(false)
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
  async (requestedDriverId) => {
    const ctx = contextForSpawn()
    const { register } = installRuntime(ctx)
    const msg = reconnectMessage()
    ctx.sessionBinding.transition = vi.fn(async () => ({ status: 'unchanged' })) as never
    attachTestTerminal(ctx, msg.sessionId, {
      pid: 4242,
      onFrame: () => () => {},
      onTitle: () => () => {},
      onExit: () => () => {},
      write: () => {},
      writeBytes: () => {},
      resize: () => {},
      dispose,
    } as never)
    sessionHandlers.reattach(ctx, { ...msg, ...(requestedDriverId ? { requestedDriverId } : {}) })
    await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bind', driverId: terminalProfileFor('codex')!.driverId,
    })))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ rebind: true }), expect.anything())
    expect(dispose).not.toHaveBeenCalled()
  },
)

it('reports and reaps a reconnect whose handle cannot be constructed', async () => {
  const ctx = contextForSpawn()
  installRuntime(ctx, 'throw')
  const msg = reconnectMessage()
  ctx.sessionBinding.transition = vi.fn(async () => ({ status: 'unchanged' })) as never
  attachTestTerminal(ctx, msg.sessionId, {
      pid: 4242,
      onFrame: () => () => {},
      onTitle: () => () => {},
      onExit: () => () => {},
      write: () => {},
      writeBytes: () => {},
      resize: () => {},
      dispose,
    } as never)
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
  const { register } = installRuntime(ctx)
  ctx.sessionBinding.transition = vi.fn(async () => ({ status: 'unchanged' })) as never
  attachTestTerminal(ctx, reconnectMessage().sessionId, {
      pid: 4242,
      onFrame: () => () => {},
      onTitle: () => () => {},
      onExit: () => () => {},
      write: () => {},
      writeBytes: () => {},
      resize: () => {},
      dispose,
    } as never)
  sessionHandlers.reattach(ctx, { ...reconnectMessage(), requestedDriverId: driver })
  await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'reattachFailed', reason: expect.stringContaining(driver),
  })))
  expect(register).not.toHaveBeenCalled()
})

it('refuses a reattach for a non-shell kind with no manifest', async () => {
  const ctx = contextForSpawn()
  installRuntime(ctx)
  const msg = reconnectMessage()
  ctx.sessionBinding.transition = vi.fn(async () => ({ status: 'unchanged' })) as never
  sessionHandlers.reattach(ctx, { ...msg, agentKind: 'not-a-harness' } as never)
  await vi.waitFor(() => expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'reattachFailed', reason: expect.stringContaining('not-a-harness'),
  })))
  expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'bind' }))
})

it('keeps omitted launch intent headed with no machine default to consult', async () => {
  const ctx = contextForSpawn()
  installRuntime(ctx)
  const probe = vi.fn()
  expect(await launchServerDriverSession(ctx, spawnMessage(), probe)).toEqual({ handled: false })
  expect(probe).not.toHaveBeenCalled()
  expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'driverSelected', driverId: terminalProfileFor('codex')!.driverId,
  }))
})
