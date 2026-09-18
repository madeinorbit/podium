import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from '@podium/process/screen'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'

/** Keep any launch artifacts inside a disposable test directory. */
const settingsDir = mkdtempSync(join(tmpdir(), 'podium-plain-terminal-'))
afterAll(() => rmSync(settingsDir, { recursive: true, force: true }))

let captured: SpawnOptions | undefined

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
        dispose: () => {},
      }
    },
  }
})

const { launchSpawn } = await import('./session')
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
    outputScheduler: { enqueue: () => {}, remove: () => {} },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    primeInjector: { reset: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as DaemonContext
}

beforeEach(() => {
  captured = undefined
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
  ctx.runtimeContractEnabled = true
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
  expect(captured).toBeDefined()
  expect(ctx.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'bind' }))
  expect(ctx.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'spawnError' }))
})

it('routes a profile-bearing agent through createTerminal when enabled', async () => {
  const createTerminal = vi.fn()
  const ctx = contextForSpawn()
  ctx.runtimeContractEnabled = true
  ctx.agentRuntime = { createTerminal } as unknown as DaemonContext['agentRuntime']
  await launchSpawn(ctx, {
    type: 'spawn',
    sessionId: 'contract-agent',
    agentKind: 'codex',
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
    runtimeContract: true,
  } as Parameters<typeof launchSpawn>[1])
  expect(createTerminal).toHaveBeenCalledOnce()
  expect(captured).toBeUndefined()
})
