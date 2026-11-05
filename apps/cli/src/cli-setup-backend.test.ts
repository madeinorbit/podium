import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { readConnectivityForTest, writeConnectivity } from '@podium/runtime/connectivity'
import { encodeJoin } from '@podium/runtime/join'
import { readMachineState, readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { createMachineCredential, machinePublicKeyWire } from '@podium/runtime/machine-credential'
import {
  createMachineSupervisorConnection,
  loadSupervisorState,
  reconcileSupervisorAssignment,
} from '@podium/runtime/machine-supervisor'
import { consumePairCode } from '@podium/runtime/setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runJoinSetup, startBackendEngine, waitForDaemonEnrollment } from './cli-setup'

const adapters = vi.hoisted(() => ({
  stop: vi.fn<typeof import('./cli-lifecycle').stopBackend>(),
  detached: vi.fn<typeof import('./cli-spawn').startDetachedStack>(),
  systemd: vi.fn<typeof import('./cli-systemd').installSystemd>(),
  failStateWrite: false,
}))

// Execute the production starter, but never stop or spawn an operator's backend.
vi.mock('./cli-lifecycle', () => ({ stopBackend: adapters.stop, localStableLink: vi.fn() }))
vi.mock('./cli-spawn', () => ({ startDetachedStack: adapters.detached }))
vi.mock('./cli-systemd', () => ({
  installSystemd: adapters.systemd,
  hasSystemctl: () => false,
  hasUserSystemd: () => false,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (source: string, target: string) => {
      if (adapters.failStateWrite && target === `${process.env.PODIUM_STATE_DIR}/machine.json`)
        throw new Error('machine state persistence failed')
      return actual.renameSync(source, target)
    },
  }
})

describe('daemon setup backend preserves machine identity', () => {
  let dir: string
  const coordinator = `pdm_${'c'.repeat(43)}`
  const otherCoordinator = `pdm_${'o'.repeat(43)}`
  const token = encodeJoin({ v: 1, serverUrl: 'wss://coordinator.example', pairCode: 'NEW-CODE' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setup-backend-'))
    vi.stubEnv('PODIUM_STATE_DIR', dir)
    // Join's optional remote metadata lookups must stay hermetic too.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline fixture')))
    adapters.stop.mockReset().mockResolvedValue(undefined)
    adapters.detached.mockReset().mockResolvedValue({ serverUp: true })
    adapters.systemd.mockReset().mockReturnValue({ ok: true })
    adapters.failStateWrite = false
    saveConfig({
      mode: 'daemon',
      serverUrl: 'wss://coordinator.example',
      installationId: coordinator,
    })
  })
  afterEach(() => {
    adapters.failStateWrite = false
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  const machinePath = () => join(dir, 'machine.json')
  const keyBytes = () => readFileSync(join(dir, 'machine.key'))
  const seedEnrolled = (state = 'connected') => {
    const key = createMachineCredential(dir)
    const retained = {
      version: 1,
      machineId: 'enrolled-machine',
      supervisor: {
        machineId: 'enrolled-machine',
        token: 'retained-supervisor-token',
        enrolledPublicKey: machinePublicKeyWire(key),
        updatePubkey: 'retained-update-pin',
        workspaceId: 'workspace',
        assignment: { server: false, agentExecution: true },
        generation: 7,
      },
      daemon: { machineId: 'enrolled-machine', token: 'legacy-token', updatePubkey: 'legacy-pin' },
      role: { mode: 'daemon', coordinator },
      legacy: { machineId: 'original-legacy-id' },
      importedFiles: { 'machine.id': 'retained-import-receipt' },
      extension: { unrelated: ['retain', 'verbatim'] },
    }
    writeFileSync(
      machinePath(),
      JSON.stringify({
        ...retained,
        connectivity: {
          state,
          updatedAt: '2026-01-01T00:00:00Z',
          lastHelloOkAt: '2026-01-01T00:00:00Z',
          authorizationReason: 'old-authorization',
          blockedReason: 'old-refusal',
        },
      }),
    )
    return retained
  }

  it.each([
    'systemd',
    'detached',
    'fallback',
  ] as const)('retains every unrelated section and exact key over repeated %s starts', async (path) => {
    const retained = seedEnrolled()
    const key = keyBytes()
    const order: string[] = []
    adapters.stop.mockImplementation(async () => {
      expect(readConnectivityForTest(dir)).toBeDefined()
      await Promise.resolve()
      expect(readConnectivityForTest(dir)).toBeDefined()
      order.push('stop')
    })
    const started = () => {
      expect(order.at(-1)).toBe('stop')
      expect(readMachineState(dir)).toEqual(retained)
      expect(keyBytes()).toEqual(key)
      order.push('start')
      writeConnectivity({ state: 'connected', processId: process.pid }, dir)
    }
    adapters.systemd.mockImplementation(() => {
      if (path === 'fallback') return { ok: false, reason: 'fixture has no user systemd' }
      started()
      return { ok: true }
    })
    adapters.detached.mockImplementation(async () => {
      started()
      return { serverUp: true }
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await startBackendEngine({
        mode: 'daemon',
        port: 18787,
        persistence: path === 'detached' ? 'detached' : 'systemd',
      })
      expect(result.effectivePersistence).toBe(path === 'systemd' ? 'systemd' : 'detached')
      await expect(waitForDaemonEnrollment()).resolves.toBeUndefined()
      const { connectivity, ...after } = JSON.parse(readFileSync(machinePath(), 'utf8'))
      expect(after).toEqual(retained)
      expect(connectivity.state).toBe('connected')
      expect(connectivity.lastHelloOkAt).toBeUndefined()
      expect(readOrCreateLocalMachineId(dir)).toBe(retained.machineId)
      expect(keyBytes()).toEqual(key)
    }
    expect(order).toEqual(['stop', 'start', 'stop', 'start'])
    if (path === 'systemd') expect(adapters.detached).not.toHaveBeenCalled()
  })

  describe.each(['connected', 'unauthorized', 'blocked'] as const)('old %s status', (old) => {
    it.each([
      'connected',
      'unauthorized',
      'blocked',
      'never-connects',
    ] as const)('lets only the new %s result determine the join outcome', async (next) => {
      const retained = seedEnrolled(old)
      let time = 0
      let polls = 0
      const wait = () =>
        waitForDaemonEnrollment({
          timeoutMs: 300,
          pollMs: 100,
          now: () => time,
          sleep: async (ms) => {
            time += ms
            polls++
            if (polls === 1 && next !== 'never-connects') {
              writeConnectivity(
                {
                  state: next,
                  processId: process.pid,
                  authorizationReason: next === 'unauthorized' ? 'new-authorization' : undefined,
                  blockedReason: next === 'blocked' ? 'new-refusal' : undefined,
                },
                dir,
              )
            }
          },
        })
      // No replacement startBackend: runJoinSetup executes the real cleanup/start path.
      const joining = runJoinSetup(token, 'detached', 18787, { waitForEnrollment: wait })
      if (next === 'connected')
        await expect(joining).resolves.toMatchObject({ name: expect.any(String) })
      else
        await expect(joining).rejects.toThrow(
          next === 'never-connects'
            ? /did not connect within/
            : next === 'blocked'
              ? /new-refusal/
              : /new-authorization/,
        )
      expect(polls).toBe(next === 'never-connects' ? 3 : 1)
      const { connectivity: _status, ...after } = JSON.parse(readFileSync(machinePath(), 'utf8'))
      expect(after).toEqual(retained)
    })
  })

  it('leaves state untouched and never starts a replacement when stopping fails', async () => {
    seedEnrolled()
    const before = readFileSync(machinePath())
    const key = keyBytes()
    adapters.stop.mockRejectedValue(new Error('stop failed'))
    await expect(
      startBackendEngine({ mode: 'daemon', persistence: 'systemd', port: 18787 }),
    ).rejects.toThrow('stop failed')
    expect(readFileSync(machinePath())).toEqual(before)
    expect(keyBytes()).toEqual(key)
    expect(adapters.systemd).not.toHaveBeenCalled()
    expect(adapters.detached).not.toHaveBeenCalled()
  })

  it.each([
    'corrupt JSON',
    'invalid schema',
    'persistence failure',
  ])('refuses enrollment after %s instead of deleting state or reporting success', async (failure) => {
    seedEnrolled()
    if (failure === 'corrupt JSON') writeFileSync(machinePath(), '{broken')
    if (failure === 'invalid schema') writeFileSync(machinePath(), '{"version":2}')
    adapters.failStateWrite = failure === 'persistence failure'
    const before = readFileSync(machinePath())
    const wait = vi.fn(async () => {})
    await expect(
      runJoinSetup(token, 'systemd', 18787, { waitForEnrollment: wait }),
    ).rejects.toThrow()
    expect(readFileSync(machinePath())).toEqual(before)
    expect(adapters.stop).toHaveBeenCalledOnce()
    expect(adapters.systemd).not.toHaveBeenCalled()
    expect(adapters.detached).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
  })

  it('does not rewrite an existing identity when there is no connectivity to clear', async () => {
    const retained = seedEnrolled()
    writeFileSync(machinePath(), JSON.stringify(retained))
    const before = readFileSync(machinePath())
    await startBackendEngine({ mode: 'daemon', persistence: 'detached', port: 18787 })
    expect(readFileSync(machinePath())).toEqual(before)
    expect(readOrCreateLocalMachineId(dir)).toBe(retained.machineId)
  })

  it.each([
    'systemd',
    'detached',
    'fallback',
  ] as const)('leaves identity creation to fresh %s enrollment, which still joins successfully', async (path) => {
    let enrolledId: string | undefined
    const enroll = () => {
      expect(existsSync(machinePath())).toBe(false)
      expect(existsSync(join(dir, 'machine.key'))).toBe(false)
      enrolledId = readOrCreateLocalMachineId(dir)
      createMachineCredential(dir)
      writeConnectivity({ state: 'connected', processId: process.pid }, dir)
    }
    adapters.systemd.mockImplementation(() => {
      if (path === 'fallback') return { ok: false, reason: 'fixture has no user systemd' }
      enroll()
      return { ok: true }
    })
    adapters.detached.mockImplementation(async () => {
      enroll()
      return { serverUp: true }
    })
    const persistence = path === 'systemd' ? 'systemd' : 'detached'
    await expect(
      runJoinSetup(token, path === 'detached' ? 'detached' : 'systemd', 18787),
    ).resolves.toMatchObject({
      result: { effectivePersistence: persistence },
    })
    expect(loadConfig().persistence).toBe(persistence)
    expect(readOrCreateLocalMachineId(dir)).toBe(enrolledId)
    expect(keyBytes().length).toBeGreaterThan(0)
  })

  it.each(['all-in-one', 'server'] as const)('does not clear status for %s setup', async (mode) => {
    seedEnrolled()
    const before = readFileSync(machinePath())
    await startBackendEngine({ mode, persistence: 'detached', port: 18787 })
    expect(readFileSync(machinePath())).toEqual(before)
    expect(adapters.detached).toHaveBeenCalledWith(mode, 18787, loadConfig().bindHost)
  })

  it('imports legacy identity and credentials before retiring only their exact old files', async () => {
    const daemon = {
      machineId: 'legacy-machine',
      token: 'legacy-token',
      updatePubkey: 'legacy-pin',
    }
    const supervisor = {
      ...daemon,
      generation: 4,
      assignment: { server: false, agentExecution: true },
    }
    const legacy = {
      'machine.id': daemon.machineId,
      'daemon.json': JSON.stringify(daemon),
      'supervisor.json': JSON.stringify(supervisor),
      'connectivity.json': JSON.stringify({
        state: 'connected',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    }
    for (const [name, bytes] of Object.entries(legacy)) writeFileSync(join(dir, name), bytes)
    createMachineCredential(dir)
    const key = keyBytes()
    writeFileSync(join(dir, 'daemon.secret'), 'retained-maintenance-secret')
    writeFileSync(join(dir, 'unrelated.json'), '{"keep":true}')
    await startBackendEngine({ mode: 'daemon', persistence: 'detached', port: 18787 })
    expect(readMachineState(dir)).toEqual({
      version: 1,
      machineId: daemon.machineId,
      daemon,
      supervisor,
      legacy: { machineId: daemon.machineId },
      importedFiles: Object.fromEntries(
        Object.entries(legacy).map(([name, bytes]) => [
          name,
          createHash('sha256').update(bytes).digest('hex'),
        ]),
      ),
    })
    expect(readdirSync(dir).sort()).toEqual([
      'config.json',
      'daemon.secret',
      'instance.json',
      'machine.json',
      'machine.key',
      'unrelated.json',
    ])
    expect(keyBytes()).toEqual(key)
    expect(readFileSync(join(dir, 'daemon.secret'), 'utf8')).toBe('retained-maintenance-secret')
    expect(readFileSync(join(dir, 'unrelated.json'), 'utf8')).toBe('{"keep":true}')
  })

  it.each([
    'consumed',
    'newer',
  ] as const)('uses the new coordinator authorization, retains identity and handles the %s code after acknowledgement', async (code) => {
    const retained = seedEnrolled()
    const key = keyBytes()
    await startBackendEngine({ mode: 'daemon', persistence: 'detached', port: 18787 })
    const state = loadSupervisorState(dir)
    reconcileSupervisorAssignment(state, loadConfig(), dir)
    expect(loadSupervisorState(dir)).toEqual(retained.supervisor)
    const other = {
      ...loadConfig(),
      installationId: otherCoordinator,
      serverUrl: 'wss://other.example',
      pairCode: 'OTHER-CODE',
    }
    saveConfig(other)
    reconcileSupervisorAssignment(state, other, dir)
    const changed = loadSupervisorState(dir)
    for (const field of [
      'token',
      'enrolledPublicKey',
      'updatePubkey',
      'workspaceId',
      'setupEnrollment',
    ] as const)
      expect(changed[field]).toBeUndefined()
    expect(changed.machineId).toBe(retained.machineId)
    expect(keyBytes()).toEqual(key)
    expect(loadConfig().pairCode).toBe('OTHER-CODE')
    expect(readMachineState(dir)?.role).toEqual({ mode: 'daemon', coordinator: otherCoordinator })

    const sockets: Socket[] = []
    class Socket extends EventTarget {
      static OPEN = 1
      readyState = 1
      sent: Array<Record<string, unknown>> = []
      constructor(readonly url: string) {
        super()
        sockets.push(this)
      }
      send(raw: string) {
        this.sent.push(JSON.parse(raw))
      }
      close() {}
    }
    vi.stubGlobal('WebSocket', Socket)
    const service = {
      policy: 'enabled' as const,
      state: 'available' as const,
      observedAt: new Date().toISOString(),
    }
    const connection = createMachineSupervisorConnection({
      serverUrl: other.serverUrl,
      pairCode: other.pairCode,
      stateDir: dir,
      state: changed,
      build: { appVersion: 'test' },
      deliveryCaps: [],
      report: () => ({ server: service, agentExecution: service }),
      onGrant: vi.fn(),
      onPaired: () => consumePairCode(other.pairCode),
    })
    try {
      connection.start()
      const socket = sockets[0]
      if (!socket) throw new Error('missing new-coordinator connection')
      socket.dispatchEvent(new Event('open'))
      expect(socket.url).toBe(`${other.serverUrl}/machine`)
      expect(socket.sent[0]?.credential).toEqual({
        kind: 'pairCode',
        code: other.pairCode,
        publicKey: retained.supervisor.enrolledPublicKey,
      })
      expect(loadConfig().pairCode).toBe(other.pairCode)
      if (code === 'newer') saveConfig({ ...loadConfig(), pairCode: 'NEWER-CODE' })
      socket.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'peerHelloOk',
            v: socket.sent[0]?.v,
            caps: [],
            enrolledPublicKey: retained.supervisor.enrolledPublicKey,
          }),
        }),
      )
      expect(loadConfig().pairCode).toBe(code === 'newer' ? 'NEWER-CODE' : undefined)
      expect(loadSupervisorState(dir).enrolledPublicKey).toBe(retained.supervisor.enrolledPublicKey)
      expect(readOrCreateLocalMachineId(dir)).toBe(retained.machineId)
      expect(keyBytes()).toEqual(key)
    } finally {
      connection.close()
    }
  })
})
