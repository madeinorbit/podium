import { spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import type { MachineId } from '@podium/model'
import {
  createHandshakeDialer,
  type DaemonMessage,
  type LocalDaemonAttachment,
  type PeerCredential,
  type PeerHelloRejected,
} from '@podium/protocol'
import { stateDir } from '@podium/runtime/config'
import { writeConnectivity } from '@podium/runtime/connectivity'
import { consumePairCode } from '@podium/runtime/setup'
import WebSocket, { type RawData } from 'ws'
import { buildReport, deliveryCaps } from './build-report'
import type { DaemonOptions, ReconnectTimers } from './daemon-options'
import { savePairingToken, savePinnedUpdatePubkey } from './identity'
import { decideOnProtocolMismatch, decidePostUpdate } from './self-update'

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5_000

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
  readonly machineId: MachineId
  readonly identity: { token?: string; updatePubkey?: string }
  readonly receiveApplicationFrame: (raw: RawData) => void
  readonly sendApplicationFrame: (socket: SocketLike | undefined, msg: DaemonMessage) => void
  readonly onConnected: () => void
  readonly onTerminal: () => void | Promise<void>
  readonly openSocket?: (url: string) => SocketLike
  readonly restartAfterUpdate?: () => void
}

export interface DaemonConnection {
  readonly state: DaemonConnectionState
  start(): Promise<void>
  send(msg: DaemonMessage): void
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
  let reconnectBackoffMs = RECONNECT_MIN_MS
  let closing = false
  let started = false
  let pairFallbackTried = false
  let lastSocketError: string | undefined
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
      writeConnectivity({ serverUrl: options.serverUrl, ...patch }, connectivityDir)
    } catch (error) {
      console.warn('[podium:daemon] could not write connectivity status:', error)
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
        ? 'Authorization will not be retried; ask the machine owner or an admin to re-pair it.'
        : 'Not reconnecting; update the daemon or repair its configuration.'
    console.error(`[podium:daemon] server rejected this daemon (${type}): ${reason}. ${guidance}`)
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
      console.warn('[podium:daemon] could not clear consumed pair code:', error)
    }
  }

  const persistBootstrapPin = (updatePubkey: string): void => {
    identity.updatePubkey = updatePubkey
    savePinnedUpdatePubkey(
      updatePubkey,
      options.identityDir ? { dir: options.identityDir } : {},
    )
  }

  const established = (
    issuedToken?: string,
    updatePubkey?: string,
    active?: SocketLike,
  ): void => {
    if (issuedToken) {
      persistPairing(issuedToken, updatePubkey)
    } else if (updatePubkey !== undefined) {
      if (identity.updatePubkey === undefined && options.bootstrapToken) {
        persistBootstrapPin(updatePubkey)
      } else if (updatePubkey !== identity.updatePubkey) {
        terminal(
          'blocked',
          'server-update-key',
          'server update key changed outside pairing',
          active,
        )
        return
      }
    }
    state = 'connected'
    reconnectBackoffMs = RECONNECT_MIN_MS
    lastSocketError = undefined
    report({ state: 'connected', lastHelloOkAt: new Date().toISOString() })
    deps.onConnected()
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
    })
    if (action === 'backoff') {
      console.error('[podium:daemon] protocol mismatch; update the daemon to match the server.')
      active.close()
      return
    }
    console.error('[podium:daemon] protocol mismatch; running `podium update`.')
    const result = spawnSync(process.execPath, ['update'], { stdio: 'inherit' })
    if (decidePostUpdate(result.status) === 'restart') {
      ;(deps.restartAfterUpdate ?? (() => process.exit(0)))()
      return
    }
    terminal(
      'blocked',
      'protocol-mismatch',
      `no newer build available (podium update exit ${result.status}) — manual update required`,
      active,
    )
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
      established(step.issuedToken, step.updatePubkey, active)
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
      console.warn(
        '[podium:daemon] stored token rejected; retrying once with the supplied pair code.',
      )
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
    const installDir =
      process.env.PODIUM_HOME ??
      (/(?:^|[\\/])podium$/.test(process.execPath) ? dirname(process.execPath) : undefined)
    const build = buildReport(process.env, installDir)
    return createHandshakeDialer({
      peerRole: 'machine',
      credential: selected,
      caps: deliveryCaps(build.installKind),
      build,
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
