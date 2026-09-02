import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { createLogger } from '@podium/logger'
import type { MachineId } from '@podium/model'
import {
  CAP_DAEMON_GEOMETRY_APPLIED,
  CAP_TERMINAL_INPUT_BINARY_V1,
  CAP_TERMINAL_OUTPUT_BINARY_V1,
  createHandshakeDialer,
  DAEMON_PTY_OUTPUT_MAX_SOURCE_FRAMES,
  DaemonPtyInputMetadata,
  type DaemonPtyOutputBatch,
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
  type LocalDaemonAttachment,
  type PeerBuild,
  type PeerCredential,
  type PeerHelloRejected,
} from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { stateDir } from '@podium/runtime/config'
import { writeConnectivity } from '@podium/runtime/connectivity'
import { consumePairCode } from '@podium/runtime/setup'
import {
  acceptsUpdateKeyRotation,
  type UpdateKeyRotation,
  updateKeyFingerprint,
} from '@podium/runtime/update-key-trust'
import WebSocket, { type RawData } from 'ws'
import { deliveryCaps } from './build-report'
import type { DaemonOptions, ReconnectTimers } from './daemon-options'
import type { QueueDrainOutbox } from './queue-drain-outbox'
import type { RuntimeEventOutbox } from './runtime-event-outbox'
import { savePairingToken, savePinnedUpdatePubkey } from './identity'
import { decideOnProtocolMismatch, decidePostUpdate } from './self-update'

const log = createLogger('daemon:connection')

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5_000
const QUEUE_DRAIN_RETRY_MS = 500

/**
 * How long a protocol-mismatch `podium update` may run before it is killed.
 *
 * There was no bound at all before POD-2046. Generous on purpose: an updater
 * that downloads and swaps a build is legitimately slow, so this is a deadlock
 * breaker for a run that has plainly stopped making progress, not a deadline
 * anyone should hit.
 */
const UPDATE_RUN_TIMEOUT_MS = 10 * 60_000

export const REAL_RECONNECT_TIMERS: ReconnectTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type DaemonConnectionState =
  | 'idle'
  | 'connecting'
  | 'awaiting-ack'
  | 'connected'
  | 'backoff'
  | 'unauthorized'
  | 'blocked'
  | 'closed'

interface SocketLike {
  readonly readyState: number
  send(data: string | Uint8Array): void
  close(): void
  once(event: 'open' | 'close', listener: () => void): this
  on(event: 'message', listener: (raw: RawData, isBinary?: boolean) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (error: unknown) => void): this
  on(
    event: 'unexpected-response',
    listener: (_req: unknown, res: { statusCode?: number }) => void,
  ): this
}

export interface DaemonConnectionDeps {
  readonly options: DaemonOptions
  readonly build: PeerBuild
  /** False when the sibling server hosts this parent's one update participant. */
  readonly reportUpdateIdentity?: boolean
  readonly machineId: MachineId
  readonly identity: { token?: string; updatePubkey?: string }
  readonly receiveApplicationFrame: (raw: RawData) => void
  readonly receiveBinaryInput?: (metadata: DaemonPtyInputMetadata, payload: Uint8Array) => void
  readonly sendApplicationFrame: (socket: SocketLike | undefined, msg: DaemonMessage) => boolean
  readonly queueDrainOutbox: QueueDrainOutbox
  readonly runtimeEventOutbox: RuntimeEventOutbox
  readonly onConnected: () => { convergedVersion?: string } | void
  readonly onTerminal: () => void | Promise<void>
  readonly openSocket?: (url: string) => SocketLike
  readonly restartAfterUpdate?: () => void
}

export interface DaemonConnection {
  readonly state: DaemonConnectionState
  start(): Promise<void>
  sendOutput(batch: DaemonPtyOutputBatch): void
  send(msg: DaemonMessage): void
  acknowledgeQueueDrainReport(reportId: string): void
  acknowledgeRuntimeEvent(deliveryId: string): void
  close(): Promise<void>
}

const assertOutputBatch = (batch: DaemonPtyOutputBatch): void => {
  if (
    !Number.isSafeInteger(batch.sourceFrames) ||
    batch.sourceFrames < 1 ||
    batch.sourceFrames > DAEMON_PTY_OUTPUT_MAX_SOURCE_FRAMES
  ) {
    throw new RangeError(
      `daemon PTY output batches require sourceFrames in 1..${DAEMON_PTY_OUTPUT_MAX_SOURCE_FRAMES}`,
    )
  }
}

const legacyOutputMessage = (
  batch: DaemonPtyOutputBatch,
): Extract<DaemonMessage, { type: 'agentFrameBatch' }> => {
  return {
    type: 'agentFrameBatch',
    sessionId: batch.sessionId,
    frames: [
      Buffer.from(batch.bytes).toString('base64'),
      ...Array.from({ length: batch.sourceFrames - 1 }, () => ''),
    ],
  }
}

/** Normalize every ws RawData variant without changing any byte values. */
export function normalizeRawData(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw)
}

/**
 * The daemon transport state machine. The shared protocol dialer owns handshake
 * ordering; this module owns the ONE process-to-server socket lifecycle, the
 * three machine credential choices, retry/backoff, and truthful connectivity.
 *
 * This is not SessionBinding under another name. SessionBinding durably owns
 * identity and launch entitlement for MANY sessions and survives a transport
 * outage unchanged. These states are ephemeral connectivity facts with no
 * SessionId and no binding transition API: a reconnect, auth denial, or backoff
 * must never spawn, reattach, adopt, retire, or otherwise mutate a binding.
 *
 * An `auth-failed` reply is UNAUTHORIZED, not unreachable: it is terminal and
 * never schedules reconnect backoff. Payload claims remain inert because the
 * dialer can only present them; the gateway strategy resolves the principal.
 */
export function createDaemonConnection(deps: DaemonConnectionDeps): DaemonConnection {
  const { options, identity } = deps
  const timers = options.reconnectTimers ?? REAL_RECONNECT_TIMERS
  const openSocket = deps.openSocket ?? ((url: string) => new WebSocket(url) as SocketLike)
  let state: DaemonConnectionState = 'idle'
  let socket: SocketLike | undefined
  let localAttachment: Extract<LocalDaemonAttachment, { established: true }> | undefined
  let reconnectTimer: unknown | undefined
  let queueDrainRetryTimer: unknown | undefined
  let runtimeEventRetryTimer: unknown | undefined
  let reconnectBackoffMs = RECONNECT_MIN_MS
  let closing = false
  let started = false
  let pairFallbackTried = false
  let lastSocketError: string | undefined
  let convergedVersion: string | undefined
  let acceptedCaps = new Set<string>()
  const invalidSockets = new WeakSet<SocketLike>()
  // Host diagnostics are durable attention, not telemetry. Keep the latest one
  // per code/version until an authenticated machine transport exists. Ordinary
  // runtime frames retain historical drop-while-offline behavior; queue-drain
  // abandonment is the one durable, acknowledged exception below.
  const pendingDiagnostics = new Map<
    string,
    Extract<DaemonMessage, { type: 'machineDiagnostic' }>
  >()
  let resolveStart!: () => void
  let rejectStart!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveStart = resolve
    rejectStart = reject
  })

  const connectivityDir = options.bootstrapToken ? undefined : (options.identityDir ?? stateDir())
  const report = (patch: Omit<Parameters<typeof writeConnectivity>[0], 'serverUrl'>): void => {
    if (!connectivityDir) return
    try {
      writeConnectivity(
        {
          serverUrl: options.serverUrl,
          processId: process.pid,
          appVersion: deps.build.appVersion ?? 'dev',
          ...(convergedVersion ? { convergedVersion } : {}),
          ...patch,
        },
        connectivityDir,
      )
    } catch (error) {
      log.warn('could not write the connectivity status file', { err: error, connectivityDir })
    }
  }

  const credential = (): PeerCredential | null => {
    if (options.bootstrapToken) return { kind: 'daemonSecret', secret: options.bootstrapToken }
    if (identity.token)
      return { kind: 'machineToken', token: identity.token, machineHint: deps.machineId }
    if (options.pairCode) return { kind: 'pairCode', code: options.pairCode }
    return null
  }

  const stopQueueDrainRetry = (): void => {
    if (queueDrainRetryTimer === undefined) return
    timers.clearTimeout(queueDrainRetryTimer)
    queueDrainRetryTimer = undefined
  }

  const stopRuntimeEventRetry = (): void => {
    if (runtimeEventRetryTimer === undefined) return
    timers.clearTimeout(runtimeEventRetryTimer)
    runtimeEventRetryTimer = undefined
  }

  const sendConnected = (msg: DaemonMessage): boolean => {
    if (localAttachment) {
      try {
        localAttachment.deliver(msg)
        return true
      } catch (error) {
        log.warn('could not deliver a daemon frame over the local link', { err: error })
        return false
      }
    }
    return deps.sendApplicationFrame(socket, msg)
  }

  const scheduleQueueDrainRetry = (): void => {
    if (
      closing ||
      state !== 'connected' ||
      queueDrainRetryTimer !== undefined ||
      deps.queueDrainOutbox.pending().length === 0
    ) {
      return
    }
    queueDrainRetryTimer = timers.setTimeout(() => {
      queueDrainRetryTimer = undefined
      replayQueueDrainReports()
    }, QUEUE_DRAIN_RETRY_MS)
  }

  const replayQueueDrainReports = (): void => {
    if (state !== 'connected') return
    for (const report of deps.queueDrainOutbox.pending()) sendConnected(report)
    scheduleQueueDrainRetry()
  }

  const scheduleRuntimeEventRetry = (): void => {
    if (
      closing ||
      state !== 'connected' ||
      runtimeEventRetryTimer !== undefined ||
      deps.runtimeEventOutbox.pending().length === 0
    )
      return
    runtimeEventRetryTimer = timers.setTimeout(() => {
      runtimeEventRetryTimer = undefined
      replayRuntimeEvents()
    }, QUEUE_DRAIN_RETRY_MS)
  }

  const replayRuntimeEvents = (): void => {
    if (state !== 'connected') return
    for (const event of deps.runtimeEventOutbox.pending()) sendConnected(event)
    scheduleRuntimeEventRetry()
  }

  const scheduleReconnect = (): void => {
    if (closing || reconnectTimer !== undefined || state === 'unauthorized' || state === 'blocked')
      return
    const from = state
    state = 'backoff'
    const delay = reconnectBackoffMs
    /**
     * THE LINK GOING AWAY, AND COMING BACK (POD-3224, question 13).
     *
     * A coordinator applying its own grant takes this link down, so the shape of
     * the outage is how a machine tells "the server restarted for the update I
     * am part of" from "the network broke". The status FILE has always carried
     * the current state; nothing carried the transitions, so afterwards there
     * was no way to say when the link dropped, how long the backoff had grown,
     * or how many attempts it took to come back.
     *
     * `info` and bounded: one line per drop, one per return. A daemon that stays
     * connected writes none.
     */
    log.info('daemon link lost; backing off before reconnecting', {
      from,
      retryBackoffMs: delay,
      ...(lastSocketError ? { lastError: lastSocketError } : {}),
    })
    report({
      state: 'disconnected',
      retryBackoffMs: delay,
      ...(lastSocketError ? { lastError: lastSocketError } : {}),
    })
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = undefined
      connectSocket()
    }, delay)
    reconnectBackoffMs = Math.min(delay * 2, RECONNECT_MAX_MS)
  }

  const terminal = (
    kind: 'unauthorized' | 'blocked',
    type: string,
    reason: string,
    active?: SocketLike,
  ): void => {
    state = kind
    closing = true
    const guidance =
      kind === 'unauthorized'
        ? 'Pairing will not be retried. On the server, open Machines → Add machine, create a new one-use code, then pair this machine with that new code.'
        : 'Not reconnecting; update the daemon or repair its configuration.'
    log.error('the server rejected this daemon', { rejection: type, reason, kind, guidance })
    report(
      kind === 'unauthorized'
        ? { state: 'unauthorized', authorizationReason: `${type}: ${reason}` }
        : { state: 'blocked', blockedReason: `${type}: ${reason}` },
    )
    void deps.onTerminal()
    rejectStart(new Error(`daemon handshake rejected: ${reason}`))
    active?.close()
    options.onBlocked?.({ type, reason })
  }

  const persistPairing = (issuedToken: string, updatePubkey: string | undefined): void => {
    identity.token = issuedToken
    if (updatePubkey === undefined) delete identity.updatePubkey
    else identity.updatePubkey = updatePubkey
    savePairingToken(
      issuedToken,
      updatePubkey,
      options.identityDir ? { dir: options.identityDir } : {},
    )
    if (!options.pairCode) return
    try {
      consumePairCode(options.pairCode)
    } catch (error) {
      log.warn('could not clear the consumed pair code', { err: error })
    }
  }

  const persistBootstrapPin = (updatePubkey: string): void => {
    identity.updatePubkey = updatePubkey
    savePinnedUpdatePubkey(updatePubkey, options.identityDir ? { dir: options.identityDir } : {})
  }

  const established = (
    issuedToken?: string,
    updatePubkey?: string,
    updateKeyRotations?: readonly UpdateKeyRotation[],
    active?: SocketLike,
    caps: readonly string[] = [],
  ): void => {
    if (issuedToken) {
      persistPairing(issuedToken, updatePubkey)
    } else if (updatePubkey !== undefined) {
      // No pin at all — learn it. This is the bootstrap handshake's first contact,
      // and equally a daemon that paired before the pin existed: an ABSENT pin
      // cannot be a CHANGED key, and blocking one bricks every daemon enrolled
      // before this guard shipped. The connection is already authenticated to the
      // configured server, so pinning here is no weaker than pinning at pairing.
      if (identity.updatePubkey === undefined) {
        persistBootstrapPin(updatePubkey)
      } else if (updatePubkey !== identity.updatePubkey) {
        if (
          acceptsUpdateKeyRotation(identity.updatePubkey, updatePubkey, updateKeyRotations ?? [])
        ) {
          persistBootstrapPin(updatePubkey)
          log.info('accepted signed server update-key rotation', {
            fingerprint: updateKeyFingerprint(updatePubkey),
          })
        } else {
          terminal(
            'blocked',
            'server-update-key',
            'the publisher update key was replaced after this machine enrolled, and no valid ' +
              'old-key-signed rotation reaches it. The existing pin was kept. After verifying ' +
              updateKeyFingerprint(updatePubkey) +
              ' out of band with the publisher, recover on this machine with: ' +
              'podium update-key trust ' +
              updatePubkey,
            active,
          )
          return
        }
      }
    }
    const from = state
    state = 'connected'
    acceptedCaps = new Set(caps)
    const recoveredAfterMs =
      reconnectBackoffMs === RECONNECT_MIN_MS ? undefined : reconnectBackoffMs
    // READ BEFORE THEY ARE CLEARED. Both of these describe the outage that just
    // ended, and clearing them first is how the field that names the cause ends
    // up permanently absent from the line that exists to report it.
    const recoveredFrom = lastSocketError
    reconnectBackoffMs = RECONNECT_MIN_MS
    lastSocketError = undefined
    log.info('daemon link established', {
      from,
      // The backoff this attempt had grown to. Absent on a first connection —
      // which is itself the distinction between "came back" and "just started".
      ...(recoveredAfterMs !== undefined ? { afterBackoffMs: recoveredAfterMs } : {}),
      ...(recoveredFrom ? { recoveredFrom } : {}),
    })
    const boot = deps.onConnected() ?? {}
    convergedVersion = boot.convergedVersion ?? convergedVersion
    report({
      state: 'connected',
      lastHelloOkAt: new Date().toISOString(),
    })
    for (const diagnostic of pendingDiagnostics.values()) {
      if (localAttachment) localAttachment.deliver(diagnostic)
      else deps.sendApplicationFrame(socket, diagnostic)
    }
    pendingDiagnostics.clear()
    replayQueueDrainReports()
    replayRuntimeEvents()
    resolveStart()
  }

  const handleProtocolMismatch = (
    active: SocketLike,
    source: 'handshake-rejection' | 'http-426',
  ): void => {
    const installed = !!process.env.PODIUM_HOME || /(?:^|[\\/])podium$/.test(process.execPath)
    // A configured server is the authority for this daemon. A wire mismatch is
    // therefore a signal to wait for a granted convergence, not permission to
    // race the server with a self-update.
    const { action } = decideOnProtocolMismatch({
      installed,
      source,
      attached: Boolean(options.serverUrl),
      parentManaged: process.env.PODIUM_UNDER_PARENT === '1',
    })
    if (action === 'backoff') {
      log.error('protocol mismatch — update the daemon to match the server', { source })
      active.close()
      return
    }
    log.error('protocol mismatch — running `podium update`', { source })
    // LAUNCHED, NOT AWAITED (POD-2046). This runs on the daemon's only thread,
    // which also carries PTY output, the server link and hook ingest. The
    // `spawnSync` this replaces froze all of them for as long as the updater
    // ran — and unlike git delivery it had NO timeout at all, so a `podium
    // update` that never returned wedged the daemon permanently with no alarm.
    // The verdict is reached in the continuation instead; this function stays
    // void, and so do both of its callers.
    const child = spawn(process.execPath, ['update'], {
      stdio: 'inherit',
      env: { ...process.env },
    })
    // The bound the sync version never had. Killed with SIGKILL because an
    // updater wedged badly enough to reach this point cannot be trusted to
    // honour a polite signal.
    const giveUp = setTimeout(() => child.kill('SIGKILL'), UPDATE_RUN_TIMEOUT_MS)
    ;(giveUp as { unref?: () => void }).unref?.()
    // `error` and `close` can BOTH fire — a spawn failure emits error and then
    // closes — and settling twice would restart the daemon on a run that had
    // already been reported as blocked.
    let settled = false
    const settle = (status: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(giveUp)
      if (decidePostUpdate(status) === 'restart') {
        ;(deps.restartAfterUpdate ?? (() => process.exit(0)))()
        return
      }
      terminal(
        'blocked',
        'protocol-mismatch',
        `no newer build available (podium update exit ${status}) — manual update required`,
        active,
      )
    }
    child.once('error', () => settle(null))
    child.once('close', (code) => settle(code))
  }

  const closeForInvalidBinary = (
    active: SocketLike | undefined,
    reason: 'unnegotiated' | 'malformed',
    error: unknown,
  ): void => {
    const detail = error instanceof Error ? error.message : String(error)
    acceptedCaps.clear()
    lastSocketError = detail
    log.warn('closing daemon connection for invalid binary PTY input', {
      reason,
      err: error,
    })
    if (active) {
      invalidSockets.add(active)
      if (socket === active) state = 'closed'
      active.close()
      return
    }
    localAttachment?.close()
    localAttachment = undefined
    state = 'closed'
  }
  const receiveReply = (
    dialer: ReturnType<typeof createHandshakeDialer>,
    raw: RawData,
    active: SocketLike | undefined,
    isBinary = false,
  ): void => {
    if (isBinary) {
      if (dialer.state !== 'established' || !acceptedCaps.has(CAP_TERMINAL_INPUT_BINARY_V1)) {
        closeForInvalidBinary(
          active,
          'unnegotiated',
          new Error('binary PTY input arrived before capability negotiation'),
        )
        return
      }
      let decoded: { metadata: DaemonPtyInputMetadata; payload: Uint8Array }
      try {
        decoded = decodeBinaryEnvelope(normalizeRawData(raw), DaemonPtyInputMetadata)
      } catch (error) {
        closeForInvalidBinary(active, 'malformed', error)
        return
      }
      deps.receiveBinaryInput?.(decoded.metadata, decoded.payload)
      return
    }
    const step = dialer.receive(normalizeRawData(raw).toString())
    if (step.action === 'deliver') {
      deps.receiveApplicationFrame(Buffer.from(step.raw))
      return
    }
    if (step.action === 'established') {
      established(
        step.issuedToken,
        step.updatePubkey,
        step.updateKeyRotations,
        active,
        step.caps.accepted,
      )
      return
    }
    if (step.action === 'protocol-error') {
      terminal('blocked', 'handshake-protocol', step.error, active)
      return
    }
    const rejection: PeerHelloRejected = step.reply
    if (rejection.reason === 'unsupported-version') {
      if (active) handleProtocolMismatch(active, 'handshake-rejection')
      else terminal('blocked', 'protocol-mismatch', rejection.message ?? rejection.reason)
      return
    }
    // A stale stored token may fall back exactly once to the supplied pair code.
    if (
      rejection.reason === 'auth-failed' &&
      identity.token &&
      options.pairCode &&
      !pairFallbackTried
    ) {
      pairFallbackTried = true
      identity.token = undefined
      log.warn('stored token rejected — retrying once with the supplied pair code')
      active?.close()
      return
    }
    terminal(
      rejection.reason === 'auth-failed' ? 'unauthorized' : 'blocked',
      'peerHelloRejected',
      rejection.message ?? rejection.reason,
      active,
    )
  }

  const makeDialer = () => {
    const selected = credential()
    if (!selected) throw new Error('daemon has no machine credential; pair it first')
    const reportUpdateIdentity = deps.reportUpdateIdentity !== false
    return createHandshakeDialer({
      peerRole: 'machine',
      credential: selected,
      caps: [
        ...deliveryCaps(deps.build).filter(
          (cap) => reportUpdateIdentity || cap !== 'update.delivery.feed',
        ),
        CAP_TERMINAL_OUTPUT_BINARY_V1,
        CAP_TERMINAL_INPUT_BINARY_V1,
        // POD-3239: this daemon reports the grid it applied after every resize
        // it dispatches, which is what licenses the server to stop writing the
        // session's geometry from the request side. Offered from the commit that
        // makes it true, so the advertisement is never ahead of the behaviour.
        CAP_DAEMON_GEOMETRY_APPLIED,
      ],
      ...(reportUpdateIdentity ? { build: deps.build } : {}),
      claims: {
        machineId: deps.machineId,
        hostname: hostname(),
        ...(options.name ? { name: options.name } : {}),
      },
    })
  }

  const connectLocal = (): void => {
    acceptedCaps.clear()
    state = 'connecting'
    const localLink = options.localLink
    if (!localLink) {
      terminal('blocked', 'configuration', 'local connection requested without a local link')
      return
    }
    let dialer: ReturnType<typeof createHandshakeDialer>
    try {
      dialer = makeDialer()
    } catch (error) {
      terminal('blocked', 'configuration', String(error))
      return
    }
    state = 'awaiting-ack'
    const attachment = localLink.attach({
      hello: dialer.hello(),
      deliver: (msg) => deps.receiveApplicationFrame(Buffer.from(JSON.stringify(msg))),
      deliverInput: (input) => {
        if (!acceptedCaps.has(CAP_TERMINAL_INPUT_BINARY_V1)) {
          closeForInvalidBinary(
            undefined,
            'unnegotiated',
            new Error('local binary PTY input arrived before capability negotiation'),
          )
          return
        }
        deps.receiveBinaryInput?.(
          {
            v: 1,
            type: 'ptyInput',
            sessionId: input.sessionId,
            inputOrigin: input.inputOrigin,
            ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
          },
          input.bytes,
        )
      },
    })
    if (attachment.established) localAttachment = attachment
    receiveReply(dialer, Buffer.from(JSON.stringify(attachment.reply)), undefined)
  }

  function connectSocket(): void {
    if (closing) return
    acceptedCaps.clear()
    state = 'connecting'
    const active = openSocket(`${options.serverUrl}/daemon`)
    socket = active
    let dialer: ReturnType<typeof createHandshakeDialer> | undefined
    active.once('open', () => {
      if (invalidSockets.has(active)) return
      try {
        dialer = makeDialer()
        state = 'awaiting-ack'
        active.send(JSON.stringify(dialer.hello()))
      } catch (error) {
        terminal('blocked', 'configuration', String(error), active)
      }
    })
    active.on('message', (raw, isBinary) => {
      if (invalidSockets.has(active)) return
      if (!dialer && isBinary) {
        closeForInvalidBinary(
          active,
          'unnegotiated',
          new Error('binary PTY input arrived before the daemon handshake'),
        )
        return
      }
      if (!dialer) {
        terminal('blocked', 'handshake-protocol', 'reply-before-hello', active)
        return
      }
      receiveReply(dialer, raw, active, isBinary === true)
    })
    if (!process.versions.bun) {
      active.on('unexpected-response', (_req, response) => {
        if (invalidSockets.has(active)) return
        if (response.statusCode === 426) handleProtocolMismatch(active, 'http-426')
      })
    }
    active.on('error', (error) => {
      lastSocketError = error instanceof Error ? error.message : String(error)
    })
    active.on('close', () => {
      if (socket === active) {
        socket = undefined
        acceptedCaps.clear()
      }
      stopQueueDrainRetry()
      stopRuntimeEventRetry()
      scheduleReconnect()
    })
  }

  return {
    get state() {
      return state
    },
    start() {
      if (!started) {
        started = true
        if (options.localLink) connectLocal()
        else {
          // Preserve the daemon entrypoint's availability semantics: an offline
          // server does not block boot; the state machine keeps retrying.
          const grace = setTimeout(resolveStart, 10_000)
          grace.unref?.()
          connectSocket()
        }
      }
      return ready
    },
    sendOutput(batch) {
      if (socket && invalidSockets.has(socket)) return
      if (state !== 'connected') return
      assertOutputBatch(batch)
      if (localAttachment) {
        localAttachment.deliverOutput(batch)
        return
      }
      if (socket && acceptedCaps.has(CAP_TERMINAL_OUTPUT_BINARY_V1)) {
        try {
          socket.send(
            encodeBinaryEnvelope(
              {
                v: 1,
                type: 'ptyOutput',
                sessionId: batch.sessionId,
                sourceFrames: batch.sourceFrames,
              },
              batch.bytes,
            ),
          )
        } catch (error) {
          lastSocketError = error instanceof Error ? error.message : String(error)
        }
        return
      }
      const message = legacyOutputMessage(batch)
      deps.sendApplicationFrame(socket, message)
    },
    send(msg) {
      if (msg.type === 'runtimeQueueDrainAbandoned') {
        if (!msg.reportId) {
          throw new Error('runtimeQueueDrainAbandoned requires reportId before daemon send')
        }
        deps.queueDrainOutbox.enqueue({ ...msg, reportId: msg.reportId })
      }
      if (msg.type === 'runtimeEvent') {
        if (!msg.deliveryId) throw new Error('runtimeEvent requires deliveryId before daemon send')
        deps.runtimeEventOutbox.enqueue({ ...msg, deliveryId: msg.deliveryId })
      }
      if (socket && invalidSockets.has(socket)) return
      if (state !== 'connected') {
        if (msg.type === 'machineDiagnostic') {
          pendingDiagnostics.set(`${msg.code}\0${msg.observedVersion ?? ''}`, msg)
        }
        return
      }
      sendConnected(msg)
      if (msg.type === 'runtimeQueueDrainAbandoned') scheduleQueueDrainRetry()
      if (msg.type === 'runtimeEvent') scheduleRuntimeEventRetry()
    },
    acknowledgeQueueDrainReport(reportId) {
      deps.queueDrainOutbox.acknowledge(reportId)
      if (deps.queueDrainOutbox.pending().length === 0) stopQueueDrainRetry()
    },
    acknowledgeRuntimeEvent(deliveryId) {
      deps.runtimeEventOutbox.acknowledge(deliveryId)
      if (deps.runtimeEventOutbox.pending().length === 0) stopRuntimeEventRetry()
    },
    async close() {
      closing = true
      state = 'closed'
      stopQueueDrainRetry()
      stopRuntimeEventRetry()
      if (reconnectTimer !== undefined) {
        timers.clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      localAttachment?.close()
      localAttachment = undefined
      const active = socket
      acceptedCaps.clear()
      socket = undefined
      if (!active || active.readyState === WebSocket.CLOSED) return
      await new Promise<void>((resolve) => {
        active.once('close', resolve)
        active.close()
      })
    },
  }
}
