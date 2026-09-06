import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateGrantMessage, UpdateStatusMessage } from '@podium/protocol'
import { writeDaemonHealth } from '@podium/runtime/daemon-health'
import { writeRecord } from '@podium/runtime/run-registry'
import { MachineUpdateExecutor, type MachineUpdateAdapter } from '@podium/runtime/machine-update'
import {
  ParentProcess,
  type ParentProcessDeps,
  type SpawnChildFn,
} from '@podium/runtime/parent-process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startParentWithUpdateConfirmation } from './parent-boot-confirmation'

class Child extends EventEmitter {
  pid = process.pid
  exitCode: number | null = null
  kill(): boolean {
    this.exitCode = 0
    this.emit('exit', 0, null)
    return true
  }
}
const grant: UpdateGrantMessage = {
  type: 'updateGrant',
  grantId: 'delayed-boot',
  issuedAt: 1,
  target: { version: '2.0.0', critical: false, artifacts: {} },
}
const roots: string[] = []
const parents: ParentProcess[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  for (const parent of parents.splice(0)) {
    parent.removeSignalHandlers()
    await parent.stop()
  }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function boot(overrides: Partial<ParentProcessDeps> = {}, digest = 'target-digest') {
  const dir = mkdtempSync(join(tmpdir(), 'podium-delayed-boot-'))
  roots.push(dir)
  vi.stubEnv('PODIUM_STATE_DIR', dir)
  writeRecord({ role: 'daemon', pid: process.pid, startedAt: new Date().toISOString() })
  writeDaemonHealth({ state: 'disconnected', processId: process.pid, appVersion: '2.0.0' }, dir)
  const prepare = vi.fn(async () => ({ digest: 'target-digest' }))
  const activate = vi.fn(async () => {})
  const restart = vi.fn(async () => 'handover-pending' as const)
  const adapter: MachineUpdateAdapter = {
    runningVersion: () => '2.0.0',
    runningDigest: () => digest,
    prepare,
    activate,
    restart,
    discard: async () => {},
  }
  // Produce an actual committed journal, then recreate the executor as production does at boot.
  const previous = new MachineUpdateExecutor({
    runtimeDir: dir,
    adapter: { ...adapter, runningVersion: () => '1.0.0', runningDigest: () => 'old' },
    report: () => {},
  })
  await previous.accept(grant)
  expect(previous.snapshot()?.phase).toBe('restarting')
  prepare.mockClear()
  activate.mockClear()
  restart.mockClear()
  const statuses: UpdateStatusMessage[] = []
  const updates = new MachineUpdateExecutor({
    runtimeDir: dir,
    adapter,
    report: (s) => statuses.push(s),
  })
  let now = 0
  const notify = vi.fn()
  const claimRole = vi.fn()
  const finalizePendingGrant = vi.fn()
  const parent = new ParentProcess({
    stateDir: dir,
    installDir: join(dir, 'install'),
    installBinary: '/unused/podium',
    port: 19099,
    env: { PODIUM_APP_VERSION: '2.0.0' },
    children: ['daemon'],
    runningIdentity: { version: '2.0.0', digest },
    spawn: (() => new Child() as unknown as ReturnType<SpawnChildFn>) as SpawnChildFn,
    probeHealth: async () => ({
      serverRunning: false,
      serverVersion: null,
      daemonConnected: false,
    }),
    sleep: async (ms) => {
      now += ms
    },
    now: () => now,
    notify,
    claimRole,
    finalizePendingGrant,
    exit: () => {},
    ...overrides,
  })
  parents.push(parent)
  const afterStart = vi.fn(async () => {
    expect(updates.snapshot()?.phase).toBe('restarting')
  })
  await updates.recoverBeforeBoot()
  await startParentWithUpdateConfirmation(parent, updates, afterStart)
  return {
    parent,
    updates,
    statuses,
    dir,
    notify,
    claimRole,
    finalizePendingGrant,
    prepare,
    activate,
    restart,
    afterStart,
    connect: () =>
      writeDaemonHealth({ state: 'connected', processId: process.pid, appVersion: '2.0.0' }, dir),
    tick: async () => {
      now += 500
      await vi.advanceTimersByTimeAsync(500)
    },
  }
}

describe('production startup confirmation after delayed parent health', () => {
  it('opens the native control endpoint before initial healthy confirmation', async () => {
    const b = await boot({ children: [] })
    expect(b.afterStart).toHaveBeenCalledTimes(1)
    expect(b.updates.snapshot()?.phase).toBe('current')
    expect(b.statuses.filter((s) => s.state === 'current')).toHaveLength(1)
  })

  it('keeps committed admission fenced, then confirms exact running identity once without restarting', async () => {
    const b = await boot()
    expect(b.parent.isBootHealthy()).toBe(false)
    expect(b.updates.snapshot()?.phase).toBe('restarting')
    await expect(b.updates.accept({ ...grant, grantId: 'next', issuedAt: 2 })).rejects.toThrow(
      'update-committed',
    )
    await b.tick()
    expect(b.claimRole).not.toHaveBeenCalled()
    writeDaemonHealth(
      { state: 'connected', processId: process.pid + 1, appVersion: '2.0.0' },
      b.dir,
    )
    await b.tick()
    expect(b.parent.isBootHealthy()).toBe(false)
    writeDaemonHealth(
      { state: 'connected', processId: process.pid, appVersion: 'wrong-version' },
      b.dir,
    )
    await b.tick()
    expect(b.parent.isBootHealthy()).toBe(false)
    b.connect()
    await b.tick()
    await b.tick()
    expect(b.updates.snapshot()?.phase).toBe('current')
    expect(b.statuses.filter((s) => s.state === 'current')).toHaveLength(1)
    expect(b.claimRole).toHaveBeenCalledTimes(1)
    expect(b.finalizePendingGrant).toHaveBeenCalledTimes(1)
    expect(b.notify.mock.calls.filter(([s]) => s === 'READY=1')).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(b.dir, 'run/supervisor-ready.json'), 'utf8'))).toEqual({
      pid: process.pid,
      version: '2.0.0',
      digest: 'target-digest',
    })
    expect(b.prepare).not.toHaveBeenCalled()
    expect(b.activate).not.toHaveBeenCalled()
    expect(b.restart).not.toHaveBeenCalled()
  })

  it('does not confirm a healthy process with the wrong running digest', async () => {
    const b = await boot({}, 'wrong-digest')
    b.connect()
    await b.tick()
    expect(b.statuses.some((s) => s.state === 'current')).toBe(false)
    expect(b.updates.snapshot()?.phase).not.toBe('current')
  })

  it('keeps a combined stack unconfirmed until /version is available, exact, and daemon-connected', async () => {
    let available = false
    let version = 'wrong-version'
    let daemonConnected = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: available,
        json: async () => ({
          appVersion: version,
          daemonConnected,
        }),
      })),
    )
    const b = await boot({ children: ['server', 'daemon'], probeHealth: undefined })
    expect(b.parent.isBootHealthy()).toBe(false)
    expect(b.updates.snapshot()?.phase).toBe('restarting')
    available = true
    await b.tick()
    expect(b.updates.snapshot()?.phase).toBe('restarting')
    version = '2.0.0'
    await b.tick()
    expect(b.updates.snapshot()?.phase).toBe('restarting')
    daemonConnected = true
    await b.tick()
    expect(b.updates.snapshot()?.phase).toBe('current')
  })

  it('ignores an outstanding healthy probe completed after stop', async () => {
    let release!: () => void
    let hold = false
    let heldProbes = 0
    const b = await boot({
      probeDaemonHealth: async () => {
        if (hold) {
          heldProbes++
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return { connected: hold, appVersion: '2.0.0', convergedVersion: null }
      },
    })
    hold = true
    // Synchronous timer advance starts the asynchronous tick without waiting for its held probe.
    vi.advanceTimersByTime(500)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(release).toBeTypeOf('function')
    vi.advanceTimersByTime(1_000)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(heldProbes).toBe(1)
    await b.parent.stop()
    release()
    await vi.advanceTimersByTimeAsync(500)
    expect(b.parent.isBootHealthy()).toBe(false)
    expect(b.updates.snapshot()?.phase).toBe('restarting')
    expect(b.claimRole).not.toHaveBeenCalled()
    expect(b.finalizePendingGrant).not.toHaveBeenCalled()
    expect(b.notify).not.toHaveBeenCalled()
    expect(existsSync(join(b.dir, 'run/supervisor-ready.json'))).toBe(false)
  })

  it('cancels confirmation queued on executor admission when the parent stops', async () => {
    const b = await boot()
    // Admission is the only seam: health and confirmation still use production composition.
    const releaseAdmission = await (
      b.updates as unknown as {
        acquireAdmission(): Promise<() => void>
      }
    ).acquireAdmission()
    b.connect()
    vi.advanceTimersByTime(500)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(b.parent.isBootHealthy()).toBe(true)
    expect(b.updates.snapshot()?.phase).toBe('restarting')
    await b.parent.stop()
    releaseAdmission()
    await vi.advanceTimersByTimeAsync(500)
    expect(b.updates.snapshot()?.phase).toBe('restarting')
    expect(b.statuses.some((s) => s.state === 'current')).toBe(false)
  })
})
