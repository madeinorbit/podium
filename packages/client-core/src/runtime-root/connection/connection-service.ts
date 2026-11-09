/**
 * THE CONNECTION SERVICE (POD-6681; detailed design 2.1).
 *
 * One per signed-in user, inside the runtime root. It owns the socket for that
 * user's whole session and nothing outside the root reaches it:
 *
 * - it builds the SocketHub (`./hub.ts`), with the platform's heartbeat cadence;
 * - it dials once the root starts (a zero-delay timer, so the first paint is
 *   not held up by the dial);
 * - it reconnects at once when the client comes back on screen and when the
 *   browser says the network came back, instead of waiting out the hub's
 *   backoff;
 * - it owns "is this client on screen" (`./visibility.ts`) and hands each
 *   change to the root's other listeners before it reconnects;
 * - it tells the outbox when the connection's health returns, so the queue
 *   drains after a server restart behind a healthy network;
 * - it writes the connection condition (state, ping, clock skew, the server's
 *   build and features) into the LiveStore with the frame, and marks every
 *   reading of the present unknown when the connection is declared lost.
 *
 * Moved out of the old store (engine/runtime.ts and engine/wiring.ts) without
 * changing what it does.
 */

import type { ServerFeatureFacts } from '@podium/protocol'
import type { PodiumClientApi } from '../../api'
import type { LiveFrameQueue } from '../../live/frame-queue'
import type { ConnectionCondition, ConnectionState, LiveStore } from '../../live/live-store'
import { hasDomWindow } from '../../platform-globals'
import type { Replica } from '../../replica/kernel/facade'
import type { FeedSinkPort, SocketHub, SocketHubOptions } from '../../socket-transport'
import type { ConnectionHealth } from '../../socket-transport/socket-hub'
import { type CreateHub, createEngineHub } from './hub'
import { domVisibility, type VisibilitySource } from './visibility'

export interface ConnectionServiceOptions {
  /** The socket endpoint, already fenced to this user (POD-6292). */
  readonly wsClientUrl: string
  readonly api: PodiumClientApi
  readonly replica: Replica
  readonly live: LiveStore
  /** The root's frame queue: the connection condition goes in with every other reading. */
  readonly frames: LiveFrameQueue
  readonly onFatalError: (message: string) => void
  readonly formatError: (error: unknown, fallback: string) => string
  /** False for a local-only boot: the hub is built but never dialled. */
  readonly networkEnabled: boolean
  /** Where visibility comes from. Default: `document.visibilityState`. */
  readonly visibility?: VisibilitySource
  /** Test seam: replaces SocketHub construction. */
  readonly createHub?: CreateHub
  /** Wire-v2 feed sink (POD-1223), from the platform's replica assembly. */
  readonly feed?: FeedSinkPort
  /** Liveness ping cadence. Default: the hub's own (2.5 s). Native passes 10 s. */
  readonly heartbeatIntervalMs?: number
  /** Login carriage supplied by the authenticated platform owner. */
  readonly makeSocket?: SocketHubOptions['makeSocket']
}

/** The connection condition the hub's readings describe. */
export function connectionStateOf(health: ConnectionHealth, connected: boolean): ConnectionState {
  if (health.status === 'down') return 'offline'
  // Before the first connection the hub reports `ok` with no socket: the
  // first dial, not a loss (the fatal-error page owns that messaging).
  if (!connected) return 'connecting'
  return health.status === 'degraded' ? 'degraded' : 'online'
}

export class ConnectionService {
  /** The user's socket. Read only inside the runtime root (and, until POD-6682, the old store). */
  readonly hub: SocketHub
  /** Where this client learns whether it is on screen (POD-2055 WP-C4). */
  readonly visibility: VisibilitySource

  private readonly options: ConnectionServiceOptions
  private readonly visibilityListeners = new Set<() => void>()
  private readonly reconnectListeners = new Set<() => void>()
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private offs: Array<() => void> = []
  private started = false
  /** Whether the socket and listeners were released since the last start (or construction). */
  private released = false
  private disposed = false

  constructor(options: ConnectionServiceOptions) {
    this.options = options
    this.visibility = options.visibility ?? domVisibility()
    this.hub = createEngineHub({
      wsClientUrl: options.wsClientUrl,
      api: options.api,
      replica: options.replica,
      onFatalError: (m) => options.onFatalError(m),
      createHub: options.createHub,
      makeSocket: options.makeSocket,
      feed: options.feed,
      ...(options.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
        : {}),
    })
  }

  /**
   * Every visibility change, in the order listeners joined, BEFORE the service
   * reconnects on it: presence and view-state go out first, as they always have.
   */
  onVisibilityChange(listener: () => void): () => void {
    this.visibilityListeners.add(listener)
    return () => this.visibilityListeners.delete(listener)
  }

  /** The connection's health returned to `ok` from `degraded` or `down`. */
  onReconnected(listener: () => void): () => void {
    this.reconnectListeners.add(listener)
    return () => this.reconnectListeners.delete(listener)
  }

  /** Arm every listener and dial. Idempotent; re-arms after {@link stop} (StrictMode). */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.released = false
    const { hub } = this
    const { networkEnabled } = this.options
    const offs = this.offs

    // The connection condition follows the hub: its health rule, ping round
    // trip, clock skew and the server identity from each `welcome`. A runtime
    // without network has none, so the condition stays where it was born.
    if (networkEnabled) {
      offs.push(hub.on('connectionHealth', () => this.queueCondition()))
      offs.push(hub.on('serverIdentity', () => this.queueCondition()))
      offs.push(hub.on('clockSkew', () => this.queueCondition()))
      this.queueCondition()
    }

    // Reconnect drains the outbox: the browser 'online' event (the outbox's own
    // trigger) misses a server restart behind a healthy network, but the hub's
    // heartbeat-derived health catches both.
    let prevHealth = hub.connectionHealth().status
    offs.push(
      hub.on('connectionHealth', (h) => {
        if (h.status === 'ok' && prevHealth !== 'ok') {
          for (const listener of [...this.reconnectListeners]) listener()
        }
        prevHealth = h.status
      }),
    )

    // Presence feeds the server's smart router (skip mobile push while visible).
    // The SOURCE is injected (POD-2055 WP-C4): web reads the document, native
    // reads AppState, and only the source knows which transition just happened.
    offs.push(
      this.visibility.subscribe(() => {
        for (const listener of [...this.visibilityListeners]) listener()
        // A client that slept through its heartbeat deadline reconnects the
        // moment it is looked at again, instead of waiting out up to 10s of
        // backoff with the feed and every terminal dark.
        if (networkEnabled && this.visibility.isVisible()) hub.connectNow()
      }),
    )
    // The OS knows the network came back long before the backoff timer does.
    // Feature-detected rather than assumed: React Native defines `window` as the
    // global object, without DOM listeners on it (POD-2055 F4) — where this
    // declines, the platform's own signal is injected instead (mobile: NetInfo).
    if (networkEnabled && hasDomWindow()) {
      const dom = window
      const onOnline = (): void => hub.connectNow()
      dom.addEventListener('online', onOnline)
      offs.push(() => dom.removeEventListener('online', onOnline))
    }

    if (networkEnabled) {
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null
        try {
          hub.connect()
        } catch (e) {
          this.options.onFatalError(this.options.formatError(e, 'WebSocket connection failed'))
        }
      }, 0)
    }
  }

  /** Release every listener, cancel a pending dial and close the socket.
   *  Reversible: {@link start} dials again (React StrictMode's remount). */
  stop(): void {
    if (this.released) return
    this.released = true
    this.started = false
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    for (const off of this.offs.splice(0)) {
      try {
        off()
      } catch {
        // teardown is best-effort
      }
    }
    this.hub.dispose()
  }

  /** Sign-out. Nothing this service armed fires afterwards. */
  dispose(): void {
    this.stop()
    if (this.disposed) return
    this.disposed = true
    this.visibilityListeners.clear()
    this.reconnectListeners.clear()
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  private queueCondition(): void {
    const { hub } = this
    const { live } = this.options
    this.options.frames.queue('connection', () => {
      const health = hub.connectionHealth()
      const identity = hub.serverIdentity()
      const skewMs = hub.clockSkewMs()
      const state = connectionStateOf(health, hub.connected)
      const previous = live.connection
      const next: ConnectionCondition = {
        state,
        since: state === previous.state ? previous.since : health.since,
        ...(health.rttMs !== null && state !== 'offline' ? { pingMs: health.rttMs } : {}),
        ...(skewMs !== null ? { skewMs } : {}),
        ...(identity?.build !== undefined ? { serverBuild: identity.build } : {}),
        ...(identity?.features !== undefined ? { serverFeatures: identity.features } : {}),
      }
      if (sameConnection(previous, next)) return
      // DECLARED LOST (D20): every reading of the present goes unknown with it.
      if (state === 'offline' && previous.state !== 'offline') live.markAllUnknown(health.since)
      live.setConnection(next)
    })
  }
}

function sameConnection(a: ConnectionCondition, b: ConnectionCondition): boolean {
  return (
    a.state === b.state &&
    a.since === b.since &&
    a.pingMs === b.pingMs &&
    a.skewMs === b.skewMs &&
    a.serverBuild === b.serverBuild &&
    sameFacts(a.serverFeatures, b.serverFeatures)
  )
}

/** The same facts: every welcome carries a fresh object, usually equal by value. */
function sameFacts(a: ServerFeatureFacts | undefined, b: ServerFeatureFacts | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
