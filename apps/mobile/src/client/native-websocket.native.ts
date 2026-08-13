let activeOrigin: string | null = null
let activeBearer: string | null = null
let installed = false

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
  class AuthenticatedWebSocket extends (NativeWebSocket as any) {
    constructor(
      url: string | URL,
      protocols?: string | string[],
      options?: { headers?: Record<string, string>; [key: string]: unknown },
    ) {
      const raw = String(url)
      let matches = false
      try {
        const socketUrl = new URL(raw)
        const origin = new URL(activeOrigin ?? 'http://invalid.local')
        const expectedScheme = origin.protocol === 'https:' ? 'wss:' : 'ws:'
        matches =
          socketUrl.protocol === expectedScheme &&
          socketUrl.pathname === '/client' &&
          socketUrl.hostname === origin.hostname &&
          socketUrl.port === origin.port
      } catch {
        matches = false
      }
      if (matches && activeBearer) {
        super(raw, protocols, {
          ...options,
          headers: { ...options?.headers, Authorization: `Bearer ${activeBearer}` },
        })
      } else {
        super(raw, protocols, options)
      }
    }
  }
  globalThis.WebSocket = AuthenticatedWebSocket as unknown as typeof WebSocket
}
