import {
  createSocketLogin,
  socketLoginOptions,
  type SocketConstructor,
} from '@podium/client-core/live-connection'

let activeOrigin: string | null = null
let activeBearer: string | null = null
let installed = false
let originalSocket: SocketConstructor | undefined

export function configureNativeWebSocketCredential(
  origin: string | null,
  bearer: string | null,
): void {
  activeOrigin = origin
  activeBearer = bearer
}

/**
 * React Native's WebSocket accepts native request headers as its third argument,
 * while the browser constructor intentionally does not. Client-core owns socket
 * lifecycle but constructs the ambient WebSocket, so this narrowly decorates
 * only `/client` sockets for the currently selected server.
 */
export function installNativeWebSocketAuthentication(): void {
  if (installed || typeof globalThis.WebSocket !== 'function') return
  installed = true
  const NativeWebSocket = globalThis.WebSocket as unknown as new (...args: any[]) => WebSocket
  originalSocket = NativeWebSocket as unknown as SocketConstructor
  class AuthenticatedWebSocket extends (NativeWebSocket as any) {
    constructor(
      url: string | URL,
      protocols?: string | string[],
      options?: { headers?: Record<string, string>; [key: string]: unknown },
    ) {
      const raw = String(url)
      super(raw, protocols, socketLoginOptions(raw, activeOrigin, activeBearer, options))
    }
  }
  globalThis.WebSocket = AuthenticatedWebSocket as unknown as typeof WebSocket
}

/** The shared runtime bypasses the transitional ambient decorator and closes
 * over this principal's released credential. */
export function makePlatformSocketLogin(options: Parameters<typeof createSocketLogin>[0]) {
  return createSocketLogin({
    ...options,
    Socket:
      options.Socket ?? originalSocket ?? (globalThis.WebSocket as unknown as SocketConstructor),
  })
}
