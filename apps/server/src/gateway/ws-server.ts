/**
 * Bun-native WebSocket upgrade boundary.
 *
 * Bun intercepts `ws`, but its compatibility WebSocketServer does not negotiate
 * permessage-deflate. This boundary therefore uses Bun.serve's native server
 * sockets and adapts them to the small evented socket interface used by the
 * gateway's already-tested client and daemon protocol layers.
 */

import type { ServerReadiness, UserId, UserRole } from '@podium/model'
import { versionSupport } from '@podium/protocol'
import { measureTask } from '@podium/runtime/task-attribution'

export interface NativeServer<T> {
  readonly port: number
  upgrade(request: Request, options: { data: T }): boolean
  requestIP?(request: Request): { address: string } | null
  stop(closeActiveConnections?: boolean): void | Promise<void>
  requestIP(request: Request): { address: string; port: number; family: string } | null
}

interface NativeServerWebSocket<T> {
  data: T
  readonly readyState: number
  getBufferedAmount(): number
  sendText(data: string, compress?: boolean): number
  ping(): number
  terminate(): void
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
  close(socket: NativeServerWebSocket<T>): void
}

export interface NativeServeOptions<T> {
  port: number
  hostname: string
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
import { wireClientSocket } from './client-socket'
import { wireDaemonSocket } from './daemon-socket'
import {
  CLIENT_PLANE_LIVENESS,
  DAEMON_PLANE_LIVENESS,
  type HeartbeatSocket,
  type SweepTimers,
} from './plane-liveness'
import { type GatewaySocket, shouldCompressWebSocketFrame, WS_MAX_PAYLOAD_BYTES } from './ws-send'

export interface WsHandle {
  handleRequest(request: Request, server: NativeServer<SocketData>): Response | null | undefined
  websocket: NativeWebSocketHandler<SocketData>
  revokeClientCredential(credentialId: string): void
  close(): Promise<void>
}

export interface WsAuthOptions {
  readinessForClient?: () => ServerReadiness
  authorizeClient?: (request: Request) => boolean
  userForClient?: (request: Request) => UserId | undefined
  roleForClient?: (request: Request) => UserRole | undefined
  principalForClient?: (request: Request) =>
    | {
        userId: UserId
        userRole: UserRole
        credentialId?: string
      }
    | undefined
  validateClientCredential?: (credentialId: string) => boolean
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function hostHeaderName(host: string | null | undefined): string | undefined {
  if (!host) return undefined
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

/** Cross-site WebSocket-hijacking defense shared by both socket planes. */
export function isAllowedWsOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
): boolean {
  if (!origin) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol === 'tauri:') return true
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return true
  const reqHost = hostHeaderName(host)
  if (LOOPBACK_HOSTS.has(reqHost ?? '')) return true
  return Boolean(reqHost) && parsed.hostname === reqHost
}

export interface WsTransportDeps {
  timers?: SweepTimers
}

interface SocketData {
  kind: 'client' | 'daemon'
  url: string
  userId?: UserId
  userRole?: UserRole
  credentialId?: string
  socket?: NativeGatewaySocket
}

type SocketEvent = 'message' | 'close' | 'pong'
type SocketListener = (...args: never[]) => void

class NativeGatewaySocket implements GatewaySocket {
  private readonly listeners = new Map<SocketEvent, SocketListener[]>()

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

  ping(): void {
    this.native.ping()
  }

  terminate(): void {
    this.native.terminate()
  }

  on(event: 'message', listener: (raw: string | Buffer) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'pong', listener: () => void): this
  on(event: SocketEvent, listener: SocketListener): this {
    const current = this.listeners.get(event)
    if (current) current.push(listener)
    else this.listeners.set(event, [listener])
    return this
  }

  emit(event: SocketEvent, ...args: unknown[]): void {
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
  const clientsByCredential = new Map<string, Set<NativeGatewaySocket>>()

  const websocket: NativeWebSocketHandler<SocketData> = {
    data: {} as SocketData,
    perMessageDeflate: { compress: '3KB', decompress: '3KB' },
    maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
    backpressureLimit: CLIENT_PLANE_LIVENESS.sendBufferLimitBytes,
    closeOnBackpressureLimit: false,
    idleTimeout: 0,
    sendPings: false,
    open(native) {
      const socket = new NativeGatewaySocket(native)
      native.data.socket = socket
      if (native.data.kind === 'daemon') {
        daemons.add(socket)
        aliveDaemons.add(socket)
        wireDaemonSocket(socket, registry)
        return
      }
      clients.add(socket)
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
    pong(native) {
      const socket = native.data.socket
      if (!socket) return
      if (native.data.kind === 'daemon') {
        aliveDaemons.add(socket)
      } else {
        if (
          native.data.credentialId &&
          auth.validateClientCredential &&
          !auth.validateClientCredential(native.data.credentialId)
        ) {
          native.terminate()
          return
        }
        aliveClients.add(socket)
      }
      socket.emit('pong')
    },
    close(native) {
      const socket = native.data.socket
      if (!socket) return
      clients.delete(socket)
      daemons.delete(socket)
      if (native.data.credentialId) {
        const current = clientsByCredential.get(native.data.credentialId)
        current?.delete(socket)
        if (current?.size === 0) clientsByCredential.delete(native.data.credentialId)
      }
      socket.emit('close')
    },
  }

  const clientHeartbeat = CLIENT_PLANE_LIVENESS.startHeartbeat(clients, aliveClients, deps.timers)
  const daemonHeartbeat = DAEMON_PLANE_LIVENESS.startHeartbeat(daemons, aliveDaemons, deps.timers)

  return {
    websocket,
    handleRequest(request, server) {
      const url = new URL(request.url)
      const pathname = url.pathname
      if (pathname !== '/client' && pathname !== '/daemon') return null

      const rawVersion = url.searchParams.get('v') ?? url.searchParams.get('pv')
      if (rawVersion !== null && versionSupport(Number(rawVersion)) !== 'ok') {
        return new Response('Upgrade Required', { status: 426 })
      }
      if (!isAllowedWsOrigin(request.headers.get('origin'), request.headers.get('host'))) {
        return new Response('Forbidden', {
          status: 403,
          headers: { connection: 'close' },
        })
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
        const resolved = auth.principalForClient?.(request)
        const userId = resolved?.userId ?? auth.userForClient?.(request)
        const userRole = resolved?.userRole ?? auth.roleForClient?.(request)
        if (
          (auth.principalForClient && resolved === undefined) ||
          (auth.userForClient && userId === undefined) ||
          (auth.roleForClient && userRole === undefined) ||
          (auth.authorizeClient && !auth.authorizeClient(request))
        ) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { connection: 'close' },
          })
        }
        data = {
          kind: 'client',
          url: request.url,
          userId,
          userRole,
          ...(resolved?.credentialId ? { credentialId: resolved.credentialId } : {}),
        }
      } else {
        data = { kind: 'daemon', url: request.url }
      }

      return server.upgrade(request, { data })
        ? undefined
        : new Response('WebSocket upgrade failed', { status: 400 })
    },
    revokeClientCredential(credentialId) {
      const sockets = clientsByCredential.get(credentialId)
      if (!sockets) return
      for (const socket of sockets) socket.terminate()
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
    },
  }
}
