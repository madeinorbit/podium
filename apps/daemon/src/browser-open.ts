import { randomUUID } from 'node:crypto'
import { get } from 'node:http'
import type { BrowserOpenClassification } from '@podium/agent-bridge'
import type {
  BrowserOpenCallbackTarget,
  BrowserOpenIntent,
  DaemonMessage,
  SessionOpenUrlCallbackMessage,
  SessionOpenUrlDismissMessage,
} from '@podium/protocol'

export const BROWSER_OPEN_TTL_MS = 10 * 60 * 1_000
const CALLBACK_TIMEOUT_MS = 10_000
const MAX_OPEN_URL_BYTES = 16_384

interface PendingBrowserOpen {
  sessionId: string
  requestId: string
  url: string
  intent: BrowserOpenIntent
  callbackTarget?: BrowserOpenCallbackTarget
  expiresAt: number
}

export interface BrowserOpenManager {
  capture(sessionId: string, rawUrl: string): { ok: true } | { ok: false; error: string }
  callback(msg: SessionOpenUrlCallbackMessage): Promise<void>
  dismiss(msg: SessionOpenUrlDismissMessage): void
  replay(): void
  pendingCount(): number
}

function normalizedLoopbackHost(hostname: string): BrowserOpenCallbackTarget['host'] | undefined {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return host
  return undefined
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'http:' ? 80 : 443
}

function callbackTargetFrom(url: URL): BrowserOpenCallbackTarget | undefined {
  if (url.protocol !== 'http:') return undefined
  const host = normalizedLoopbackHost(url.hostname)
  if (!host) return undefined
  const port = effectivePort(url)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return { host, port, path: url.pathname || '/' }
}

/**
 * Derive the callback listener from the authorization URL. Only explicit OAuth
 * callback/redirect parameters count; an unrelated localhost query value must
 * not mint a callback capability. A direct loopback URL is also a valid target.
 */
export function deriveCallbackTarget(authUrl: URL): BrowserOpenCallbackTarget | undefined {
  const direct = callbackTargetFrom(authUrl)
  if (direct) return direct
  for (const [key, value] of authUrl.searchParams) {
    if (!/^(?:redirect|callback)_(?:uri|url)$/i.test(key)) continue
    try {
      const target = callbackTargetFrom(new URL(value))
      if (target) return target
    } catch {
      // Not a URL-shaped redirect value.
    }
  }
  return undefined
}

function parseForwardedUrl(rawUrl: string): URL | undefined {
  if (Buffer.byteLength(rawUrl, 'utf8') > MAX_OPEN_URL_BYTES) return undefined
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function result(
  send: (msg: DaemonMessage) => void,
  pending: Pick<PendingBrowserOpen, 'sessionId' | 'requestId'>,
  status: 'completed' | 'failed' | 'expired',
  extra: { error?: string; httpStatus?: number } = {},
): void {
  send({
    type: 'sessionOpenUrlResult',
    sessionId: pending.sessionId,
    requestId: pending.requestId,
    status,
    ...extra,
  })
}

/** Perform one non-redirecting GET, forced to a literal loopback address. */
export function executeLoopbackGet(url: URL): Promise<number> {
  const host = normalizedLoopbackHost(url.hostname)
  if (!host || url.protocol !== 'http:')
    return Promise.reject(new Error('callback must use loopback HTTP'))
  const local = new URL(url)
  local.hostname = host === '::1' ? '[::1]' : host === 'localhost' ? '127.0.0.1' : host
  return new Promise<number>((resolve, reject) => {
    const request = get(local, (response) => {
      const status = response.statusCode ?? 0
      response.resume()
      response.once('end', () => resolve(status))
    })
    request.setTimeout(CALLBACK_TIMEOUT_MS, () =>
      request.destroy(new Error('callback request timed out')),
    )
    request.once('error', reject)
  })
}

/**
 * Owns the expiring callback capability on the daemon that owns the session.
 * The server/client only route an opaque request id; validation and execution
 * remain beside the remote loopback listener. [spec:SP-a43e]
 */
export function createBrowserOpenManager(
  send: (msg: DaemonMessage) => void,
  opts: {
    now?: () => number
    ttlMs?: number
    execute?: (url: URL) => Promise<number>
    /** Harness-specific classification for the session's URL, consulted ahead
     *  of the generic redirect_uri heuristic (adapter.classifyBrowserOpen). */
    classify?: (sessionId: string, url: URL) => BrowserOpenClassification | undefined
  } = {},
): BrowserOpenManager {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? BROWSER_OPEN_TTL_MS
  const execute = opts.execute ?? executeLoopbackGet
  const pending = new Map<string, PendingBrowserOpen>()
  const key = (sessionId: string, requestId: string): string => `${sessionId}:${requestId}`

  const publish = (request: PendingBrowserOpen): void => {
    send({
      type: 'sessionOpenUrl',
      sessionId: request.sessionId,
      requestId: request.requestId,
      url: request.url,
      intent: request.intent,
      ...(request.callbackTarget ? { callbackTarget: request.callbackTarget } : {}),
      expiresAt: request.expiresAt,
    })
  }

  return {
    capture(sessionId, rawUrl) {
      const url = parseForwardedUrl(rawUrl.trim())
      if (!url) return { ok: false, error: 'browser-open URL must be a valid HTTP(S) URL' }
      // Adapter verdict first; the generic redirect_uri heuristic is the
      // fallback. A 'link' verdict also withholds the callback capability —
      // a plain link must not mint a paste-back target. [spec:SP-a43e]
      const verdict = opts.classify?.(sessionId, url)
      const callbackTarget = verdict?.intent === 'link' ? undefined : deriveCallbackTarget(url)
      const request: PendingBrowserOpen = {
        sessionId,
        requestId: randomUUID(),
        url: url.toString(),
        intent: verdict?.intent ?? (callbackTarget ? 'login' : 'link'),
        ...(callbackTarget ? { callbackTarget } : {}),
        expiresAt: now() + ttlMs,
      }
      pending.set(key(sessionId, request.requestId), request)
      publish(request)
      return { ok: true }
    },

    async callback(msg) {
      const requestKey = key(msg.sessionId, msg.requestId)
      const request = pending.get(requestKey)
      if (!request) {
        result(send, msg, 'failed', { error: 'browser-open request is no longer pending' })
        return
      }
      if (request.expiresAt <= now()) {
        pending.delete(requestKey)
        result(send, request, 'expired')
        return
      }
      if (!request.callbackTarget) {
        result(send, request, 'failed', {
          error: 'authorization URL did not declare a loopback callback target',
        })
        return
      }

      let callbackUrl: URL
      try {
        callbackUrl = new URL(msg.url.trim())
      } catch {
        result(send, request, 'failed', { error: 'callback must be a valid URL' })
        return
      }
      const host = normalizedLoopbackHost(callbackUrl.hostname)
      if (
        callbackUrl.protocol !== 'http:' ||
        !host ||
        effectivePort(callbackUrl) !== request.callbackTarget.port ||
        callbackUrl.pathname !== request.callbackTarget.path
      ) {
        result(send, request, 'failed', {
          error: `callback must match localhost:${request.callbackTarget.port}${request.callbackTarget.path}`,
        })
        return
      }

      try {
        const httpStatus = await execute(callbackUrl)
        if (httpStatus < 200 || httpStatus >= 400) {
          result(send, request, 'failed', {
            error: `remote callback listener returned HTTP ${httpStatus}`,
            httpStatus,
          })
          return
        }
        pending.delete(requestKey)
        result(send, request, 'completed', { httpStatus })
      } catch (error) {
        result(send, request, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },

    dismiss(msg) {
      pending.delete(key(msg.sessionId, msg.requestId))
    },

    replay() {
      for (const [requestKey, request] of pending) {
        if (request.expiresAt <= now()) {
          pending.delete(requestKey)
          continue
        }
        publish(request)
      }
    },

    pendingCount: () => pending.size,
  }
}
