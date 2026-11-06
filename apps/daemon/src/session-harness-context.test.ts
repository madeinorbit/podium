/**
 * ONE HARNESS CONTEXT PER TERMINAL SESSION (POD-6533,
 * docs/design/harness-access-contract.md §3.3).
 *
 * A spawn builds the session's context once, where the daemon assembles its
 * SessionSpec, and three consumers read it: the hook installer (the version it
 * gates on and the folder it writes), the launch (argv[0] and the account env)
 * and the observer (the folders it reads). These tests drive a real spawn
 * through the daemon's own terminal host port (`daemonRuntimeHost`: the real
 * installer and the real launch), stopping only at the PTY.
 *
 *   1. The same context object reaches all three.
 *   2. Refresh guard: an inventory refresh after the spawn began moves none of
 *      them to the new installation.
 *   3. A restarted daemon rebuilds the context on reattach: same folders, and
 *      nothing is relaunched.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstrumentationDestination, ResolvedHarnessInventory } from '@podium/harness'
import { codexInstrumentation } from '@podium/harness/adapters/codex/instrumentation'
import type { AgentSessionHandle, SessionSpec } from '@podium/harness/driver/host'
import { asSessionId, type SessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/durable'
import type { SpawnOptions } from '@podium/process/screen'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './control/context'
import { DaemonHarnessRuntime } from './harness-runtime'
import { daemonRuntimeHost } from './runtime/host'
import { stubDurable, testSessions } from './session/testing.js'
import type { SessionObserverInit } from './session-observers'
import { testHarnessSnapshot } from './test-support/harness-snapshot'

const { launchTerminalSpawn, recoverTerminalProcess } = await import('./control/session')

const SELECTED = '/opt/homebrew/bin/codex'
const REPLACEMENT = '/usr/local/other/codex'
/** A version the Codex hook installer accepts, and one it refuses. */
const SELECTED_VERSION = 'codex-cli 0.162.0'
const REPLACEMENT_VERSION = 'codex-cli 0.1.0'

/** The real section install, for a test that wraps it. */
const realCodexInstall = codexInstrumentation.install.bind(codexInstrumentation)
function codexInstrumentationInstall(destination: InstrumentationDestination) {
  return realCodexInstall(destination)
}

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A generation whose Codex is `path` at `version`. */
function generation(path: string, version: string, number: number): ResolvedHarnessInventory {
  const base = testHarnessSnapshot({ codex: path }, number)
  const executables = new Map(base.executables)
  executables.set('codex', { kind: 'codex', path, version, generation: number })
  return { ...base, executables }
}

interface Seen {
  observed: SessionObserverInit[]
  spawned: SpawnOptions[]
  attached: number
}

/**
 * A daemon context whose agent runtime does what the terminal family does
 * with its host port: install the hooks from the spec, launch from the same
 * spec, register the handle, announce. `beforeInstall` runs between the
 * spawn's spec assembly and the hook install: the window an inventory refresh
 * must not reach into.
 */
async function world(
  opts: { beforeInstall?: (runtime: DaemonHarnessRuntime) => Promise<void> } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'podium-session-context-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.codex'))
  const builds = [
    generation(SELECTED, SELECTED_VERSION, 0),
    generation(REPLACEMENT, REPLACEMENT_VERSION, 1),
  ]
  const harnessRuntime = new DaemonHarnessRuntime({
    buildSnapshot: async (number) => builds[Math.min(number, builds.length - 1)]!,
  })
  const seen: Seen = { observed: [], spawned: [], attached: 0 }
  const attachment = (): DurableAttachment =>
    ({
      pid: 4242,
      holdsWriterLease: () => true,
      onFrame: () => () => {},
      onTitle: () => () => {},
      onExit: () => () => {},
      onLeaseLost: () => () => {},
      write: () => {},
      writeBytes: () => {},
      resize: () => {},
      size: () => ({ cols: 80, rows: 24 }),
      dispose: () => {},
    }) as unknown as DurableAttachment
  const durable = stubDurable((spawned) => {
    seen.spawned.push(spawned)
    return attachment()
  })
  durable.locate = async () =>
    ({
      socketPath: '/tmp/podium-session-context.sock',
      adapter: {
        attach: async () => {
          seen.attached += 1
          return { attachment: attachment(), cmd: 'podium-host attach' }
        },
      },
    }) as unknown as Awaited<ReturnType<typeof durable.locate>>
  // Calls through to the real Codex section install; the spy only records.
  const installSpy = vi.spyOn(codexInstrumentation, 'install')
  const launch = vi.spyOn(harnessRuntime, 'launch')
  const handles = new Map<SessionId, AgentSessionHandle>()
  const ctx = {
    send: (message: { type: string; message?: string }) => {
      if (message.type === 'spawnError') throw new Error(`spawn failed: ${message.message}`)
    },
    instanceId: 'default',
    instanceUuid: 'session-context-test',
    backend: 'host',
    durable,
    machineId: 'session-context-test-machine',
    settingsDir: join(home, 'settings'),
    homeDir: home,
    harnessRuntime,
    launch: () => {
      throw new Error('production launches through the harness runtime')
    },
    sessions: testSessions(),
    durableLabelFor: (id: string) => `podium-${id}`,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    composerEngine: {
      attach: () => false,
      onData: () => {},
      onResize: () => {},
      detach: () => {},
      has: () => false,
    },
    outputScheduler: { enqueue: () => {}, remove: () => {}, priorityOf: () => 0 },
    observers: {
      initSessionObservers: (
        _msg: unknown,
        _session: unknown,
        _provider: unknown,
        init: SessionObserverInit,
      ) => void seen.observed.push(init),
      clearSession: () => {},
      onResize: () => {},
      trackedState: () => undefined,
    },
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    reattachGate: <T>(fn: () => Promise<T>) => fn(),
    tailSeedGate: async () => {},
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
  } as unknown as DaemonContext
  const host = daemonRuntimeHost(ctx, () => {})
  ctx.agentRuntime = {
    async create(spec: SessionSpec, sessionId: SessionId) {
      await opts.beforeInstall?.(harnessRuntime)
      const instrumentation = await host.installInstrumentation(sessionId, spec)
      const launched = await host.launch({ sessionId, spec, instrumentation })
      const handle = {
        binding: {
          sessionId,
          harness: spec.harness,
          family: 'terminal',
          driver: spec.selection.preference,
        },
      } as AgentSessionHandle
      handles.set(sessionId, handle)
      launched.announce()
      return handle
    },
    handleFor: (sessionId: SessionId) => handles.get(sessionId),
    has: (sessionId: SessionId) => handles.has(sessionId),
  } as unknown as DaemonContext['agentRuntime']
  return { home, ctx, harnessRuntime, seen, installSpy, launch }
}

async function spawnCodex(ctx: DaemonContext, sessionId: SessionId): Promise<void> {
  await launchTerminalSpawn(ctx, {
    type: 'spawn',
    sessionId,
    agentKind: 'codex',
    cwd: '/repo',
    geometry: { cols: 80, rows: 24 },
  } as Parameters<typeof launchTerminalSpawn>[1])
}

describe('the session-pinned harness context', () => {
  it('hands one context object to hook install, launch and the observer', async () => {
    const { ctx, seen, installSpy, launch } = await world()
    const sessionId = asSessionId('one-context')
    await spawnCodex(ctx, sessionId)

    expect(installSpy).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(seen.observed).toHaveLength(1)
    const installed = installSpy.mock.calls[0]![0].harnessContext
    const launched = launch.mock.calls[0]![0]
    const observed = seen.observed[0]!.harnessContext
    expect(installed).toBeDefined()
    expect(launched).toBe(installed)
    expect(observed).toBe(installed)
    // And the session keeps that same value for a later observer re-init.
    expect(ctx.sessions.get(sessionId)?.harnessContext).toBe(installed)
  })

  it('keeps launch, hook version and observer folders on the spawn-time installation across a refresh', async () => {
    const { home, ctx, seen, installSpy } = await world({
      // Spawn started while the inventory selected SELECTED; the refresh lands
      // before the hooks are installed and the process is launched.
      beforeInstall: async (runtime) => {
        await runtime.refresh()
      },
    })
    await spawnCodex(ctx, asSessionId('refresh-guard'))

    // argv[0] is the spawn-time executable, not the refreshed one.
    expect(seen.spawned).toHaveLength(1)
    expect(seen.spawned[0]!.cmd).toBe(SELECTED)
    // The installer gated on the spawn-time version: it installed the hooks
    // (left untrusted, no config.toml approval) instead of refusing the
    // replacement's unsupported version.
    const destination = installSpy.mock.calls[0]![0]
    expect(destination.harnessContext.installation).toMatchObject({
      executable: SELECTED,
      version: SELECTED_VERSION,
    })
    const wiring = await installSpy.mock.results[0]!.value
    expect(wiring.degradedKind).not.toBe('unsupported-version')
    // The observer reads the spawn-time context's folders.
    const observed = seen.observed[0]!.harnessContext!
    expect(observed.installation.executable).toBe(SELECTED)
    expect(observed.roots.state).toBe(join(home, '.codex'))
  })

  it('keeps the spawn-time installation when the refresh lands between hook install and launch', async () => {
    const { ctx, harnessRuntime, seen, installSpy } = await world()
    installSpy.mockImplementationOnce(async (destination) => {
      const wiring = await codexInstrumentationInstall(destination)
      await harnessRuntime.refresh()
      return wiring
    })
    await spawnCodex(ctx, asSessionId('refresh-after-install'))
    expect(seen.spawned[0]!.cmd).toBe(SELECTED)
    expect(seen.observed[0]!.harnessContext!.installation.executable).toBe(SELECTED)
  })

  it('rebuilds the context after a daemon restart: same folders, nothing relaunched', async () => {
    const before = await world()
    const sessionId = asSessionId('reattach-rebuild')
    await spawnCodex(before.ctx, sessionId)
    const spawnRoots = before.seen.observed[0]!.harnessContext!.roots
    expect(before.seen.spawned).toHaveLength(1)

    // THE RESTART: a fresh daemon over the same home. Its inventory has since
    // moved on (the replacement generation), and it holds no session state.
    const after = await world()
    after.ctx.homeDir = before.home
    await after.harnessRuntime.refresh()
    expect(after.ctx.sessions.get(sessionId)).toBeUndefined()

    const recovered = await recoverTerminalProcess(after.ctx, {
      sessionId,
      agentKind: 'codex',
      workdir: '/repo',
      lease: { observerGeneration: 2, bindingVersion: 1 },
    } as Parameters<typeof recoverTerminalProcess>[1])
    expect(recovered).toBeDefined()

    // Re-attached to the running process, never relaunched.
    expect(after.seen.attached).toBe(1)
    expect(after.seen.spawned).toHaveLength(0)
    expect(after.launch).not.toHaveBeenCalled()
    // The observer got a context rebuilt from the current inventory, whose
    // folders are the ones the observer read before the restart.
    expect(after.seen.observed).toHaveLength(1)
    const rebuilt = after.seen.observed[0]!.harnessContext!
    expect(rebuilt.installation.executable).toBe(REPLACEMENT)
    expect(rebuilt.roots).toEqual(spawnRoots)
    expect(after.ctx.sessions.get(sessionId)?.harnessContext).toBe(rebuilt)
  })
})
