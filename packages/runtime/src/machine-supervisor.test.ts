import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMachineSupervisorConnection,
  effectiveAssignment,
  fallbackAssignment,
  loadSupervisorState,
  reconcileSupervisorAssignment,
  prepareTransferAssignment,
  saveSupervisorState,
  targetTransferRecovery,
  TRANSFER_ASSIGNMENT_FILE,
} from './machine-supervisor'
import { loadConfig, saveConfig } from './config'
import { SERVER_MOVE_CAPABILITY, wireSchemaDigest } from '@podium/protocol'

const dirs: string[] = []

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-machine-supervisor-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('supervisor credential ownership', () => {
  it('imports the exact enrolled daemon identity once without changing the legacy copy', () => {
    const dir = stateDir()
    const legacy = {
      machineId: 'm_legacy',
      token: 'machine-token',
      updatePubkey: 'pinned-update-key',
    }
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify(legacy))

    expect(loadSupervisorState(dir)).toEqual(legacy)
    expect(JSON.parse(readFileSync(join(dir, 'supervisor.json'), 'utf8'))).toEqual(legacy)
    expect(JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8'))).toEqual(legacy)
    expect(statSync(join(dir, 'supervisor.json')).mode & 0o777).toBe(0o600)
  })

  it('never re-imports a legacy credential after supervisor state exists', () => {
    const dir = stateDir()
    writeFileSync(
      join(dir, 'supervisor.json'),
      JSON.stringify({ machineId: 'm_current', token: 'current-token' }),
    )
    writeFileSync(
      join(dir, 'daemon.json'),
      JSON.stringify({ machineId: 'm_legacy', token: 'legacy-token' }),
    )

    expect(loadSupervisorState(dir)).toMatchObject({
      machineId: 'm_current',
      token: 'current-token',
    })
  })
})

describe('supervisor service assignment', () => {
  it('preserves every supported local startup topology as the no-cache fallback', () => {
    expect(fallbackAssignment('server')).toEqual({ server: true, agentExecution: false })
    expect(fallbackAssignment('daemon')).toEqual({ server: false, agentExecution: true })
    expect(fallbackAssignment('all-in-one')).toEqual({ server: true, agentExecution: true })
    expect(fallbackAssignment('supervisor')).toEqual({ server: false, agentExecution: false })
  })

  it('repairs only the unfinished exact config write and consumes its authority', () => {
    const dir = stateDir()
    const state = loadSupervisorState(dir)
    state.assignment = { server: true, agentExecution: true }
    saveSupervisorState(dir, state)
    const prepared = join(dir, 'prepared.json')
    saveConfig({ mode: 'daemon', serverUrl: 'wss://new.example' }, prepared)
    const config = loadConfig(prepared)
    prepareTransferAssignment(config, prepared, dir)
    // A reader before rename cannot consume the writer's recovery record.
    reconcileSupervisorAssignment(state, {}, dir)
    expect(existsSync(join(dir, TRANSFER_ASSIGNMENT_FILE))).toBe(true)
    renameSync(prepared, join(dir, 'config.json'))
    expect(reconcileSupervisorAssignment(state, config, dir)).toEqual({ server: false, agentExecution: true })
    expect(loadSupervisorState(dir).assignment).toEqual({ server: false, agentExecution: true })
    expect(existsSync(join(dir, TRANSFER_ASSIGNMENT_FILE))).toBe(false)
    const intentional = { server: true, agentExecution: false }
    expect(reconcileSupervisorAssignment({ ...state, assignment: intentional }, config, dir)).toEqual(intentional)
  })

  it('does not let old backups or a superseded config transaction override later policy', () => {
    const dir = stateDir()
    const state = loadSupervisorState(dir)
    const intentional = { server: false, agentExecution: false }
    state.assignment = intentional
    for (const role of ['cutover', 'server-promotion']) {
      writeFileSync(join(dir, `config.json.backup-${role}-11111111-1111-4111-8111-111111111111`), '{}')
    }
    const prepared = join(dir, 'prepared.json')
    saveConfig({ mode: 'server' }, prepared)
    const config = loadConfig(prepared)
    prepareTransferAssignment(config, prepared, dir)
    // Same bytes in a later setup are not the transfer's atomic config write.
    saveConfig(config, join(dir, 'config.json'))
    expect(reconcileSupervisorAssignment(state, config, dir)).toEqual(intentional)
    expect(reconcileSupervisorAssignment(state, { mode: 'daemon' }, dir)).toEqual(intentional)
  })

  it('retains target recovery only until acknowledgement or endpoint finalization', () => {
    const dir = stateDir()
    const state = loadSupervisorState(dir)
    const root = join(dir, '.server-transfer', '11111111-1111-4111-8111-111111111111')
    mkdirSync(root, { recursive: true })
    const meta = { targetMachineId: state.machineId, publicUrl: 'https://new.example', state: 'promoted' }
    writeFileSync(join(root, 'state.json'), JSON.stringify(meta))
    const config = { mode: 'server' as const, serverUrl: 'wss://old.example', publicUrl: meta.publicUrl }
    expect(targetTransferRecovery(state, config, dir)).toBe(true)
    expect(targetTransferRecovery(state, { ...config, serverUrl: undefined }, dir)).toBe(false)
    expect(targetTransferRecovery(state, { ...config, publicUrl: 'https://later.example' }, dir)).toBe(false)
    writeFileSync(join(root, 'state.json'), JSON.stringify({ ...meta, acknowledged: true }))
    expect(targetTransferRecovery(state, config, dir)).toBe(false)
  })

  it('lets the local lockout subtract agents but never add or remove the server', () => {
    expect(
      effectiveAssignment({
        configured: { server: true, agentExecution: true },
        agentExecutionLockout: true,
      }),
    ).toEqual({ server: true, agentExecution: false })
    expect(
      effectiveAssignment({
        configured: { server: false, agentExecution: false },
        agentExecutionLockout: false,
      }),
    ).toEqual({ server: false, agentExecution: false })
  })
})


describe('supervisor endpoint reconfiguration', () => {
  it('renews same-endpoint credentials and rejects stale socket events after endpoint changes', () => {
    vi.useFakeTimers()
    class Socket extends EventTarget {
      static OPEN = 1
      static all: Socket[] = []
      readyState = 1
      sent: Array<Record<string, any>> = []
      constructor(readonly url: string) { super(); Socket.all.push(this) }
      send(raw: string) { this.sent.push(JSON.parse(raw)) }
      close() {} // The external transport may deliver close much later.
      open() { this.dispatchEvent(new Event('open')) }
      message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
      accept() { this.open(); this.message({ type: 'peerHelloOk', v: this.sent[0]!.v, caps: [] }) }
    }
    vi.stubGlobal('WebSocket', Socket)
    const dir = stateDir()
    const state = loadSupervisorState(dir)
    let endpoint = 'ws://old.example'
    let token = 'old-secret'
    let acceptAssignment = true
    const service = { policy: 'enabled' as const, state: 'available' as const, observedAt: new Date().toISOString() }
    const connection = createMachineSupervisorConnection({
      serverUrl: () => endpoint, bootstrapToken: () => token, stateDir: dir, state,
      build: { appVersion: 'test', wireSchemaDigest: wireSchemaDigest() },
      deliveryCaps: [SERVER_MOVE_CAPABILITY, 'update.delivery.feed'],
      report: () => ({ server: service, agentExecution: service }),
      acceptAssignment: () => acceptAssignment,
      onGrant: vi.fn(),
    })
    try {
      connection.start()
      const old = Socket.all[0]!
      old.accept()
      expect(old.sent[0]!.caps).toEqual([SERVER_MOVE_CAPABILITY, 'update.delivery.feed'])
      token = 'new-secret'
      connection.reconfigure()
      const same = Socket.all[1]!
      expect(same.url).toBe(old.url)
      same.accept()
      expect(same.sent[0]!.credential).toEqual({ kind: 'daemonSecret', secret: 'new-secret' })
      endpoint = 'ws://new.example'
      connection.reconfigure()
      const fresh = Socket.all[2]!
      fresh.accept()
      const assignment = { server: false, agentExecution: true }
      fresh.message({ type: 'serviceAssignment', assignment })
      old.message({ type: 'serviceAssignment', assignment: { server: true, agentExecution: false } })
      same.dispatchEvent(new Event('close'))
      old.dispatchEvent(new Event('close'))
      vi.advanceTimersByTime(10_000)
      expect(Socket.all).toHaveLength(3)
      expect(loadSupervisorState(dir).assignment).toEqual(assignment)
      const connectivity = JSON.parse(readFileSync(join(dir, 'connectivity.json'), 'utf8'))
      expect(connectivity).toMatchObject({ serverUrl: endpoint, state: 'connected' })
      acceptAssignment = false
      fresh.message({ type: 'serviceAssignment', assignment: { server: true, agentExecution: false } })
      expect(loadSupervisorState(dir).assignment).toEqual(assignment)
    } finally { connection.close() }
  })
})
