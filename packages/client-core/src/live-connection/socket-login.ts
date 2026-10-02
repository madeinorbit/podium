import type { AccountCredentials } from '../accounts/storage'
import type { SocketHubOptions, WebSocketLike } from '../socket-transport'

export interface NativeSocketOptions {
  headers?: Record<string, string>
  [key: string]: unknown
}
export type SocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: NativeSocketOptions,
) => WebSocketLike

/** A bearer belongs to one HTTP authority's /client endpoint, including scheme.
 * Keep this check shared with the transitional native constructor decorator. */
export function socketLoginOptions(
  url: string,
  httpOrigin: string | null,
  bearer: string | null,
  options?: NativeSocketOptions,
): NativeSocketOptions | undefined {
  if (!bearer || !httpOrigin) return options
  let matches = false
  try {
    const socket = new URL(url)
    const origin = new URL(httpOrigin)
    matches =
      socket.protocol === (origin.protocol === 'https:' ? 'wss:' : 'ws:') &&
      socket.pathname === '/client' &&
      socket.hostname === origin.hostname &&
      socket.port === origin.port
  } catch {
    /* Invalid URLs never receive a credential. */
  }
  return matches
    ? { ...options, headers: { ...options?.headers, Authorization: `Bearer ${bearer}` } }
    : options
}

/** Consume the account owner's storage policy and already-released credential.
 * Socket construction is synchronous; it must never read or release a keychain
 * credential itself. Each runtime closes over its own owner, not ambient state. */
export function createSocketLogin(options: {
  credentials: AccountCredentials
  httpOrigin: string
  bearer: () => string | null
  Socket?: SocketConstructor
}): NonNullable<SocketHubOptions['makeSocket']> {
  return (url) => {
    const Socket = options.Socket ?? (globalThis.WebSocket as unknown as SocketConstructor)
    if (options.credentials.delivery === 'browser') return new Socket(url)
    return new Socket(url, undefined, socketLoginOptions(url, options.httpOrigin, options.bearer()))
  }
}
