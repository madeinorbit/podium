import { hostname } from 'node:os'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import {
  asMachineId,
  MachineServiceAssignment,
  type MachineServiceReport,
  type MachineId,
} from '@podium/model'
import {
  createHandshakeDialer,
  MachineSupervisorControlMessage,
  type MachineSupervisorMessage,
  type PeerBuild,
  type PeerCredential,
} from '@podium/protocol'
import { createLogger } from '@podium/logger'
import { readOrCreateLocalMachineId } from './local-machine'
import { acceptsUpdateKeyRotation, type UpdateKeyRotation } from './update-key-trust'
import { writeConnectivity } from './connectivity'
import { stateDir, type PodiumConfig } from './config'

const log = createLogger('runtime:machine-supervisor')
const STATE_FILE = 'supervisor.json'
const LEGACY_FILE = 'daemon.json'
export const SUPERVISOR_MACHINE_ID_ENV = 'PODIUM_SUPERVISOR_MACHINE_ID'
export const SUPERVISOR_MACHINE_TOKEN_ENV = 'PODIUM_SUPERVISOR_MACHINE_TOKEN'
export const SUPERVISOR_UPDATE_PUBKEY_ENV = 'PODIUM_SUPERVISOR_UPDATE_PUBKEY'
export const SUPERVISOR_SERVICE_ASSIGNMENT_ENV = 'PODIUM_SUPERVISOR_SERVICE_ASSIGNMENT'

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5_000

export interface SupervisorState {
  machineId: MachineId
  token?: string
  updatePubkey?: string
  assignment?: MachineServiceAssignment
}

function parseState(raw: unknown): SupervisorState | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.machineId !== 'string') return null
  const assignment = MachineServiceAssignment.safeParse(value.assignment)
  return {
    machineId: asMachineId(value.machineId),
    ...(typeof value.token === 'string' ? { token: value.token } : {}),
    ...(typeof value.updatePubkey === 'string' ? { updatePubkey: value.updatePubkey } : {}),
    ...(assignment.success ? { assignment: assignment.data } : {}),
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function saveSupervisorState(dir: string, state: SupervisorState): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, STATE_FILE)
  const temporary = path + '.tmp-' + process.pid
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}

/** Import the legacy daemon credential once; daemon.json remains for old builds. */
export function loadSupervisorState(dir: string): SupervisorState {
  const current = parseState(readJson(join(dir, STATE_FILE)))
  if (current) return current
  const legacy = parseState(readJson(join(dir, LEGACY_FILE)))
  const imported = legacy ?? { machineId: readOrCreateLocalMachineId(dir) }
  saveSupervisorState(dir, imported)
  return imported
}

export function fallbackAssignment(
  mode: 'all-in-one' | 'server' | 'daemon' | 'client' | 'supervisor',
): MachineServiceAssignment {
  return {
    server: mode === 'all-in-one' || mode === 'server',
    agentExecution: mode === 'all-in-one' || mode === 'daemon',
  }
}

/** A write-ahead record owns only the unfinished config/assignment transaction.
 * Backups and completed promotion metadata never override later role policy. */
export const TRANSFER_ASSIGNMENT_FILE = 'supervisor-transfer-pending.json'

function syncFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function configIdentity(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`
  } catch {
    return undefined
  }
}

export function prepareTransferAssignment(
  config: PodiumConfig,
  preparedPath: string,
  dir = stateDir(),
): void {
  const state = loadSupervisorState(dir)
  const path = join(dir, TRANSFER_ASSIGNMENT_FILE)
  const temporary = path + '.tmp-' + process.pid
  writeFileSync(
    temporary,
    JSON.stringify({
      machineId: state.machineId,
      config,
      configIdentity: configIdentity(preparedPath),
    }),
    { mode: 0o600 },
  )
  syncFile(temporary)
  renameSync(temporary, path)
  syncFile(dir)
}

export function targetTransferRecovery(
  state: SupervisorState,
  config: PodiumConfig,
  dir = stateDir(),
): boolean {
  if (config.mode !== 'server' || !config.serverUrl) return false
  // Only the newest target stage may retain a recovery daemon. Never search past
  // a newer aborted/incomplete stage to resurrect an older promotion.
  try {
    const root = join(dir, '.server-transfer')
    const newest = readdirSync(root)
      .filter((name) => /^[0-9a-f-]{36}$/i.test(name))
      .map((name) => ({
        path: join(root, name, 'state.json'),
        modified: statSync(join(root, name, 'state.json')).mtimeMs,
      }))
      .sort((a, b) => b.modified - a.modified)[0]
    const raw = newest && (readJson(newest.path) as Record<string, unknown> | undefined)
    return (
      raw?.targetMachineId === state.machineId &&
      raw.publicUrl === config.publicUrl &&
      raw.acknowledged !== true &&
      ['promoting', 'promoted', 'uncertain'].includes(String(raw.state))
    )
  } catch {
    return false
  }
}

export function reconcileSupervisorAssignment(
  state: SupervisorState,
  config: PodiumConfig,
  dir = stateDir(),
): MachineServiceAssignment {
  const path = join(dir, TRANSFER_ASSIGNMENT_FILE)
  const pending = readJson(path) as {
    machineId?: unknown
    config?: unknown
    configIdentity?: unknown
  } | null
  if (
    pending?.machineId === state.machineId &&
    pending.configIdentity !== undefined &&
    pending.configIdentity === configIdentity(join(dir, 'config.json')) &&
    isDeepStrictEqual(pending.config, config)
  ) {
    state.assignment = fallbackAssignment(config.mode ?? 'all-in-one')
    saveSupervisorState(dir, state)
    syncFile(join(dir, STATE_FILE))
    syncFile(dir)
    unlinkSync(path)
    syncFile(dir)
  }
  // A mismatch may be observed before the prepared config rename. Leave it alone;
  // only that exact file incarnation can consume this record, even if a future
  // intentional setup returns to byte-identical config contents.
  if (!state.assignment?.server && targetTransferRecovery(state, config, dir)) {
    // Upgrade recovery for the previous target writer: active, unacknowledged
    // promotion evidence owns the temporary server role, not historical backups.
    state.assignment = fallbackAssignment('server')
    saveSupervisorState(dir, state)
  }
  return state.assignment ?? fallbackAssignment(config.mode ?? 'all-in-one')
}

export function effectiveAssignment(input: {
  configured: MachineServiceAssignment
  agentExecutionLockout?: boolean
}): MachineServiceAssignment {
  return {
    server: input.configured.server,
    agentExecution: input.configured.agentExecution && input.agentExecutionLockout !== true,
  }
}

export interface MachineSupervisorConnectionDeps {
  serverUrl: string | (() => string)
  stateDir: string
  state: SupervisorState
  pairCode?: string
  bootstrapToken?: string | (() => string | undefined)
  name?: string
  build: PeerBuild
  deliveryCaps: readonly string[]
  report(): MachineServiceReport
  acceptAssignment?(assignment: MachineServiceAssignment): boolean
  onAssignment?(assignment: MachineServiceAssignment): void
  onGrant(message: Extract<MachineSupervisorControlMessage, { type: 'updateGrant' }>): void
  onConnected?(): void
  onPaired?(): void
}

export interface MachineSupervisorConnection {
  start(): void
  waitUntilConnected(timeoutMs?: number): Promise<boolean>
  report(): void
  /** Re-resolve topology now; stale socket callbacks cannot mutate the new connection. */
  reconfigure(): void
  send(message: MachineSupervisorMessage): void
  close(): void
}

export function createMachineSupervisorConnection(
  deps: MachineSupervisorConnectionDeps,
): MachineSupervisorConnection {
  let socket: WebSocket | undefined
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let backoffMs = RECONNECT_MIN_MS
  let connected = false
  const resolveServerUrl = (): string =>
    typeof deps.serverUrl === 'function' ? deps.serverUrl() : deps.serverUrl
  let activeServerUrl = resolveServerUrl()
  let firstSettled = false
  let resolveFirst!: (connected: boolean) => void
  const firstConnection = new Promise<boolean>((resolve) => {
    resolveFirst = resolve
  })
  const settleFirst = (value: boolean): void => {
    if (firstSettled) return
    firstSettled = true
    resolveFirst(value)
  }
  const reportConnectivity = (
    patch: Omit<Parameters<typeof writeConnectivity>[0], 'serverUrl' | 'processId' | 'appVersion'>,
  ): void => {
    try {
      writeConnectivity(
        {
          serverUrl: activeServerUrl,
          processId: process.pid,
          appVersion: deps.build.appVersion ?? 'dev',
          ...patch,
        },
        deps.stateDir,
      )
    } catch (error) {
      log.warn('could not write machine connectivity status', { err: error })
    }
  }

  const credential = (): PeerCredential => {
    const bootstrapToken =
      typeof deps.bootstrapToken === 'function' ? deps.bootstrapToken() : deps.bootstrapToken
    if (bootstrapToken) return { kind: 'daemonSecret', secret: bootstrapToken }
    if (deps.state.token)
      return { kind: 'machineToken', token: deps.state.token, machineHint: deps.state.machineId }
    if (deps.pairCode) return { kind: 'pairCode', code: deps.pairCode }
    throw new Error('machine supervisor has no credential; pair it first')
  }

  const persistHandshake = (
    issuedToken?: string,
    updatePubkey?: string,
    rotations: readonly UpdateKeyRotation[] = [],
  ): boolean => {
    if (issuedToken) deps.state.token = issuedToken
    if (updatePubkey !== undefined) {
      if (
        deps.state.updatePubkey &&
        !acceptsUpdateKeyRotation(deps.state.updatePubkey, updatePubkey, rotations)
      ) {
        log.error('server update key changed outside pairing; refusing machine plane')
        return false
      }
      deps.state.updatePubkey = updatePubkey
    }
    deps.state.assignment = loadSupervisorState(deps.stateDir).assignment
    saveSupervisorState(deps.stateDir, deps.state)
    if (issuedToken) deps.onPaired?.()
    return true
  }

  const send = (message: MachineSupervisorMessage): void => {
    if (!connected || socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(message))
  }

  const sendReport = (): void => send({ type: 'machineReport', services: deps.report() })

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return
    const delay = backoffMs
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
    reconnectTimer.unref?.()
  }

  const connect = (): void => {
    if (closed) return
    let dialer: ReturnType<typeof createHandshakeDialer>
    try {
      dialer = createHandshakeDialer({
        peerRole: 'machine',
        credential: credential(),
        caps: [...deps.deliveryCaps],
        build: deps.build,
        claims: {
          machineId: deps.state.machineId,
          hostname: hostname(),
          ...(deps.name ? { name: deps.name } : {}),
        },
      })
    } catch (error) {
      log.error('machine supervisor cannot connect', { err: error })
      reportConnectivity({ state: 'blocked', blockedReason: String(error) })
      settleFirst(false)
      return
    }
    activeServerUrl = resolveServerUrl()
    const active = new WebSocket(activeServerUrl.replace(/\/$/, '') + '/machine')
    socket = active
    active.addEventListener('open', () => {
      if (socket === active) active.send(JSON.stringify(dialer.hello()))
    })
    active.addEventListener('message', (event) => {
      if (socket !== active) return
      const step = dialer.receive(String(event.data))
      if (step.action === 'established') {
        if (!persistHandshake(step.issuedToken, step.updatePubkey, step.updateKeyRotations)) {
          active.close()
          return
        }
        connected = true
        reportConnectivity({ state: 'connected', lastHelloOkAt: new Date().toISOString() })
        settleFirst(true)
        backoffMs = RECONNECT_MIN_MS
        sendReport()
        deps.onConnected?.()
        return
      }
      if (step.action === 'deliver') {
        try {
          const message = MachineSupervisorControlMessage.parse(JSON.parse(step.raw))
          if (message.type === 'serviceAssignment') {
            if (deps.acceptAssignment?.(message.assignment) === false) return
            deps.state.assignment = message.assignment
            saveSupervisorState(deps.stateDir, deps.state)
            deps.onAssignment?.(message.assignment)
            sendReport()
          } else deps.onGrant(message)
        } catch (error) {
          log.warn('dropped malformed machine control frame', { err: error })
        }
        return
      }
      if (step.action === 'rejected' || step.action === 'protocol-error') {
        log.error('machine supervisor handshake refused', { step })
        closed = true
        settleFirst(false)
        if (step.action === 'rejected' && step.reply.reason === 'auth-failed') {
          reportConnectivity({
            state: 'unauthorized',
            authorizationReason: `peerHelloRejected: ${step.reply.message ?? step.reply.reason}`,
          })
        } else {
          reportConnectivity({
            state: 'blocked',
            blockedReason:
              step.action === 'rejected'
                ? `peerHelloRejected: ${step.reply.message ?? step.reply.reason}`
                : `handshake-protocol: ${step.error}`,
          })
        }
        active.close()
      }
    })
    active.addEventListener('error', () => {})
    active.addEventListener('close', () => {
      if (socket !== active) return
      socket = undefined
      connected = false
      if (!closed) {
        reportConnectivity({ state: 'disconnected', retryBackoffMs: backoffMs })
        scheduleReconnect()
      }
    })
  }

  return {
    start: connect,
    async waitUntilConnected(timeoutMs = 10_000) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      })
      const result = await Promise.race([firstConnection, timeout])
      if (timer) clearTimeout(timer)
      return result
    },
    report: sendReport,
    reconfigure() {
      // An unchanged URL can carry a new credential or role assignment.
      // Always renew the handshake and invalidate every old socket callback.
      const previous = socket
      socket = undefined
      connected = false
      closed = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      backoffMs = RECONNECT_MIN_MS
      previous?.close()
      connect()
    },
    send,
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try {
        socket?.close()
      } catch {}
      socket = undefined
    },
  }
}
