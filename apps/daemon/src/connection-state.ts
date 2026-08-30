import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { createLogger } from '@podium/logger'
import type { MachineId } from '@podium/model'
import {
  createHandshakeDialer,
  type LocalDaemonAttachment,
  type PeerBuild,
  type PeerCredential,
  type PeerHelloRejected,
} from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { stateDir } from '@podium/runtime/config'
import { writeConnectivity } from '@podium/runtime/connectivity'
import { applyServerUrl, consumePairCode, wssFrom } from '@podium/runtime/setup'
import {
  acceptsUpdateKeyRotation,
  type UpdateKeyRotation,
  updateKeyFingerprint,
} from '@podium/runtime/update-key-trust'
import WebSocket, { type RawData } from 'ws'
import { deliveryCaps } from './build-report'
import type { DaemonOptions, ReconnectTimers } from './daemon-options'
import { savePairingToken, savePinnedUpdatePubkey } from './identity'
import { decideOnProtocolMismatch, decidePostUpdate } from './self-update'

const log = createLogger('daemon:connection')

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5_000
const SOCKET_OPEN_DEADLINE_MS = 10_000
const PEER_HELLO_ACK_DEADLINE_MS = 10_000

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
  send(data: string): void
  close(): void
  terminate(): void
  once(event: 'open' | 'close', listener: () => void): this
  on(event: 'message', listener: (raw: RawData) => void): this
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
  readonly sendApplicationFrame: (socket: SocketLike | undefined, msg: DaemonMessage) => void
  readonly onConnected: () => { convergedVersion?: string } | void
  readonly onTerminal: () => void | Promise<void>
  readonly openSocket?: (url: string) => SocketLike
  readonly restartAfterUpdate?: () => void
}

export interface DaemonConnection {
  readonly state: DaemonConnectionState
  start(): Promise<void>
  send(msg: DaemonMessage): void
  quiesceEndpoint(transferId: string): void
  resumeEndpoint(transferId: string): void
  prepareEndpointCommit(transferId: string, publicUrl: string): Promise<string>
  activateEndpoint(transferId: string): void
  close(): Promise<void>
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
  let socketGeneration = 0
  let openDeadline: { generation: number; handle: unknown } | undefined
  let acknowledgementDeadline: { generation: number; handle: unknown } | undefined
  let reconnectBackoffMs = RECONNECT_MIN_MS
  let closing = false
  let started = false
  let pairFallbackTried = false
  let lastSocketError: string | undefined
  let convergedVersion: string | undefined
  let activeServerUrl = options.serverUrl
  let quiescedTransferId: string | undefined
  let endpointActivationPending = false
  let endpointTargetUrl: string | undefined
  const quiescedFrames: DaemonMessage[] = []
  // Host diagnostics are durable attention, not telemetry. Keep the latest one
  // per code/version until an authenticated machine transport exists; ordinary
  // runtime frames retain the historical drop-while-offline behavior.
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
          serverUrl: activeServerUrl,
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

  const clearOpenDeadline = (generation?: number): void => {
    if (!openDeadline || (generation !== undefined && openDeadline.generation !== generation))
      return
    timers.clearTimeout(openDeadline.handle)
    openDeadline = undefined
  }

  const clearAcknowledgementDeadline = (generation?: number): void => {
    if (
      !acknowledgementDeadline ||
      (generation !== undefined && acknowledgementDeadline.generation !== generation)
    )
      return
    timers.clearTimeout(acknowledgementDeadline.handle)
    acknowledgementDeadline = undefined
  }

  const clearHandshakeDeadlines = (generation?: number): void => {
    clearOpenDeadline(generation)
    clearAcknowledgementDeadline(generation)
  }

  const scheduleReconnect = (): void => {
    if (closing || reconnectTimer !== undefined || state === 'unauthorized' || state === 'blocked')
      return
    state = 'backoff'
    const delay = reconnectBackoffMs
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
    state = 'connected'
    reconnectBackoffMs = RECONNECT_MIN_MS
    lastSocketError = undefined
    const boot = deps.onConnected() ?? {}
    convergedVersion = boot.convergedVersion ?? convergedVersion
    report({
      state: 'connected',
      lastHelloOkAt: new Date().toISOString(),
    })
    if (quiescedTransferId && endpointTargetUrl === activeServerUrl) {
      quiescedTransferId = undefined
      endpointTargetUrl = undefined
      for (const frame of quiescedFrames.splice(0)) sendConnected(frame)
    }
    for (const diagnostic of pendingDiagnostics.values()) {
      if (localAttachment) localAttachment.deliver(diagnostic)
      else deps.sendApplicationFrame(socket, diagnostic)
    }
    pendingDiagnostics.clear()
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

  const receiveReply = (
    dialer: ReturnType<typeof createHandshakeDialer>,
    raw: RawData,
    active: SocketLike | undefined,
  ): void => {
    const step = dialer.receive(raw.toString())
    if (step.action === 'deliver') {
      deps.receiveApplicationFrame(Buffer.from(step.raw))
      return
    }
    if (step.action === 'established') {
      established(step.issuedToken, step.updatePubkey, step.updateKeyRotations, active)
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
      caps: deliveryCaps(deps.build).filter(
        (cap) => reportUpdateIdentity || cap !== 'update.delivery.feed',
      ),
      ...(reportUpdateIdentity ? { build: deps.build } : {}),
      claims: {
        machineId: deps.machineId,
        hostname: hostname(),
        ...(options.name ? { name: options.name } : {}),
      },
    })
  }

  const connectLocal = (): void => {
    state = 'connecting'
    report({ state: 'connecting' })
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
    report({ state: 'awaiting-ack' })
    const attachment = localLink.attach({
      hello: dialer.hello(),
      deliver: (msg) => deps.receiveApplicationFrame(Buffer.from(JSON.stringify(msg))),
    })
    if (attachment.established) localAttachment = attachment
    receiveReply(dialer, Buffer.from(JSON.stringify(attachment.reply)), undefined)
  }

  function connectSocket(): void {
    if (closing) return
    state = 'connecting'
    report({ state: 'connecting' })
    const active = openSocket(`${activeServerUrl}/daemon`)
    const generation = ++socketGeneration
    socket = active
    const isCurrent = (): boolean =>
      !closing && socket === active && socketGeneration === generation
    let dialer: ReturnType<typeof createHandshakeDialer> | undefined
    openDeadline = {
      generation,
      handle: timers.setTimeout(() => {
        if (openDeadline?.generation !== generation) return
        openDeadline = undefined
        if (!isCurrent() || state !== 'connecting') return
        lastSocketError = `WebSocket open timed out after ${SOCKET_OPEN_DEADLINE_MS}ms`
        active.terminate()
      }, SOCKET_OPEN_DEADLINE_MS),
    }
    active.once('open', () => {
      if (!isCurrent()) return
      clearOpenDeadline(generation)
      try {
        dialer = makeDialer()
        state = 'awaiting-ack'
        report({ state: 'awaiting-ack' })
        acknowledgementDeadline = {
          generation,
          handle: timers.setTimeout(() => {
            if (acknowledgementDeadline?.generation !== generation) return
            acknowledgementDeadline = undefined
            if (!isCurrent() || state !== 'awaiting-ack') return
            lastSocketError = `peerHello acknowledgement timed out after ${PEER_HELLO_ACK_DEADLINE_MS}ms`
            active.terminate()
          }, PEER_HELLO_ACK_DEADLINE_MS),
        }
        active.send(JSON.stringify(dialer.hello()))
      } catch (error) {
        clearAcknowledgementDeadline(generation)
        terminal('blocked', 'configuration', String(error), active)
      }
    })
    active.on('message', (raw) => {
      if (!isCurrent()) return
      if (!dialer) {
        terminal('blocked', 'handshake-protocol', 'reply-before-hello', active)
        return
      }
      receiveReply(dialer, raw, active)
      if (state !== 'awaiting-ack') clearAcknowledgementDeadline(generation)
    })
    if (!process.versions.bun) {
      active.on('unexpected-response', (_req, response) => {
        if (!isCurrent()) return
        if (response.statusCode === 426) handleProtocolMismatch(active, 'http-426')
      })
    }
    active.on('error', (error) => {
      if (!isCurrent()) return
      lastSocketError = error instanceof Error ? error.message : String(error)
    })
    active.on('close', () => {
      if (socket !== active || socketGeneration !== generation) return
      socket = undefined
      clearHandshakeDeadlines(generation)
      if (closing) return
      if (endpointActivationPending) {
        endpointActivationPending = false
        reconnectBackoffMs = RECONNECT_MIN_MS
        connectSocket()
      } else {
        scheduleReconnect()
      }
    })
  }

  const sendConnected = (msg: DaemonMessage): void => {
    if (localAttachment) {
      localAttachment.deliver(msg)
      return
    }
    deps.sendApplicationFrame(socket, msg)
  }

  const probeAuthenticatedEndpointOnce = (publicUrl: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const candidate = openSocket(`${wssFrom(publicUrl)}/daemon`)
      let settled = false
      let dialer: ReturnType<typeof createHandshakeDialer> | undefined
      const timer = setTimeout(
        () => finish(new Error('promoted server authentication timed out')),
        3_000,
      )
      timer.unref?.()
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          candidate.close()
        } catch {}
        if (error) reject(error)
        else resolve()
      }
      const socketError = (error: unknown): Error => {
        if (error instanceof Error) return error
        if (typeof error === 'object' && error !== null && 'message' in error)
          return new Error(String((error as { message?: unknown }).message))
        return new Error(String(error))
      }
      candidate.once('open', () => {
        try {
          dialer = makeDialer()
          candidate.send(JSON.stringify(dialer.hello()))
        } catch (error) {
          finish(socketError(error))
        }
      })
      candidate.on('message', (raw) => {
        if (!dialer || settled) return
        const step = dialer.receive(raw.toString())
        if (step.action === 'established') finish()
        else if (step.action === 'protocol-error') finish(new Error(step.error))
        else if (step.action === 'rejected')
          finish(new Error(step.reply.message ?? step.reply.reason))
      })
      candidate.on('unexpected-response', (_request, response) =>
        finish(
          new Error(
            `promoted server rejected the daemon upgrade with HTTP ${
              response.statusCode ?? 'unknown'
            }`,
          ),
        ),
      )
      candidate.on('error', (error) => finish(socketError(error)))
      candidate.on('close', () => {
        if (!settled) finish(new Error('promoted server closed the authentication probe'))
      })
    })

  const probeAuthenticatedEndpoint = async (publicUrl: string): Promise<void> => {
    const deadline = Date.now() + 15_000
    let lastError = new Error('promoted server was not ready')
    while (Date.now() < deadline) {
      try {
        await probeAuthenticatedEndpointOnce(publicUrl)
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
    }
    throw lastError
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
    send(msg) {
      if (quiescedTransferId && msg.type !== 'serverEndpointResult') {
        quiescedFrames.push(msg)
        return
      }
      if (state !== 'connected') {
        if (msg.type === 'machineDiagnostic') {
          pendingDiagnostics.set(`${msg.code}\0${msg.observedVersion ?? ''}`, msg)
        }
        return
      }
      sendConnected(msg)
    },
    quiesceEndpoint(transferId) {
      // A final snapshot may replace the target stage (and therefore transfer id)
      // while this same move remains quiesced. Re-key the hold without flushing it.
      quiescedTransferId = transferId
    },
    resumeEndpoint(_transferId) {
      // A failed final restage can leave this daemon holding the preceding stage id.
      // The command arrives on the authenticated old-authority socket, so resuming
      // that authority must release whichever stage of this move currently owns it.
      if (!quiescedTransferId) return
      quiescedTransferId = undefined
      if (state === 'connected') for (const frame of quiescedFrames.splice(0)) sendConnected(frame)
    },
    async prepareEndpointCommit(transferId, publicUrl) {
      if (quiescedTransferId !== transferId)
        throw new Error('endpoint commit does not own this daemon quiesce')
      await probeAuthenticatedEndpoint(publicUrl)
      const applied = applyServerUrl(publicUrl)
      activeServerUrl = applied.serverUrl
      endpointTargetUrl = applied.serverUrl
      return applied.serverUrl
    },
    activateEndpoint(transferId) {
      if (quiescedTransferId !== transferId) return
      endpointActivationPending = true
      const active = socket
      if (active) active.close()
      else {
        endpointActivationPending = false
        connectSocket()
      }
    },
    async close() {
      closing = true
      state = 'closed'
      if (reconnectTimer !== undefined) {
        timers.clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      clearHandshakeDeadlines()
      localAttachment?.close()
      localAttachment = undefined
      const active = socket
      socket = undefined
      if (!active || active.readyState === WebSocket.CLOSED) return
      await new Promise<void>((resolve) => {
        active.once('close', resolve)
        active.close()
      })
    },
  }
}
