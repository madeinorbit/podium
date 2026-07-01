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

  // Accept ws/wss AND http/https. The Machines tab + `npx @podium/daemon --server …` hand out
  // an https:// URL, and the daemon's Node `ws` client normalises https→wss transparently — but
  // the browser's WebSocket only speaks ws/wss, so an https:// URL injected as __PODIUM_SERVER__
  // would otherwise be rejected here and silently fall back to same-origin (a frozen desktop).
  const secure = url.protocol === 'wss:' || url.protocol === 'https:'
  if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') return null

  // Preserve the explicit port even when it matches the protocol default (URL API normalises it away).
  // Extract any port from the original string (e.g. wss://host:443 → ":443").
  const rawPortMatch = server.match(/^(?:wss?|https?):\/\/[^/:]+:(\d+)/)
  const explicitPort = rawPortMatch ? rawPortMatch[1] : url.port || ''
  const hostWithPort = explicitPort ? `${url.hostname}:${explicitPort}` : url.hostname
  const wsProto = secure ? 'wss:' : 'ws:'
  const httpProto = secure ? 'https:' : 'http:'
  const wsBase = `${wsProto}//${hostWithPort}`
  const httpOrigin = `${httpProto}//${hostWithPort}`
  return { wsClientUrl: `${wsBase}/client`, httpOrigin }
}

/**
 * Resolve relay endpoints. Honors an explicit `?server=ws://host:port`; otherwise derives
 * same-origin URLs from `window.location` (the dev server proxies `/client` + `/trpc` to the
 * backend), so hitting the host on its own port connects with no query param.
 */
export function serverConfig(loc: Location): ServerConfig {
  // 1. Backend injected by the Tauri shell / headless setup (a ws://|wss:// URL).
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
  const fromInjected = injected ? parseServerOrigin(injected) : null
  if (fromInjected) return { ...fromInjected, override: true }
  // 2. Explicit ?server= override.
  const parsed = parseServer(loc.search)
  if (parsed) return { ...parsed, override: true }
  // 3. Same-origin derived from window.location.
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return { wsClientUrl: `${wsProto}//${loc.host}/client`, httpOrigin: loc.origin, override: false }
}

/** Auth header the web client sends so the role gate (P3b) treats the operator's
 *  browser as maintainer. Name MUST match the server's createContext header read. */
export function issueAuthHeaders(): Record<string, string> {
  const token = (globalThis as { __PODIUM_ISSUE_TOKEN__?: string }).__PODIUM_ISSUE_TOKEN__
  return token ? { 'x-podium-issue-token': token } : {}
}

export function makeTrpc(httpOrigin: string): Trpc {
  const trpc = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${httpOrigin}/trpc`,
        headers: issueAuthHeaders,
        // Send the login session cookie with every tRPC call. Same-origin already does this
        // by default; being explicit keeps it working if the client is ever cross-origin.
        fetch: (url, opts) => fetch(url, { ...opts, credentials: 'include' }),
      }),
    ],
  })
  // Present the maintainer token so the P3b role gate grants maintainer instead of falling
  // back to read-only (see resolveRole). The server injects it into index.html, but the live
  // web is served by Vite preview and cached by the PWA service worker, so that injection
  // never reaches the browser — fetch it at runtime and stash it in the global that
  // issueAuthHeaders reads (only when unset, so a fresh server-served injection still wins).
  // Best-effort: a reader can still browse if this fails.
  void trpc.issueToken
    .query()
    .then((token) => {
      const g = globalThis as { __PODIUM_ISSUE_TOKEN__?: string }
      if (token && !g.__PODIUM_ISSUE_TOKEN__) g.__PODIUM_ISSUE_TOKEN__ = token
    })
    .catch(() => {})
  return trpc
}
