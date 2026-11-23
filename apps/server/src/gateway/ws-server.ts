/**
 * Bun-native WebSocket upgrade boundary.
 *
 * Bun intercepts `ws`, but its compatibility WebSocketServer does not negotiate
 * permessage-deflate. This boundary therefore uses Bun.serve's native server
 * sockets and adapts them to the small evented socket interface used by the
 * gateway's already-tested client and daemon protocol layers.
 */

import { createLogger } from '@podium/logger'
import type { ServerReadiness, UserId, UserRole, WorkspaceId } from '@podium/model'
import {
  CAP_SYNC_HTTP_V1,
  CLIENT_WIRE_VERSION,
  DAEMON_WIRE_VERSION,
  fencedMemberOf,
  MIN_CLIENT_WIRE_VERSION,
  MIN_DAEMON_WIRE_VERSION,
  memberFenceRefuses,
  negotiateVersion,
  SIGN_IN_ENDED_CLOSE,
  WireVersionOffer,
} from '@podium/protocol'
import { measureTask } from '@podium/runtime/task-attribution'

export interface NativeServer<T> {
  readonly port: number
  upgrade(request: Request, options: { data: T }): boolean
  requestIP?(request: Request): { address: string } | null
  stop(closeActiveConnections?: boolean): void | Promise<void>
}

interface NativeServerWebSocket<T> {
  data: T
  readonly readyState: number
  getBufferedAmount(): number
  /** Bun's send status: positive bytes written, -1 buffered, 0 not accepted. */
  sendText(data: string, compress?: boolean): number
  sendBinary(data: Uint8Array, compress?: boolean): number
  ping(): number
  terminate(): void
  close(code?: number, reason?: string): void
}

export interface NativeWebSocketHandler<T> {
  data: T
  perMessageDeflate: { compress: '3KB'; decompress: '3KB' }
  maxPayloadLength: number
  backpressureLimit: number
  closeOnBackpressureLimit: boolean
  idleTimeout: number
  sendPings: boolean
  open(socket: NativeServerWebSocket<T>): void
  message(socket: NativeServerWebSocket<T>, message: string | Buffer): void
  pong(socket: NativeServerWebSocket<T>): void
  /** Bun's buffer for this socket shrank; a paused sender may try again. */
  drain(socket: NativeServerWebSocket<T>): void
  close(socket: NativeServerWebSocket<T>): void
}

/**
 * HOW LONG AN HTTP CONNECTION MAY MOVE NO DATA BEFORE BUN CLOSES IT (POD-6240).
 *
 * Bun's default is ten seconds, and it counts a response the client is not
 * reading fast enough as idle. A fleet machine downloading the ~264 MB update
 * artifact over a tailnet link that paused for ten seconds had its connection
 * closed mid-body ("The socket connection was closed unexpectedly"), which
 * failed the whole update. Measured on Bun 1.4.2: a 15 s reader pause is cut at
 * the default; with 120 s a 30 s pause completes. Per-request
 * `server.timeout(request, n)` does NOT extend the response phase, so this is
 * the server-wide value.
 *
 * Kept above the daemon's own no-data deadline (`DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS`,
 * 60 s) so a really dead transfer is named by the machine first.
 */
export const HTTP_IDLE_TIMEOUT_S = 120

export interface NativeServeOptions<T> {
  port: number
  hostname: string
  /** Seconds; see {@link HTTP_IDLE_TIMEOUT_S}. Bun's maximum is 255. */
  idleTimeout?: number
  tls?: { key: string; cert: string }
  websocket: NativeWebSocketHandler<T>
  fetch(
    request: Request,
    server: NativeServer<T>,
  ): Response | undefined | Promise<Response | undefined>
}

export function serveNative<T>(options: NativeServeOptions<T>): NativeServer<T> {
  const runtime = globalThis as typeof globalThis & {
    Bun: { serve<U>(options: NativeServeOptions<U>): NativeServer<U> }
  }
  return runtime.Bun.serve(options)
}

import type { SessionRegistry } from '../relay'
import { routedPath } from '../workspace-edge'
import { userClientPrincipal } from './client-principal'
import { wireClientSocket } from './client-socket'
import {
  ACCEPT_PLAIN_DAEMON_LINKS,
  type DaemonLinkFacts,
  PLAIN_DAEMON_LINK_REFUSAL,
} from './daemon-link-kind'
import { wireDaemonSocket, wireMachineSocket } from './daemon-socket'
import {
  CLIENT_PLANE_LIVENESS,
  DAEMON_PLANE_LIVENESS,
  type HeartbeatSocket,
  type SweepTimers,
} from './plane-liveness'
import { type GatewaySocket, shouldCompressWebSocketFrame, WS_MAX_PAYLOAD_BYTES } from './ws-send'

const log = createLogger('server:gateway:ws')

export interface WsHandle {
  handleRequest(
    request: Request,
    server: NativeServer<SocketData>,
  ): Promise<Response | null | undefined>
  websocket: NativeWebSocketHandler<SocketData>
  revokeClientCredential(credentialId: string): void
  close(): Promise<void>
}

export interface WsClientPrincipal {
  userId: UserId
  userRole: UserRole
  /**
   * The device sign-in this socket was opened with, when there is one. Ending
   * that sign-in closes the socket at once through `revokeClientCredential`.
   */
  credentialId?: string
  /**
   * Is the socket still entitled to stay open? Asked on every client heartbeat.
   * False or a rejection closes the socket, and so does a check that has not
   * answered within two heartbeats.
   */
  maintain?: () => Promise<boolean>
}

/** An upgrade that is refused with its own HTTP answer instead of the plain 401. */
export interface WsClientRefusal {
  refused: { status: 400 | 401 | 403; body: { error: string } }
}

/** The upgrade's workspace, or the edge's refusal (workspace-edge.ts). */
export type WsWorkspaceBinding =
  | { workspaceId: WorkspaceId }
  | { refused: { status: 400 | 401 | 403 | 404; body: { error: string; message?: string } } }

export interface WsAuthOptions {
  /**
   * THE WORKSPACE EDGE FOR SOCKETS (POD-7309): every upgrade of /client,
   * /daemon and /machine is bound to one workspace before anything else reads
   * it. A socket bound to a workspace other than this registry's is refused:
   * its machine rows, members and sessions are another workspace's.
   */
  bindWorkspace?: (request: Request) => Promise<WsWorkspaceBinding>
  readinessForClient?: () => ServerReadiness
  authorizeClient?: (request: Request) => boolean
  userForClient?: (request: Request) => UserId | undefined
  roleForClient?: (request: Request) => UserRole | undefined
  principalForClient?: (
    request: Request,
  ) =>
    | WsClientPrincipal
    | WsClientRefusal
    | undefined
    | Promise<WsClientPrincipal | WsClientRefusal | undefined>
}

/** Bun's own buffer limit: the application mark plus the largest single frame. */
export const NATIVE_BACKPRESSURE_LIMIT_BYTES =
  CLIENT_PLANE_LIVENESS.sendBufferLimitBytes + WS_MAX_PAYLOAD_BYTES

/** A socket's validity fails closed if its heartbeat refresh is older than two ticks. */
export const CLIENT_CREDENTIAL_VALIDITY_MAX_AGE_MS = CLIENT_PLANE_LIVENESS.heartbeatIntervalMs * 2

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function hostHeaderName(host: string | null | undefined): string | undefined {
  if (!host) return undefined
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

/** No deployment has said anything, which is every self-hosted install. */
const NO_ALLOWED_ORIGINS: ReadonlySet<string> = new Set()

/**
 * Whether a socket origin is allowed, and when it is not, WHY.
 *
 * A local shape rather than an import from ../http-cors on purpose: that module
 * is the Hono CORS middleware, which has no business on the socket path, and the
 * two predicates stay deliberately different (see `isAllowedWsOrigin`).
 */
export type OriginVerdict = 'allowed' | 'parse' | 'not-allowed'

/**
 * Cross-site WebSocket-hijacking defense shared by both socket planes.
 *
 * `allowed` is this deployment's `allowedOrigins`: the exact origins a browser
 * page may open a socket from when it is neither loopback nor this same host —
 * the split-hosting case, a page on `app.<site>` connecting to `api.<site>`.
 * It ADDS a case. An empty set, which is every install that names nothing,
 * leaves every answer here as it was.
 */
export function isAllowedWsOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
  allowed: ReadonlySet<string> = NO_ALLOWED_ORIGINS,
): boolean {
  return wsOriginVerdict(origin, host, allowed) === 'allowed'
}

/** {@link isAllowedWsOrigin}, keeping the reason it refused. */
export function wsOriginVerdict(
  origin: string | null | undefined,
  host: string | null | undefined,
  allowed: ReadonlySet<string> = NO_ALLOWED_ORIGINS,
): OriginVerdict {
  if (!origin) return 'allowed'
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return 'parse'
  }
  if (parsed.protocol === 'tauri:') return 'allowed'
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return 'allowed'
  const reqHost = hostHeaderName(host)
  if (LOOPBACK_HOSTS.has(reqHost ?? '')) return 'allowed'
  if (reqHost && parsed.hostname === reqHost) return 'allowed'
  return allowed.has(parsed.origin) ? 'allowed' : 'not-allowed'
}

export interface WsTransportDeps {
  timers?: SweepTimers
  /**
   * The facts of a daemon's upgrade request, read the way sign-in reads them
   * (its peer address and the trusted proxy hops are the server's). Absent: no
   * link is recorded, so no daemon is judged safe for credentials.
   */
  daemonLink?: (request: Request) => DaemonLinkFacts
  /** Tests only: the removal-date switch below, flipped. */
  acceptPlainDaemonLinks?: boolean
  /** Exact origins from `allowedOrigins` that may open a browser socket. */
  allowedOrigins?: ReadonlySet<string>
  /**
   * Told about every upgrade refused on its Origin. The 403 is otherwise
   * indistinguishable from every other reason a socket did not open, and a
   * deployment whose allow-list is wrong has nothing to read.
   */
  now?: () => number
  onOriginRefused?: (info: {
    origin: string | undefined
    host: string | undefined
    reason: Exclude<OriginVerdict, 'allowed'>
  }) => void
}

interface SocketData {
  kind: 'client' | 'daemon' | 'machine'
  url: string
  /** The workspace the upgrade was bound to; the registry's own. */
  workspaceId?: WorkspaceId
  /** How a daemon's request reached the server (credential management §8). */
  link?: DaemonLinkFacts
  userId?: UserId
  userRole?: UserRole
  credentialId?: string
  maintain?: () => Promise<boolean>
  socket?: NativeGatewaySocket
}

type SocketEvent = 'message' | 'close' | 'pong' | 'drain'
type SocketListener = (...args: never[]) => void

/**
 * The evented adapter over one native Bun socket. Exported for the real
 * transport test, which drives it through a genuine `Bun.serve` (POD-3931).
 */
export class NativeGatewaySocket implements GatewaySocket {
  private readonly listeners = new Map<SocketEvent, SocketListener[]>()
  /** Set by {@link end}: nothing the client sends after it is handled. */
  private ended = false

  constructor(private readonly native: NativeServerWebSocket<SocketData>) {}

  get readyState(): number {
    return this.native.readyState
  }

  get bufferedAmount(): number {
    return this.native.getBufferedAmount()
  }

  send(data: string, compress = shouldCompressWebSocketFrame(data)): number {
    return this.native.sendText(data, compress)
  }

  /** The native `drain` for THIS socket, routed by the handler below. */
  onDrain(listener: () => void): () => void {
    this.on('drain', listener)
    return () => {
      const current = this.listeners.get('drain')
      if (!current) return
      const index = current.indexOf(listener)
      if (index !== -1) current.splice(index, 1)
    }
  }

  sendBinary(data: Uint8Array, compress = shouldCompressWebSocketFrame(data)): number {
    return this.native.sendBinary(data, compress)
  }

  ping(): void {
    this.native.ping()
  }

  terminate(): void {
    this.native.terminate()
  }

  /**
   * A closing handshake with a code the client can read, instead of a dropped
   * connection (POD-6910). Bun shuts the socket down after sending the close
   * frame; a frame the client sends meanwhile is not handled.
   */
  end(code: number, reason: string): void {
    this.ended = true
    this.native.close(code, reason)
  }

  on(event: 'message', listener: (raw: string | Buffer) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'pong', listener: () => void): this
  on(event: 'drain', listener: () => void): this
  on(event: SocketEvent, listener: SocketListener): this {
    const current = this.listeners.get(event)
    if (current) current.push(listener)
    else this.listeners.set(event, [listener])
    return this
  }

  emit(event: SocketEvent, ...args: unknown[]): void {
    if (this.ended && event === 'message') return
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]))
  }
}

/**
 * Build the native handler before Bun.serve starts. Per-message deflate is
 * negotiated once, while each send decides whether its frame is worth
 * compressing. The 3 KiB settings are Bun's smallest selectable compressor
 * and decompressor memory modes.
 */
export function attachWebSockets(
  registry: SessionRegistry,
  auth: WsAuthOptions = {},
  deps: WsTransportDeps = {},
): WsHandle {
  const clients = new Set<NativeGatewaySocket>()
  const daemons = new Set<NativeGatewaySocket>()
  const aliveClients = new WeakSet<HeartbeatSocket>()
  const aliveDaemons = new WeakSet<HeartbeatSocket>()
  const principalValidity = new Map<
    NativeGatewaySocket,
    {
      maintain: () => Promise<boolean>
      refreshedAt: number
      pending: boolean
      valid: boolean
    }
  >()
  const clientsByCredential = new Map<string, Set<NativeGatewaySocket>>()
  const now = deps.now ?? Date.now
  const maintainClientPrincipals = (): void => {
    for (const [socket, state] of principalValidity) {
      // A hung provider cannot keep a socket alive indefinitely or queue more work.
      if (!state.valid || now() - state.refreshedAt > CLIENT_CREDENTIAL_VALIDITY_MAX_AGE_MS) {
        state.valid = false
        socket.terminate()
        continue
      }
      if (state.pending) continue
      state.pending = true
      void Promise.resolve()
        .then(state.maintain)
        .then(
          (valid) => {
            if (principalValidity.get(socket) !== state || !state.valid) return
            state.valid = valid === true
            state.refreshedAt = now()
            if (!state.valid) socket.terminate()
          },
          () => {
            if (principalValidity.get(socket) !== state) return
            state.valid = false
            socket.terminate()
          },
        )
        .finally(() => {
          state.pending = false
        })
    }
  }

  const websocket: NativeWebSocketHandler<SocketData> = {
    data: {} as SocketData,
    perMessageDeflate: { compress: '3KB', decompress: '3KB' },
    maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
    // THE NATIVE LIMIT SITS ABOVE THE APPLICATION MARK, BY ONE FRAME (POD-3931).
    // The sender pauses on `-1` and whenever Bun's buffer is at the plane's
    // 16 MB mark, so its buffer can exceed the mark by at most one frame. Bun
    // returns 0 — and DROPS the frame — once its buffer passes this limit, so
    // the limit must leave room for that one frame or ordinary backpressure
    // reads as a fatal overflow. This is a safety net, not the mechanism.
    backpressureLimit: NATIVE_BACKPRESSURE_LIMIT_BYTES,
    closeOnBackpressureLimit: false,
    idleTimeout: 0,
    sendPings: false,
    open(native) {
      const socket = new NativeGatewaySocket(native)
      native.data.socket = socket
      if (native.data.kind === 'daemon' || native.data.kind === 'machine') {
        daemons.add(socket)
        aliveDaemons.add(socket)
        if (native.data.kind === 'machine') wireMachineSocket(socket, registry)
        else wireDaemonSocket(socket, registry, native.data.link)
        return
      }
      clients.add(socket)
      if (native.data.maintain) {
        principalValidity.set(socket, {
          maintain: native.data.maintain,
          refreshedAt: now(),
          pending: false,
          valid: true,
        })
      }
      if (native.data.credentialId) {
        const current = clientsByCredential.get(native.data.credentialId)
        if (current) current.add(socket)
        else clientsByCredential.set(native.data.credentialId, new Set([socket]))
      }
      aliveClients.add(socket)
      const id = wireClientSocket(socket, native.data.url, registry, {
        userId: native.data.userId,
        userRole: native.data.userRole,
      })
      if (id === undefined) {
        clients.delete(socket)
        principalValidity.delete(socket)
        if (native.data.credentialId) {
          const current = clientsByCredential.get(native.data.credentialId)
          current?.delete(socket)
          if (current?.size === 0) clientsByCredential.delete(native.data.credentialId)
        }
      }
    },
    message(native, message) {
      // THE I/O-COMPLETION SEAM [POD-1931]. Every inbound frame's handling runs
      // synchronously under this call, and it reaches JS without passing through
      // any scheduler — so neither the statement counters nor the patched timers
      // could see it. Measured before this line existed: 62% of blocked event
      // loop was own-CPU that no instrument could name, and this is the only
      // door that much CPU can come through. Split client from daemon because
      // they carry completely different traffic (RPC vs PTY frames) and the
      // answer "which one" is the first thing the number has to settle.
      measureTask(`ws.message.${native.data.kind ?? 'unknown'}`, () =>
        native.data.socket?.emit('message', message),
      )
    },
    drain(native) {
      native.data.socket?.emit('drain')
    },
    pong(native) {
      const socket = native.data.socket
      if (!socket) return
      if (native.data.kind === 'daemon' || native.data.kind === 'machine') {
        aliveDaemons.add(socket)
      } else {
        aliveClients.add(socket)
      }
      socket.emit('pong')
    },
    close(native) {
      const socket = native.data.socket
      if (!socket) return
      clients.delete(socket)
      principalValidity.delete(socket)
      daemons.delete(socket)
      if (native.data.credentialId) {
        const current = clientsByCredential.get(native.data.credentialId)
        current?.delete(socket)
        if (current?.size === 0) clientsByCredential.delete(native.data.credentialId)
      }
      socket.emit('close')
    },
  }

  const clientHeartbeat = CLIENT_PLANE_LIVENESS.startHeartbeat(
    clients,
    aliveClients,
    deps.timers,
    maintainClientPrincipals,
  )
  const daemonHeartbeat = DAEMON_PLANE_LIVENESS.startHeartbeat(daemons, aliveDaemons, deps.timers)

  return {
    websocket,
    async handleRequest(request, server) {
      const url = new URL(request.url)
      // The decoded path, as the workspace edge and Hono read it, so the
      // socket paths and the edge's rows cannot disagree (POD-7309).
      const pathname = routedPath(request)
      if (pathname !== '/client' && pathname !== '/daemon' && pathname !== '/machine') return null

      const rawVersion = url.searchParams.get('v') ?? url.searchParams.get('pv')
      const support =
        pathname === '/client'
          ? { wire: CLIENT_WIRE_VERSION, min: MIN_CLIENT_WIRE_VERSION }
          : { wire: DAEMON_WIRE_VERSION, min: MIN_DAEMON_WIRE_VERSION }
      const offered = {
        min: Number(url.searchParams.get('vmin') ?? rawVersion),
        max: Number(rawVersion),
      }
      if (
        rawVersion !== null &&
        (!WireVersionOffer.safeParse(offered).success || !negotiateVersion(offered, support).ok)
      ) {
        return new Response('Upgrade Required', { status: 426 })
      }
      // Capabilities must be advertised before upgrade as well as in hello:
      // an HTTP 426 cannot be sent once the WebSocket has been accepted.
      if (pathname === '/client' && !url.searchParams.getAll('cap').includes(CAP_SYNC_HTTP_V1)) {
        return new Response('Upgrade Required: sync.http.v1', { status: 426 })
      }
      const origin = request.headers.get('origin')
      const originHost = request.headers.get('host')
      const originVerdict = wsOriginVerdict(origin, originHost, deps.allowedOrigins)
      if (originVerdict !== 'allowed') {
        deps.onOriginRefused?.({
          origin: origin ?? undefined,
          host: originHost ?? undefined,
          reason: originVerdict,
        })
        return new Response('Forbidden', {
          status: 403,
          headers: { connection: 'close' },
        })
      }

      // Bound before the credential is read: a daemon's handshake is checked
      // against this registry's machine rows, a client's member against its
      // memberships, so the registry must be the bound workspace's.
      let workspaceId: WorkspaceId | undefined
      if (auth.bindWorkspace) {
        const binding = await auth.bindWorkspace(request)
        if ('refused' in binding) {
          return new Response(JSON.stringify(binding.refused.body), {
            status: binding.refused.status,
            headers: { connection: 'close', 'content-type': 'application/json' },
          })
        }
        if (binding.workspaceId !== registry.sessionStore.workspaceId) {
          return new Response(JSON.stringify({ error: 'workspace_not_served' }), {
            status: 404,
            headers: { connection: 'close', 'content-type': 'application/json' },
          })
        }
        workspaceId = binding.workspaceId
      }

      let data: SocketData
      if (pathname === '/client') {
        const readiness = auth.readinessForClient?.()
        if (readiness?.dataPlane === 'blocked') {
          return new Response(JSON.stringify({ error: 'server_not_ready', readiness }), {
            status: 503,
            headers: { connection: 'close', 'content-type': 'application/json' },
          })
        }
        const answer = await auth.principalForClient?.(request)
        if (answer && 'refused' in answer) {
          return new Response(JSON.stringify(answer.refused.body), {
            status: answer.refused.status,
            headers: { connection: 'close', 'content-type': 'application/json' },
          })
        }
        const resolved = answer
        const userId = resolved?.userId ?? auth.userForClient?.(request)
        const userRole = resolved?.userRole ?? auth.roleForClient?.(request)
        if (
          (auth.principalForClient && resolved === undefined) ||
          (auth.userForClient && userId === undefined) ||
          (auth.roleForClient && userRole === undefined) ||
          (auth.authorizeClient && !auth.authorizeClient(request)) ||
          // THE MEMBER FENCE (POD-6292, MU-12): a client opened for one member
          // never opens a socket with another member's cookie.
          memberFenceRefuses(fencedMemberOf(request), userId)
        ) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { connection: 'close' },
          })
        }
        data = {
          kind: 'client',
          url: request.url,
          ...(workspaceId ? { workspaceId } : {}),
          userId,
          userRole,
          ...(resolved?.maintain ? { maintain: resolved.maintain } : {}),
          ...(resolved?.credentialId ? { credentialId: resolved.credentialId } : {}),
        }
      } else {
        const link = deps.daemonLink?.(request)
        // Judged with the bound workspace's trusted networks as they are now.
        if (link !== undefined && (await registry.daemonLinks.kindOf(link)) === 'plain') {
          // LEGACY(remove-after: 2027-02): accepts a plain ws daemon connection from another computer so local-network installs survive the upgrade; removing it refuses such a daemon at connect
          const accepted = deps.acceptPlainDaemonLinks ?? ACCEPT_PLAIN_DAEMON_LINKS
          if (!accepted) {
            return new Response(PLAIN_DAEMON_LINK_REFUSAL, {
              status: 403,
              headers: { connection: 'close', 'content-type': 'text/plain; charset=utf-8' },
            })
          }
          log.warn('accepted a daemon connection that is not encrypted', {
            path: pathname,
            clientAddress: link.clientAddress,
          })
        }
        data = {
          kind: pathname === '/machine' ? 'machine' : 'daemon',
          url: request.url,
          ...(workspaceId ? { workspaceId } : {}),
          ...(link !== undefined ? { link } : {}),
        }
      }

      return server.upgrade(request, { data })
        ? undefined
        : new Response('WebSocket upgrade failed', { status: 400 })
    },
    revokeClientCredential(credentialId) {
      const sockets = clientsByCredential.get(credentialId)
      if (!sockets) return
      // The client reads the code to say "signed out on this device".
      const { code, reason } = SIGN_IN_ENDED_CLOSE.signedOut
      for (const socket of sockets) socket.end(code, reason)
      clientsByCredential.delete(credentialId)
    },
    async close() {
      clientHeartbeat.stop()
      daemonHeartbeat.stop()
      for (const socket of clients) socket.terminate()
      for (const socket of daemons) socket.terminate()
      clients.clear()
      daemons.clear()
      clientsByCredential.clear()
      principalValidity.clear()
    },
  }
}
