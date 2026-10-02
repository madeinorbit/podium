import { createLogger } from '@podium/logger'
import { TRPCClientError, type TRPCLink } from '@trpc/client'
import type { AnyRouter } from '@trpc/server'
import { observable, type Unsubscribable } from '@trpc/server/observable'

const defaultLog = createLogger('client-core:server-calls')

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
export const DEFAULT_RECOVERY_DELAYS_MS = [
  100, 250, 500, 1_000, 2_000, 3_000, 5_000, 5_000, 5_000, 5_000, 5_000,
]

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
  logger?: ReturnType<typeof createLogger>
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
        cache: 'no-store',
        ...(signal ? { signal } : {}),
      })
      // A 503 here is a server that IS up and is telling us its data plane is
      // blocked (PDM-26). That is the end of this wait — it answered — and
      // spinning on it would stall every reconnect behind an activation that
      // only a human can clear.
      if (!response.ok && response.status !== 503) continue
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
  const log = options.logger ?? defaultLog
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = trpcProcedurePath(url)
    const reportable = report && !path.split(',').some((name) => name.startsWith('logs.'))
    const signal = requestSignal(input, init)
    try {
      const response = await base(input, init)
      if (reportable && !response.ok) {
        log.warn('trpc call failed', { path, status: response.status })
      }
      return response
    } catch (error) {
      if (isAbort(error, signal)) throw error
      if (reportable) log.warn('trpc call could not be sent', { path, error })
      throw new ServerUnavailableError(error)
    }
  }
}

function causedBy(error: unknown, predicate: (value: unknown) => boolean): boolean {
  const seen = new Set<unknown>()
  let value = error
  while (value !== undefined && value !== null && !seen.has(value)) {
    if (predicate(value)) return true
    seen.add(value)
    value = typeof value === 'object' && 'cause' in value ? value.cause : undefined
  }
  return false
}

export function isServerUnavailable(error: unknown): boolean {
  return causedBy(
    error,
    (value) =>
      value instanceof ServerUnavailableError ||
      (typeof value === 'object' &&
        value !== null &&
        'code' in value &&
        value.code === 'SERVER_UNAVAILABLE'),
  )
}

function isInterrupted(error: unknown): boolean {
  return causedBy(
    error,
    (value) => value instanceof ServerUnavailableError || value instanceof SyntaxError,
  )
}

function isParseFailure(error: unknown): boolean {
  return causedBy(error, (value) => value instanceof SyntaxError)
}

function unavailable<TRouter extends AnyRouter>(
  error: unknown,
  errorType: typeof TRPCClientError,
): TRPCClientError<TRouter> {
  return errorType.from<TRouter>(new ServerUnavailableError(error))
}

/**
 * Recover only after tRPC's own body reader has found a cut response.
 *
 * This link is intentionally above `httpBatchLink`: the batch link consumes
 * each response exactly once and reports its parse failure here. Queries may
 * replay once after readiness because they are idempotent. Mutations never do;
 * the server may have committed the write before its response was cut.
 */
export function restartRecoveryLink<TRouter extends AnyRouter>(options: {
  base: typeof fetch
  httpOrigin: string
  report: boolean
  logger?: ReturnType<typeof createLogger>
  recoveryDelaysMs: readonly number[]
  /** Use the app client's class so isolated dependency links preserve its error identity. */
  errorType?: typeof TRPCClientError
}): TRPCLink<TRouter> {
  const log = options.logger ?? defaultLog
  const errorType = options.errorType ?? TRPCClientError
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        let stopped = false
        const recovery = new AbortController()
        const abort = (): void => recovery.abort(op.signal?.reason)
        if (op.signal?.aborted) abort()
        else op.signal?.addEventListener('abort', abort, { once: true })
        let subscription: Unsubscribable | undefined

        const subscribe = (replayed: boolean): void => {
          subscription = next(op).subscribe({
            next: (value) => observer.next(value),
            complete: () => observer.complete(),
            error: (error) => {
              if (!isInterrupted(error)) {
                observer.error(error)
                return
              }

              const reportable = options.report && !op.path.startsWith('logs.')
              if (reportable && isParseFailure(error)) {
                log.warn('trpc call returned a cut response', { path: op.path, error })
              }

              if (op.type !== 'query' || replayed) {
                observer.error(unavailable<TRouter>(error, errorType))
                return
              }

              void waitForServer(
                options.base,
                `${options.httpOrigin}/trpc/${op.path}`,
                options.recoveryDelaysMs,
                recovery.signal,
              ).then(
                () => {
                  if (!stopped) subscribe(true)
                },
                (retryError: unknown) => {
                  if (!stopped) observer.error(unavailable<TRouter>(retryError, errorType))
                },
              )
            },
          })
        }

        subscribe(false)
        return () => {
          stopped = true
          recovery.abort()
          op.signal?.removeEventListener('abort', abort)
          subscription?.unsubscribe()
        }
      })
}
