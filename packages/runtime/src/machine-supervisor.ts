import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createLogger } from '@podium/logger'
import {
  asMachineId,
  type MachineId,
  MachineServiceAssignment,
  type MachineServiceReport,
} from '@podium/model'
import {
  createHandshakeDialer,
  MachineChallenge,
  MachineSupervisorControlMessage,
  type MachineSupervisorMessage,
  machineHelloTranscript,
  machineRotationTranscript,
  type PeerBuild,
  type PeerCredential,
  type PeerHello,
} from '@podium/protocol'
import { type PodiumConfig, PodiumMode, stateDir } from './config'
import { writeConnectivity } from './connectivity'
import { fsyncPath } from './fsync'
import { loadMachineState, readMachineState, updateMachineState } from './local-machine'
import {
  acknowledgeMachineCredentialRotation,
  createMachineCredential,
  machinePublicKeyWire,
  prepareMachineCredentialRotation,
  readMachineCredential,
  signWithMachine,
} from './machine-credential'
import type { MachineUpdateAuthority } from './machine-update'
import type { SetupEnrollmentRequest } from './setup-enrollment'
import { acceptsUpdateKeyRotation, type UpdateKeyRotation } from './update-key-trust'
import { workspaceEndpoint } from './workspace-target'

const log = createLogger('runtime:machine-supervisor')
const STATE_FILE = 'machine.json'
export const SUPERVISOR_MACHINE_ID_ENV = 'PODIUM_SUPERVISOR_MACHINE_ID'
export const SUPERVISOR_MACHINE_TOKEN_ENV = 'PODIUM_SUPERVISOR_MACHINE_TOKEN'
export const SUPERVISOR_UPDATE_PUBKEY_ENV = 'PODIUM_SUPERVISOR_UPDATE_PUBKEY'
export const SUPERVISOR_SERVICE_ASSIGNMENT_ENV = 'PODIUM_SUPERVISOR_SERVICE_ASSIGNMENT'

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5_000

export interface SupervisorState {
  workspaceId?: string
  machineId: MachineId
  token?: string
  enrolledPublicKey?: string
  setupEnrollment?: SetupEnrollmentRequest
  updatePubkey?: string
  assignment?: MachineServiceAssignment
  /**
   * WHICH INCARNATION OF THIS MACHINE'S PARENT LAST RAN (POD-3752). Persisted
   * so the counter survives a reboot; see {@link claimSupervisorGeneration}.
   */
  generation?: number
}

/**
 * The number a predecessor hands its successor across a self-handover. The
 * predecessor knows its own incarnation in memory, which is the one thing a
 * successor booting from a shared file cannot be sure of.
 */
export const PARENT_GENERATION_ENV = 'PODIUM_PARENT_GENERATION'

function validSetupRequest(value: unknown, machineId: string): value is SetupEnrollmentRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<SetupEnrollmentRequest>
  return (
    request.machineId === machineId &&
    typeof request.requestId === 'string' &&
    request.requestId.length > 0 &&
    typeof request.publicKey === 'string' &&
    request.publicKey.length > 0 &&
    typeof request.agentExecution === 'boolean' &&
    typeof request.preauthorized === 'boolean'
  )
}

function parseState(raw: unknown): SupervisorState | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.machineId !== 'string') return null
  const assignment = MachineServiceAssignment.safeParse(value.assignment)
  return {
    machineId: asMachineId(value.machineId),
    ...(validSetupRequest(value.setupEnrollment, value.machineId)
      ? { setupEnrollment: value.setupEnrollment }
      : {}),
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.token === 'string' ? { token: value.token } : {}),
    ...(typeof value.enrolledPublicKey === 'string'
      ? { enrolledPublicKey: value.enrolledPublicKey }
      : {}),
    ...(typeof value.updatePubkey === 'string' ? { updatePubkey: value.updatePubkey } : {}),
    ...(assignment.success ? { assignment: assignment.data } : {}),
    ...(typeof value.generation === 'number' && Number.isSafeInteger(value.generation)
      ? { generation: value.generation }
      : {}),
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
  updateMachineState(
    dir,
    (machine) => {
      if (machine.machineId !== state.machineId)
        throw new Error('supervisor machine identity conflict')
      machine.supervisor = { ...state }
    },
    state.machineId,
  )
}

export function loadSupervisorState(dir: string): SupervisorState {
  const machine = loadMachineState(dir)
  // A daemon section is this machine's supervisor state only when it carries the
  // daemon's credential. A 0.1.0 all-in-one left a token-less daemon.json naming an id
  // nothing authenticated as (POD-5931); adopting it clashed with the root identity and
  // the parent died at every start.
  const daemon = machine.daemon && typeof machine.daemon.token === 'string' ? machine.daemon : undefined
  return parseState(machine.supervisor ?? daemon) ?? { machineId: machine.machineId }
}

/**
 * Claim this process's incarnation number and persist it.
 *
 * MONOTONIC AND CLOCK-FREE, host-local, never compared across machines. Two
 * inputs, and the higher wins: the number a predecessor handed us across a
 * handover, and one past whatever the last incarnation persisted. Either alone
 * would do in the ordinary case — a predecessor persists its own number before
 * it spawns anyone — and keeping both means neither a stale file nor a missing
 * env can hand out a number that has already been used. Junk in the env is
 * ignored rather than trusted: a number that can go backwards is not a fence.
 */
export function claimSupervisorGeneration(
  state: SupervisorState,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const inherited = Number(env[PARENT_GENERATION_ENV])
  const successor = Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 0
  state.generation = Math.max(successor, (state.generation ?? 0) + 1)
  saveSupervisorState(dir, state)
  return state.generation
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
  fsyncPath(path)
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

/**
 * THE SETUP A STORED ROLE AND CREDENTIAL BELONG TO (POD-5983).
 *
 * The stored assignment outranks `config.mode` at every start, because a coordinator
 * may have narrowed it and a server transfer commits it ahead of its topology request.
 * That precedence is only sound while the config still names the setup the assignment
 * was decided under. A setup flow that chooses something else — joining another
 * Podium, connecting as a client, the desktop's client → daemon switch — rewrites
 * config.json and nothing more, and several of those writers (the web setup, the
 * desktop shell in Rust) cannot reach this state at all. Recording the origin lets
 * the next start see the change for itself, whoever made it.
 */
export interface SupervisorRoleOrigin {
  mode: NonNullable<PodiumConfig['mode']>
  /**
   * `local` for a box that hosts its own server. Else the joined server's
   * installation id, or `remote` when it was never probed.
   */
  coordinator: string
}

function hostsServer(mode: SupervisorRoleOrigin['mode']): boolean {
  return mode === 'all-in-one' || mode === 'server'
}

export function configuredRoleOrigin(config: PodiumConfig): SupervisorRoleOrigin {
  const mode = config.mode ?? 'all-in-one'
  return {
    mode,
    coordinator: hostsServer(mode) ? 'local' : (config.installationId ?? 'remote'),
  }
}

function sameCoordinator(a: string, b: string): boolean {
  if (a === b) return true
  if (a === 'local' || b === 'local') return false
  // An unprobed remote is not evidence of another server: `podium set-server` rotates
  // a tunnel URL without an identity, and must keep the pairing (issue #19).
  return a === 'remote' || b === 'remote'
}

export function readRoleOrigin(dir = stateDir()): SupervisorRoleOrigin | undefined {
  const role = readMachineState(dir)?.role
  const mode = PodiumMode.safeParse(role?.mode)
  return mode.success && typeof role?.coordinator === 'string'
    ? { mode: mode.data, coordinator: role.coordinator }
    : undefined
}

/** The supervisor section and its origin travel in ONE machine.json write. */
function saveSupervisorRole(
  dir: string,
  state: SupervisorState,
  origin: SupervisorRoleOrigin,
  dropConnectivity = false,
): void {
  updateMachineState(
    dir,
    (machine) => {
      if (machine.machineId !== state.machineId)
        throw new Error('supervisor machine identity conflict')
      machine.supervisor = { ...state }
      machine.role = { ...origin }
      if (dropConnectivity) delete machine.connectivity
    },
    state.machineId,
  )
}

/**
 * Before the origin was recorded, the one way a joined box came to hold the server
 * role was the first local launch's own enrollment that this repairs: the server
 * role otherwise moves only through a transfer, and a transfer target is `server`.
 */
function legacyRoleOrigin(
  state: SupervisorState,
  configured: SupervisorRoleOrigin,
): SupervisorRoleOrigin {
  return state.assignment?.server && !hostsServer(configured.mode)
    ? { mode: 'all-in-one', coordinator: 'local' }
    : configured
}

/**
 * Follow a setup that changed this machine's role outside a server transfer: the
 * new mode's own topology, and — when it names another server — none of the old
 * server's credential, so the joined server's pair code is what this machine
 * presents. A local all-in-one's enrollment means nothing to a VPS, and it outranks
 * the pair code in every hello.
 */
function adoptConfiguredRole(state: SupervisorState, config: PodiumConfig, dir: string): void {
  const configured = configuredRoleOrigin(config)
  const recorded = readRoleOrigin(dir)
  const origin = recorded ?? legacyRoleOrigin(state, configured)
  const sameServer = sameCoordinator(origin.coordinator, configured.coordinator)
  if (origin.mode === configured.mode && sameServer) {
    // An unprobed URL keeps the server identity already known.
    const next = configured.coordinator === 'remote' ? origin : configured
    if (!isDeepStrictEqual(recorded, next)) saveSupervisorRole(dir, state, next)
    return
  }
  state.assignment = fallbackAssignment(configured.mode)
  if (!sameServer) {
    delete state.token
    delete state.enrolledPublicKey
    delete state.setupEnrollment
    delete state.updatePubkey
    if (config.workspaceId) state.workspaceId = config.workspaceId
    else delete state.workspaceId
  }
  saveSupervisorRole(dir, state, configured, !sameServer)
  syncFile(join(dir, STATE_FILE))
  syncFile(dir)
  log.info('machine role follows a new setup', {
    from: origin,
    to: configured,
    credentialDropped: !sameServer,
  })
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
    // A transfer keeps this machine's credential: the new server imported its row.
    state.assignment = fallbackAssignment(config.mode ?? 'all-in-one')
    saveSupervisorRole(dir, state, configuredRoleOrigin(config))
    syncFile(join(dir, STATE_FILE))
    syncFile(dir)
    unlinkSync(path)
    syncFile(dir)
  } else if (targetTransferRecovery(state, config, dir)) {
    // The previous target writer left no record; its promotion evidence is the transfer.
    saveSupervisorRole(dir, state, configuredRoleOrigin(config))
  } else {
    adoptConfiguredRole(state, config, dir)
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
  workspaceId?: string | (() => string | undefined)
  pairCode?: string
  name?: string
  build: PeerBuild
  deliveryCaps: readonly string[]
  report(): MachineServiceReport
  acceptAssignment?(assignment: MachineServiceAssignment): boolean
  onAssignment?(assignment: MachineServiceAssignment): void
  onGrant(
    message: Extract<MachineSupervisorControlMessage, { type: 'updateGrant' }>,
    authority: MachineUpdateAuthority,
  ): void
  onConnected?(): void
  onPaired?(): void
}

export interface MachineSupervisorConnection {
  start(): void
  waitUntilConnected(timeoutMs?: number): Promise<boolean>
  report(): void
  /** Re-resolve topology now; stale socket callbacks cannot mutate the new connection. */
  reconfigure(): void
  /** Explicit rotation; reconnect retries the persisted proposal until acknowledgement. */
  rotateCredential(): void
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
  const resolveWorkspaceId = (): string | undefined =>
    typeof deps.workspaceId === 'function'
      ? deps.workspaceId()
      : (deps.workspaceId ?? deps.state.workspaceId)
  let resolveFirst!: (connected: boolean) => void
  let firstSettled = false
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
    // The parent can confirm setup while this connection is already waiting to dial.
    const persisted = loadSupervisorState(deps.stateDir)
    if (persisted.enrolledPublicKey) deps.state.enrolledPublicKey = persisted.enrolledPublicKey
    if (readMachineCredential(deps.stateDir)?.pendingRotation) {
      return { kind: 'machineKey', machineHint: deps.state.machineId }
    }
    if (persisted.setupEnrollment && !persisted.enrolledPublicKey)
      throw new Error('setup enrollment is awaiting confirmation')
    if (deps.state.enrolledPublicKey) {
      const key = readMachineCredential(deps.stateDir)
      if (!key || machinePublicKeyWire(key) !== deps.state.enrolledPublicKey)
        throw new Error('enrolled machine key unavailable')
      return { kind: 'machineKey', machineHint: deps.state.machineId }
    }
    if (deps.state.token)
      return { kind: 'machineToken', token: deps.state.token, machineHint: deps.state.machineId }
    if (deps.pairCode)
      return {
        kind: 'pairCode',
        code: deps.pairCode,
        publicKey: machinePublicKeyWire(createMachineCredential(deps.stateDir)),
      }
    if (readMachineCredential(deps.stateDir))
      return { kind: 'machineKey', machineHint: deps.state.machineId }
    throw new Error('machine supervisor has no credential; pair it first')
  }

  const persistHandshake = (
    issuedToken?: string,
    updatePubkey?: string,
    rotations: readonly UpdateKeyRotation[] = [],
    enrolledPublicKey?: string,
  ): boolean => {
    if (enrolledPublicKey) {
      const key = readMachineCredential(deps.stateDir)
      if (!key || machinePublicKeyWire(key.pendingRotation ?? key) !== enrolledPublicKey)
        return false
      deps.state.enrolledPublicKey = enrolledPublicKey
      delete deps.state.token
    } else if (issuedToken) deps.state.token = issuedToken
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
    const persistedState = loadSupervisorState(deps.stateDir)
    deps.state.assignment = persistedState.assignment
    deps.state.setupEnrollment = persistedState.setupEnrollment
    saveSupervisorState(deps.stateDir, deps.state)
    if (enrolledPublicKey && readMachineCredential(deps.stateDir)?.pendingRotation) {
      // Make the new-key reference durable before dropping the only old private key.
      // A crash before promotion leaves a pending proposal that the next hello retries.
      syncFile(join(deps.stateDir, STATE_FILE))
      syncFile(deps.stateDir)
      acknowledgeMachineCredentialRotation(deps.stateDir, enrolledPublicKey)
    }
    if (issuedToken || enrolledPublicKey) deps.onPaired?.()
    return true
  }

  const send = (message: MachineSupervisorMessage): void => {
    if (!connected || socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(message))
  }

  const sendReport = (): void => {
    const { topology, ...services } = deps.report()
    send({ type: 'machineReport', services, ...(topology ? { topology } : {}) })
  }

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
    let hello: PeerHello | undefined
    let challengeAnswered = false
    try {
      dialer = createHandshakeDialer({
        peerRole: 'machine',
        credential: credential(),
        caps: [...deps.deliveryCaps],
        build: deps.build,
        claims: {
          machineId: deps.state.machineId,
          hostname: hostname(),
          assignment: deps.state.assignment ?? {
            server: deps.report().server.policy === 'enabled',
            agentExecution: deps.report().agentExecution.policy === 'enabled',
          },
          ...(deps.name ? { name: deps.name } : {}),
        },
      })
    } catch (error) {
      log.error('machine supervisor cannot connect', { err: error })
      reportConnectivity({ state: 'blocked', blockedReason: String(error) })
      settleFirst(false)
      scheduleReconnect()
      return
    }
    activeServerUrl = resolveServerUrl()
    const grantServerUrl = activeServerUrl
    const active = new WebSocket(
      workspaceEndpoint(activeServerUrl, '/machine', resolveWorkspaceId()),
    )
    socket = active
    active.addEventListener('open', () => {
      if (socket === active) {
        hello = dialer.hello()
        active.send(JSON.stringify(hello))
      }
    })
    active.addEventListener('message', (event) => {
      if (socket !== active) return
      let decoded: unknown
      try {
        decoded = JSON.parse(String(event.data))
      } catch {
        decoded = null
      }
      const challenge = MachineChallenge.safeParse(decoded)
      if (challenge.success) {
        if (
          connected ||
          challengeAnswered ||
          hello?.credential.kind !== 'machineKey' ||
          challenge.data.machineId !== deps.state.machineId
        ) {
          active.close()
          return
        }
        const key = readMachineCredential(deps.stateDir)
        if (!key) {
          active.close()
          return
        }
        challengeAnswered = true
        const { nonce, installationId, connectionId } = challenge.data
        const signingKey = key.pendingRotation ?? key
        const newPublicKey = machinePublicKeyWire(signingKey)
        const transcript = machineRotationTranscript(challenge.data, newPublicKey, newPublicKey)
        const rotation = key.pendingRotation
          ? {
              newKeyId: newPublicKey,
              newPublicKey,
              newSignature: signWithMachine(signingKey, transcript),
              previous: deps.state.token
                ? { kind: 'bearer-hash' as const, token: deps.state.token }
                : {
                    kind: 'ed25519' as const,
                    publicKey: machinePublicKeyWire(key),
                    signature: signWithMachine(key, transcript),
                  },
            }
          : undefined
        active.send(
          JSON.stringify({
            ...hello,
            credential: {
              ...hello.credential,
              ...(rotation ? { rotation } : {}),
              proof: {
                nonce,
                installationId,
                connectionId,
                signature: signWithMachine(signingKey, machineHelloTranscript(challenge.data)),
              },
            },
          }),
        )
        return
      }
      const step = dialer.receive(String(event.data))
      if (step.action === 'established') {
        const pending = readMachineCredential(deps.stateDir)?.pendingRotation
        if (pending && step.enrolledPublicKey !== machinePublicKeyWire(pending)) {
          active.close()
          return
        }
        if (
          !persistHandshake(
            step.issuedToken,
            step.updatePubkey,
            step.updateKeyRotations,
            step.enrolledPublicKey,
          )
        ) {
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
          } else {
            const isCurrent = () =>
              socket === active && connected && resolveServerUrl() === grantServerUrl
            if (!isCurrent()) return
            deps.onGrant(message, { kind: 'coordinator', serverUrl: grantServerUrl, isCurrent })
          }
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
    rotateCredential() {
      if (!deps.state.enrolledPublicKey && !deps.state.token)
        throw new Error('machine must be enrolled before rotation')
      const current = readMachineCredential(deps.stateDir)
      if (
        deps.state.enrolledPublicKey &&
        (!current ||
          (machinePublicKeyWire(current) !== deps.state.enrolledPublicKey &&
            (!current.pendingRotation ||
              machinePublicKeyWire(current.pendingRotation) !== deps.state.enrolledPublicKey)))
      ) {
        throw new Error('enrolled machine key unavailable')
      }
      prepareMachineCredentialRotation(deps.stateDir)
      this.reconfigure()
    },
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
