import {
  parseServer,
  parseServerOrigin,
  resolveServerConfig,
  type ServerConfig,
  type ServerOrigin,
} from '@podium/client-core/transport'
import { createLogger } from '@podium/logger'
import type { AppRouter } from '@podium/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

export type { ServerConfig, ServerOrigin }
export { parseServer, parseServerOrigin }
export type Trpc = ReturnType<typeof createTRPCClient<AppRouter>>

const log = createLogger('web:trpc')

/**
 * Resolve relay endpoints. Honors injected or explicit backend overrides;
 * otherwise derives same-origin URLs from window.location.
 */
export function serverConfig(loc: Location): ServerConfig {
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
  return resolveServerConfig(loc, injected)
}

/**
 * The procedures a batched tRPC URL carried — `issues.markRead`, or
 * `updates.fleet,quota.summary` for a batch of two.
 *
 * The whole point of the record this names is that an operator reading a log
 * file can tell WHICH call failed, so an unparseable URL degrades to the raw
 * string rather than to nothing: a slightly ugly field beats a record that
 * says only "a call failed".
 */
export function trpcProcedurePath(url: string): string {
  try {
    const { pathname } = new URL(url)
    const after = pathname.split('/trpc/')[1]
    return after && after !== '' ? decodeURIComponent(after) : pathname
  } catch {
    return url
  }
}

export interface ReportingFetchOptions {
  /** Log failures at `warn`. OFF for the log transport's own client. */
  report?: boolean
}

/**
 * `fetch` for a tRPC link, WITH THE FAILURE WRITTEN DOWN (POD-1935).
 *
 * Every tRPC failure used to reach the browser console and nothing else, so a
 * client that spent twenty minutes taking 500s forwarded nothing and left its
 * per-origin log file uncreated — the transport was healthy and had nothing to
 * carry. `warn` is the level deliberately: it is the client default threshold,
 * so these records forward without an operator having to raise anything first.
 *
 * `logs.*` IS NEVER REPORTED, whatever the caller asked for. A failed
 * `logs.forward` that produced a record would queue that record on the sink
 * whose send just failed, and each retry would mint another — logging about
 * logging, amplifying exactly when the server is already down. The log
 * transport builds its client with `report: false` for the same reason; the
 * path check is what makes the loop unconstructable rather than merely avoided.
 */
export function reportingFetch(
  base: typeof fetch = fetch,
  options: ReportingFetchOptions = {},
): typeof fetch {
  const report = options.report ?? true
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = trpcProcedurePath(url)
    const reportable = report && !path.split(',').some((name) => name.startsWith('logs.'))
    try {
      // Send the login session cookie with every tRPC call. Same-origin already does this
      // by default; being explicit keeps it working if the client is ever cross-origin.
      const response = await base(input, { ...init, credentials: 'include' })
      if (reportable && !response.ok) {
        log.warn('trpc call failed', { path, status: response.status })
      }
      return response
    } catch (err) {
      // A network-layer failure: the server is unreachable, the page is
      // offline, or the request was aborted. Recorded and RETHROWN — the
      // caller's error handling is unchanged by being observed.
      if (reportable) log.warn('trpc call could not be sent', { path, err })
      throw err
    }
  }
}

export interface MakeTrpcOptions extends ReportingFetchOptions {}

export function makeTrpc(httpOrigin: string, options: MakeTrpcOptions = {}): Trpc {
  // The login session (podium_session cookie) is the operator's authentication; the tracker
  // grants full authority to any authenticated /trpc caller (no separate issue credential).
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${httpOrigin}/trpc`,
        fetch: reportingFetch(fetch, options),
      }),
    ],
  })
}
