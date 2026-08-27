import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import type { MachineId } from '@podium/model'
import {
  createHandshakeDialer,
  type DaemonPtyOutputBatch,
  type LocalDaemonAttachment,
  type PeerBuild,
  type PeerCredential,
  type PeerHelloRejected,
} from '@podium/protocol'
import { type DaemonMessage } from '@podium/protocol/daemon'
import { stateDir } from '@podium/runtime/config'
import { writeConnectivity } from '@podium/runtime/connectivity'
import { consumePairCode } from '@podium/runtime/setup'
import {
  acceptsUpdateKeyRotation,
  updateKeyFingerprint,
  type UpdateKeyRotation,
} from '@podium/runtime/update-key-trust'
import WebSocket, { type RawData } from 'ws'
import { deliveryCaps } from './build-report'
import type { DaemonOptions, ReconnectTimers } from './daemon-options'
import { savePairingToken, savePinnedUpdatePubkey } from './identity'
import { decideOnProtocolMismatch, decidePostUpdate } from './self-update'
import { createLogger } from '@podium/logger'

const log = createLogger('daemon:connection')

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5_000

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
  sendOutput(batch: DaemonPtyOutputBatch): void
  send(msg: DaemonMessage): void
  close(): Promise<void>
}

const legacyOutputMessage = (
  batch: DaemonPtyOutputBatch,
): Extract<DaemonMessage, { type: 'agentFrameBatch' }> => {
  if (!Number.isInteger(batch.sourceFrames) || batch.sourceFrames < 1) {
    throw new RangeError('daemon PTY output batches require a positive sourceFrames count')
  }
  return {
    type: 'agentFrameBatch',
    sessionId: batch.sessionId,
    frames: [
      Buffer.from(batch.bytes).toString('base64'),
      ...Array.from({ length: batch.sourceFrames - 1 }, () => ''),
    ],
  }
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
  let reconnectBackoffMs = RECONNECT_MIN_MS
  let closing = false
  let started = false
  let pairFallbackTried = false
  let lastSocketError: string | undefined
  let convergedVersion: string | undefined
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
    })
    if (attachment.established) localAttachment = attachment
    receiveReply(dialer, Buffer.from(JSON.stringify(attachment.reply)), undefined)
  }

  function connectSocket(): void {
    if (closing) return
    state = 'connecting'
    const active = openSocket(`${options.serverUrl}/daemon`)
    socket = active
    let dialer: ReturnType<typeof createHandshakeDialer> | undefined
    active.once('open', () => {
      try {
        dialer = makeDialer()
        state = 'awaiting-ack'
        active.send(JSON.stringify(dialer.hello()))
      } catch (error) {
        terminal('blocked', 'configuration', String(error), active)
      }
    })
    active.on('message', (raw) => {
      if (!dialer) {
        terminal('blocked', 'handshake-protocol', 'reply-before-hello', active)
        return
      }
      receiveReply(dialer, raw, active)
    })
    if (!process.versions.bun) {
      active.on('unexpected-response', (_req, response) => {
        if (response.statusCode === 426) handleProtocolMismatch(active, 'http-426')
      })
    }
    active.on('error', (error) => {
      lastSocketError = error instanceof Error ? error.message : String(error)
    })
    active.on('close', () => {
      if (socket === active) socket = undefined
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
      if (state !== 'connected') return
      const message = legacyOutputMessage(batch)
      if (localAttachment) {
        localAttachment.deliver(message)
        return
      }
      deps.sendApplicationFrame(socket, message)
    },
    send(msg) {
      if (state !== 'connected') {
        if (msg.type === 'machineDiagnostic') {
          pendingDiagnostics.set(`${msg.code}\0${msg.observedVersion ?? ''}`, msg)
        }
        return
      }
      if (localAttachment) {
        localAttachment.deliver(msg)
        return
      }
      deps.sendApplicationFrame(socket, msg)
    },
    async close() {
      closing = true
      state = 'closed'
      if (reconnectTimer !== undefined) {
        timers.clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
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
