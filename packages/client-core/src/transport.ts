import { WIRE_VERSION } from '@podium/protocol'

/** Relay endpoints parsed from a `ws://`/`wss://`/HTTP(S) origin. */
export type ServerOrigin = {
  wsClientUrl: string
  httpOrigin: string
}

export interface ServerConfig extends ServerOrigin {
  /** true when resolved from an explicit override rather than the page origin. */
  override: boolean
}

export interface LocationLike {
  protocol: string
  host: string
  origin: string
  search: string
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

  // Accept ws/wss AND http/https. The Machines tab + daemon hand out an HTTPS URL,
  // but browser WebSocket endpoints still need ws/wss.
  const secure = url.protocol === 'wss:' || url.protocol === 'https:'
  if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') return null

  // Preserve an explicit default port, because URL normalizes it away.
  const rawPortMatch = server.match(/^(?:wss?|https?):\/\/[^/:]+:(\d+)/)
  const explicitPort = rawPortMatch ? rawPortMatch[1] : url.port || ''
  const hostWithPort = explicitPort ? `${url.hostname}:${explicitPort}` : url.hostname
  const wsProto = secure ? 'wss:' : 'ws:'
  const httpProto = secure ? 'https:' : 'http:'
  return {
    wsClientUrl: `${wsProto}//${hostWithPort}/client?v=${WIRE_VERSION}`,
    httpOrigin: `${httpProto}//${hostWithPort}`,
  }
}

export function resolveServerConfig(loc: LocationLike, injected?: string): ServerConfig {
  const fromInjected = injected ? parseServerOrigin(injected) : null
  if (fromInjected) return { ...fromInjected, override: true }
  const parsed = parseServer(loc.search)
  if (parsed) return { ...parsed, override: true }
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return {
    wsClientUrl: `${wsProto}//${loc.host}/client?v=${WIRE_VERSION}`,
    httpOrigin: loc.origin,
    override: false,
  }
}
