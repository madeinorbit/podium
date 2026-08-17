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

export const SERVER_UNAVAILABLE_MESSAGE = 'The server is briefly unavailable.'

/**
 * A fetch-level failure with copy that is safe to surface through tRPC.
 *
 * The marker is for code and tests; `name` deliberately stays the ordinary
 * `Error` so a stack line cannot introduce another technical label into UI.
 */
export class ServerUnavailableError extends Error {
  readonly code = 'SERVER_UNAVAILABLE' as const

  constructor(cause?: unknown) {
    super(SERVER_UNAVAILABLE_MESSAGE, cause === undefined ? undefined : { cause })
  }
}

/** Roughly 32 seconds: long enough for the systemd service swap and boot. */
const DEFAULT_RECOVERY_DELAYS_MS = [
  100, 250, 500, 1_000, 2_000, 3_000, 5_000, 5_000, 5_000, 5_000, 5_000,
]

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
  /** Readiness retry schedule. Overridden with zero-delay entries by focused tests. */
  recoveryDelaysMs?: readonly number[]
}

function requestMethod(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase()
  return 'GET'
}

function requestSignal(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): AbortSignal | undefined {
  if (init?.signal) return init.signal
  if (typeof Request !== 'undefined' && input instanceof Request) return input.signal
  return undefined
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError')
  )
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error('The request was canceled.')
  error.name = 'AbortError'
  return error
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const done = (): void => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    const timer = setTimeout(done, Math.max(0, delayMs))
    const aborted = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(signal ? abortReason(signal) : new Error('The request was canceled.'))
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

async function requireJsonResponse(response: Response): Promise<Response> {
  try {
    const text = await response.clone().text()
    JSON.parse(text)
    return response
  } catch (error) {
    throw new ServerUnavailableError(error)
  }
}

async function waitForServer(
  base: typeof fetch,
  requestUrl: string,
  delaysMs: readonly number[],
  signal?: AbortSignal,
): Promise<void> {
  const readinessUrl = new URL('/readiness', requestUrl).href
  let lastError: unknown
  for (const delayMs of delaysMs) {
    await wait(delayMs, signal)
    try {
      const response = await base(readinessUrl, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        ...(signal ? { signal } : {}),
      })
      if (!response.ok) continue
      JSON.parse(await response.text())
      return
    } catch (error) {
      if (isAbort(error, signal)) throw error
      lastError = error
    }
  }
  throw new ServerUnavailableError(lastError)
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
  const recoveryDelaysMs = options.recoveryDelaysMs ?? DEFAULT_RECOVERY_DELAYS_MS
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = trpcProcedurePath(url)
    const reportable = report && !path.split(',').some((name) => name.startsWith('logs.'))
    const method = requestMethod(input, init)
    const signal = requestSignal(input, init)
    const request = async (): Promise<Response> => {
      let response: Response
      try {
        // Send the login session cookie with every tRPC call. Same-origin already does this
        // by default; being explicit keeps it working if the client is ever cross-origin.
        response = await base(input, { ...init, credentials: 'include' })
      } catch (error) {
        if (isAbort(error, signal)) throw error
        throw new ServerUnavailableError(error)
      }
      if (reportable && !response.ok) {
        log.warn('trpc call failed', { path, status: response.status })
      }
      return requireJsonResponse(response)
    }
    try {
      return await request()
    } catch (error) {
      if (isAbort(error, signal)) throw error
      if (reportable) log.warn('trpc call was interrupted', { path, error })

      /**
       * tRPC batches queries and mutations separately: queries are GET and
       * mutations are POST. Replaying a GET after readiness returns is safe.
       * Replaying a mutation is not: the server may have committed it before
       * the response was cut off, so a retry could perform the write twice.
       */
      if (method !== 'GET') {
        throw error instanceof ServerUnavailableError
          ? error
          : new ServerUnavailableError(error)
      }

      try {
        await waitForServer(base, url, recoveryDelaysMs, signal)
        // One replay, after the server has answered readiness. A second broken
        // response is a real outage, not permission to loop the query forever.
        return await request()
      } catch (retryError) {
        if (isAbort(retryError, signal)) throw retryError
        throw retryError instanceof ServerUnavailableError
          ? retryError
          : new ServerUnavailableError(retryError)
      }
    }
  }
}

export interface MakeTrpcOptions extends ReportingFetchOptions {
  /** Fetch implementation; injectable for the restart recovery test. */
  fetch?: typeof fetch
}

export function makeTrpc(httpOrigin: string, options: MakeTrpcOptions = {}): Trpc {
  const { fetch: base = fetch, ...reportingOptions } = options
  // The login session (podium_session cookie) is the operator's authentication; the tracker
  // grants full authority to any authenticated /trpc caller (no separate issue credential).
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${httpOrigin}/trpc`,
        fetch: reportingFetch(base, reportingOptions),
      }),
    ],
  })
}
