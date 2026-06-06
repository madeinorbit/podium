import type { AppRouter } from '@podium/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

export type Trpc = ReturnType<typeof createTRPCClient<AppRouter>>

/** Parse `?server=ws://host:port` into the ws client URL + the http origin for tRPC. */
export function parseServer(search: string): { wsClientUrl: string; httpOrigin: string } | null {
  const server = new URLSearchParams(search).get('server')
  if (!server) return null
  return { wsClientUrl: `${server}/client`, httpOrigin: server.replace(/^ws/, 'http') }
}

export interface ServerConfig {
  wsClientUrl: string
  httpOrigin: string
  /** true when resolved from an explicit `?server=` override rather than the page origin. */
  override: boolean
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
