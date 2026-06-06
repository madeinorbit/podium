import type { AppRouter } from '@podium/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

export type Trpc = ReturnType<typeof createTRPCClient<AppRouter>>

/** Relay endpoints parsed from a `ws://`/`wss://` origin. */
export type ServerOrigin = {
  wsClientUrl: string
  httpOrigin: string
}

export interface ServerConfig extends ServerOrigin {
  /** true when resolved from an explicit `?server=` override rather than the page origin. */
  override: boolean
}

/** Parse `?server=ws://host:port` into the ws client URL + the http origin for tRPC. */
export function parseServer(search: string): ServerOrigin | null {
  const server = new URLSearchParams(search).get('server')
  return server ? parseServerOrigin(server) : null
}

export function parseServerOrigin(server: string): ServerOrigin | null {
  let url: URL
  try {
    url = new URL(server)
  } catch {
    return null
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null

  const wsBase = url.toString().replace(/\/$/, '')
  const http = new URL(wsBase)
  http.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  const httpOrigin = http.toString().replace(/\/$/, '')
  return { wsClientUrl: `${wsBase}/client`, httpOrigin }
}

/**
 * Resolve relay endpoints. Honors an explicit `?server=ws://host:port`; otherwise derives
 * same-origin URLs from `window.location` (the dev server proxies `/client` + `/trpc` to the
 * backend), so hitting the host on its own port connects with no query param.
 */
export function serverConfig(loc: Location): ServerConfig {
  const parsed = parseServer(loc.search)
  if (parsed) return { ...parsed, override: true }
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return { wsClientUrl: `${wsProto}//${loc.host}/client`, httpOrigin: loc.origin, override: false }
}

export function makeTrpc(httpOrigin: string): Trpc {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${httpOrigin}/trpc` })] })
}
