import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionHandle } from '@podium/agent-runtime'
import { asMachineId, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { buildReport } from './build-report'
import { createDaemonHostRuntime } from './host-runtime'
import type { DaemonMachineRuntime } from './runtime/machine-runtime'
import { isServerDriver } from './runtime/registry'
import type { ServerReapIo } from './runtime/server-reap'

const SESSION = 'full-reap-session' as SessionId

const SERVER_FAMILIES = [
  { driver: 'opencode-server', harness: 'opencode' },
  { driver: 'codex-app-server', harness: 'codex' },
  { driver: 'grok-acp', harness: 'grok' },
] as const

function reapIo(state: { alive: boolean }): ServerReapIo & { signals: string[] } {
  const signals: string[] = []
  return {
    signals,
    pidAlive: () => state.alive,
    signal: (_pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL') state.alive = false
    },
    pidInUnit: () => false,
    probeOpencode: async () => false,
    runSystemctl: async () => {},
    sleep: async () => {},
    canScope: () => false,
  }
}

type TestAgentRuntime = Pick<
  DaemonMachineRuntime,
  'registeredBindings' | 'serverHandleFor' | 'journalledServerProcess' | 'dispose'
>

async function createCloseHost(
  runtime: TestAgentRuntime,
  io: ServerReapIo,
): Promise<{
  host: Awaited<ReturnType<typeof createDaemonHostRuntime>>
  sent: DaemonMessage[]
  cleanup(): void
}> {
  const root = mkdtempSync(join(tmpdir(), 'podium-host-close-'))
  const instance = {
    instanceId: 'default',
    instanceUuid: '11111111-1111-4111-8111-111111111111',
    runtimeDir: join(root, 'runtime'),
    settingsDir: join(root, 'settings'),
    hookSocketPath: join(root, 'runtime', 'codex-hooks.sock'),
    codexReceiptDir: join(root, 'receipts'),
    releaseGuards: () => {},
  }
  const previousStateDir = process.env.PODIUM_STATE_DIR
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  const sent: DaemonMessage[] = []
  const cleanup = (): void => {
    if (previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previousStateDir
    rmSync(root, { recursive: true, force: true })
  }

  try {
    const host = await createDaemonHostRuntime({
      options: {
        serverUrl: 'ws://127.0.0.1:1',
        identityDir: join(root, 'identity'),
        machineId: asMachineId('11111111-1111-4111-8111-111111111111'),
        backend: 'none',
        launch: () => ({ cmd: process.execPath, args: [], cwd: root }),
        hooks: { port: 0, settingsDir: instance.settingsDir },
        agentRelay: { port: 0 },
        discovery: { background: false, cachePath: ':memory:', homeDir: root },
        metrics: { background: false },
      },
      instance,
      build: buildReport({}, undefined, 'test'),
      installDir: undefined,
      send: (message) => void sent.push(message),
      sendOutput: () => {},
      acknowledgeQueueDrainReport: () => {},
      acknowledgeRuntimeEvent: () => {},
      testAgentRuntime: runtime,
      testServerReapIo: io,
    })
    return { host, sent, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

describe('full-reap daemon close', () => {
  it.each(SERVER_FAMILIES)('$driver leaves no live child behind', async ({ driver, harness }) => {
    const state = { alive: true }
    const calls: string[] = []
    let releaseKill!: () => void
    const killGate = new Promise<void>((resolve) => {
      releaseKill = resolve
    })
    const disposed = vi.fn()

    const handle = {
      binding: {
        sessionId: SESSION,
        driver,
        family: 'server',
        harness,
        workdir: '/tmp/full-reap',
        resume: null,
        process: { key: `full-reap:${SESSION}`, pid: 4321 },
        bindingVersion: 1,
      },
      async kill() {
        calls.push('kill')
        await killGate
      },
    } as unknown as AgentSessionHandle
    const runtime = {
      registeredBindings: () => [handle.binding],
      serverHandleFor: (sessionId: SessionId) =>
        sessionId === SESSION && isServerDriver(harness, driver) ? handle : undefined,
      journalledServerProcess: () => undefined,
      dispose: disposed,
    } as unknown as Pick<
      DaemonMachineRuntime,
      'registeredBindings' | 'serverHandleFor' | 'journalledServerProcess' | 'dispose'
    >

    const io = reapIo(state)
    const { host, sent, cleanup } = await createCloseHost(runtime, io)
    let closing: Promise<void> | undefined
    try {
      closing = host.close({ reapSessions: true })
      await vi.waitFor(() => expect(calls).toEqual(['kill']))
      expect(disposed).not.toHaveBeenCalled()
      releaseKill()
      await closing
      expect(disposed).toHaveBeenCalledOnce()

      expect(state.alive).toBe(false)
      expect(io.signals).toEqual(['SIGKILL'])
      expect(calls).toEqual(['kill', 'kill'])
      expect(sent.find((message) => message.type === 'sessionKillResult')).toMatchObject({
        killed: true,
        sessionId: SESSION,
      })
    } finally {
      releaseKill()
      await closing?.catch(() => undefined)
      await host?.close().catch(() => undefined)
      cleanup()
    }
  })

  it('continues host teardown when the server binding snapshot rejects', async () => {
    const disposed = vi.fn()
    const runtime = {
      registeredBindings: () => {
        throw new Error('binding snapshot unavailable')
      },
      serverHandleFor: () => undefined,
      journalledServerProcess: () => undefined,
      dispose: disposed,
    } as unknown as TestAgentRuntime
    const { host, cleanup } = await createCloseHost(runtime, reapIo({ alive: true }))
    try {
      await expect(host.close({ reapSessions: true })).resolves.toBeUndefined()
      expect(disposed).toHaveBeenCalledOnce()
    } finally {
      await host.close().catch(() => undefined)
      cleanup()
    }
  })

  it('bounds the returned close when a server kill never settles', async () => {
    const state = { alive: true }
    const calls: string[] = []
    let releaseKill!: () => void
    const killGate = new Promise<void>((resolve) => {
      releaseKill = resolve
    })
    const disposed = vi.fn()
    const handle = {
      binding: {
        sessionId: SESSION,
        driver: 'opencode-server',
        family: 'server',
        harness: 'opencode',
        workdir: '/tmp/full-reap-bound',
        resume: null,
        process: { key: `full-reap-bound:${SESSION}`, pid: 4321 },
        bindingVersion: 1,
      },
      async kill() {
        calls.push('kill')
        await killGate
      },
    } as unknown as AgentSessionHandle
    const runtime = {
      registeredBindings: () => [handle.binding],
      serverHandleFor: (sessionId: SessionId) => (sessionId === SESSION ? handle : undefined),
      journalledServerProcess: () => undefined,
      dispose: disposed,
    } as unknown as TestAgentRuntime
    const io = reapIo(state)
    const { host, sent, cleanup } = await createCloseHost(runtime, io)
    let closing: Promise<void> | undefined
    let boundTimer: ReturnType<typeof setTimeout> | undefined
    const boundMs = 5_000
    try {
      const startedAt = Date.now()
      closing = host.close({ reapSessions: true })
      await Promise.race([
        closing,
        new Promise<never>((_, reject) => {
          boundTimer = setTimeout(
            () => reject(new Error(`host close exceeded ${boundMs}ms`)),
            boundMs,
          )
        }),
      ])
      expect(Date.now() - startedAt).toBeLessThan(boundMs)
      expect(disposed).toHaveBeenCalledOnce()
      expect(state.alive).toBe(false)
      expect(io.signals).toEqual(['SIGKILL'])
      expect(calls).toEqual(['kill', 'kill'])
      expect(sent.find((message) => message.type === 'sessionKillResult')).toMatchObject({
        killed: true,
        sessionId: SESSION,
      })
    } finally {
      if (boundTimer !== undefined) clearTimeout(boundTimer)
      releaseKill()
      await closing?.catch(() => undefined)
      await host.close().catch(() => undefined)
      cleanup()
    }
  })
})
