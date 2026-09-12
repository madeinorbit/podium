import { WIRE_VERSION } from '@podium/protocol'

/** Relay endpoints parsed from a `ws://`/`wss://`/HTTP(S) origin. */
export type ServerOrigin = {
  wsClientUrl: string
  httpOrigin: string
  workspaceId?: string
  workspaceSlug?: string
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
  pathname?: string
}

/** Parse `?server=ws://host:port` into the ws client URL + the http origin for tRPC. */
export function parseServer(search: string, selected?: WorkspaceSelector): ServerOrigin | null {
  const server = new URLSearchParams(search).get('server')
  return server ? parseServerOrigin(server, selected) : null
}

export function parseServerOrigin(server: string, selected?: WorkspaceSelector): ServerOrigin | null {
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
  const selector = selected ?? selectorFromUrl(url)
  const workspace = selectorValue(selector)
  const wsUrl = new URL(`${wsProto}//${hostWithPort}/client?v=${WIRE_VERSION}`)
  if (workspace) wsUrl.searchParams.set('workspace', workspace)
  return {
    wsClientUrl: wsUrl.href,
    httpOrigin: `${httpProto}//${hostWithPort}`,
    ...(selector.workspaceId ? { workspaceId: selector.workspaceId } : {}),
    ...(selector.workspaceSlug ? { workspaceSlug: selector.workspaceSlug } : {}),
  }
}

export function resolveServerConfig(loc: LocationLike, injected?: string): ServerConfig {
  const selected = workspaceSelectorFromLocation(loc)
  const fromInjected = injected ? parseServerOrigin(injected, selected) : null
  if (fromInjected) return { ...fromInjected, override: true }
  const parsed = parseServer(loc.search, selected)
  if (parsed) return { ...parsed, override: true }
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  const workspace = selectorValue(selected)
  const wsUrl = new URL(`${wsProto}//${loc.host}/client?v=${WIRE_VERSION}`)
  if (workspace) wsUrl.searchParams.set('workspace', workspace)
  return {
    wsClientUrl: wsUrl.href,
    httpOrigin: loc.origin,
    ...(selected.workspaceId ? { workspaceId: selected.workspaceId } : {}),
    ...(selected.workspaceSlug ? { workspaceSlug: selected.workspaceSlug } : {}),
    override: false,
  }
}

export interface WorkspaceSelector {
  workspaceId?: string
  workspaceSlug?: string
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function selectorFromUrl(url: URL): WorkspaceSelector {
  const explicitId = nonEmpty(url.searchParams.get('workspaceId'))
  if (explicitId) return { workspaceId: explicitId }
  const selected = nonEmpty(url.searchParams.get('workspace'))
  if (selected) {
    return selected.startsWith('ws_') ? { workspaceId: selected } : { workspaceSlug: selected }
  }
  const match = url.pathname.match(/^\/w\/([^/]+)/)
  if (!match?.[1]) return {}
  try {
    const slug = decodeURIComponent(match[1])
    return slug ? { workspaceSlug: slug } : {}
  } catch {
    return {}
  }
}

/** Resolve the selected workspace from either a mobile query or a web route. */
export function workspaceSelectorFromLocation(loc: LocationLike): WorkspaceSelector {
  const url = new URL(loc.origin + (loc.pathname ?? '/') + loc.search)
  return selectorFromUrl(url)
}

function selectorValue(selector: WorkspaceSelector): string | undefined {
  return nonEmpty(selector.workspaceId) ?? nonEmpty(selector.workspaceSlug)
}

/** Add the workspace selector without dropping existing input headers or query. */
export function workspaceRequestInit(
  input: RequestInfo | URL,
  init?: RequestInit,
  selector?: WorkspaceSelector,
): RequestInit | undefined {
  const target = selector ?? (() => {
    const location = (globalThis as { location?: LocationLike }).location
    return location ? workspaceSelectorFromLocation(location) : {}
  })()
  const value = selectorValue(target)
  if (!value) return init
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  )
  headers.set(target.workspaceId ? 'Podium-Workspace-Id' : 'Podium-Workspace', value)
  return { ...init, headers }
}

/** Put the selector on a WebSocket URL while preserving every existing query parameter. */
export function workspaceSocketUrl(url: string, selector: WorkspaceSelector = {}): string {
  const value = selectorValue(selector)
  if (!value) return url
  const endpoint = new URL(url)
  endpoint.searchParams.set('workspace', value)
  return endpoint.href
}
