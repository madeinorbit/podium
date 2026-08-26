import { hostname } from 'node:os'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
import { writeConnectivity } from './connectivity'

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
  serverUrl: string
  stateDir: string
  state: SupervisorState
  pairCode?: string
  bootstrapToken?: string
  name?: string
  build: PeerBuild
  deliveryCaps: readonly string[]
  report(): MachineServiceReport
  onAssignment?(assignment: MachineServiceAssignment): void
  onGrant(message: Extract<MachineSupervisorControlMessage, { type: 'updateGrant' }>): void
  onPaired?(): void
}

export interface MachineSupervisorConnection {
  start(): void
  waitUntilConnected(timeoutMs?: number): Promise<boolean>
  report(): void
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
          serverUrl: deps.serverUrl,
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
    if (deps.bootstrapToken) return { kind: 'daemonSecret', secret: deps.bootstrapToken }
    if (deps.state.token)
      return { kind: 'machineToken', token: deps.state.token, machineHint: deps.state.machineId }
    if (deps.pairCode) return { kind: 'pairCode', code: deps.pairCode }
    throw new Error('machine supervisor has no credential; pair it first')
  }

  const persistHandshake = (issuedToken?: string, updatePubkey?: string): boolean => {
    if (issuedToken) deps.state.token = issuedToken
    if (updatePubkey !== undefined) {
      if (deps.state.updatePubkey && deps.state.updatePubkey !== updatePubkey) {
        log.error('server update key changed outside pairing; refusing machine plane')
        return false
      }
      deps.state.updatePubkey = updatePubkey
    }
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
    const active = new WebSocket(deps.serverUrl.replace(/\/$/, '') + '/machine')
    socket = active
    active.addEventListener('open', () => active.send(JSON.stringify(dialer.hello())))
    active.addEventListener('message', (event) => {
      const step = dialer.receive(String(event.data))
      if (step.action === 'established') {
        if (!persistHandshake(step.issuedToken, step.updatePubkey)) {
          active.close()
          return
        }
        connected = true
        reportConnectivity({ state: 'connected', lastHelloOkAt: new Date().toISOString() })
        settleFirst(true)
        backoffMs = RECONNECT_MIN_MS
        sendReport()
        return
      }
      if (step.action === 'deliver') {
        try {
          const message = MachineSupervisorControlMessage.parse(JSON.parse(step.raw))
          if (message.type === 'serviceAssignment') {
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
      if (socket === active) socket = undefined
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
