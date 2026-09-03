/**
 * THE TYPED opencode CLIENT (POD-1761 W5; plan §2 `client.ts` + `sse.ts`).
 *
 * ---------------------------------------------------------------------------
 * ELEVEN ENDPOINTS, HAND-WRITTEN
 * ---------------------------------------------------------------------------
 *
 * opencode's `/doc` describes ~180 operations. This driver needs eleven, and the
 * plan is explicit that they are hand-written against recorded fixtures rather
 * than code-generated: a generated client would bind us to 169 shapes nothing
 * reads, and every one of them would become a version-gate liability the moment
 * upstream touched it.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS EVERY REQUEST CARRIES, AND BOTH ARE EASY TO LOSE
 * ---------------------------------------------------------------------------
 *
 *   1. `Authorization: Basic`. The secret is MANDATORY (spec §6) and it lives in
 *      this header and in the child's env — never in argv, never in a URL, never
 *      in a log line. `Bearer` does not work; opencode checks Basic and only
 *      Basic (verified: a bearer token gets the same 401 as no credentials).
 *   2. `?directory=<abs>`. Load-bearing on nearly every route and SILENT when
 *      omitted: `GET /event` without it yields `server.connected` plus
 *      heartbeats and not one session event, which reads exactly like "the agent
 *      is doing nothing". It is applied centrally here so no call site can
 *      forget it.
 */

import {
  type OpencodeEvent,
  type OpencodeMessageWithParts,
  OpencodeMessageWithParts as OpencodeMessageWithPartsSchema,
  type OpencodePermissionReply,
  OpencodePermissionRequest,
  type OpencodePermissionRule,
  type OpencodePromptBody,
  type OpencodeQuestionAnswers,
  OpencodeQuestionRequest,
  OpencodeSession,
  type OpencodeSessionId,
  parseOpencodeEvent,
} from './protocol.js'

/** Everything needed to talk to one session's server. */
export interface OpencodeClientConfig {
  /** `http://127.0.0.1:<port>` — loopback only, by construction. */
  baseUrl: string
  username: string
  /** The per-session secret. Held in memory and in the child's env; this object
   *  never logs it and never puts it in a URL. */
  password: string
  /** The session's workdir. Becomes `?directory=` on every request. */
  directory: string
  /** Injected so tests drive a fake server in-process. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /** Per-request timeout. Generous, because a loopback request that is slow is
   *  a server that is busy, not a server that is gone. */
  timeoutMs?: number
}

/** A non-2xx from the server, carrying enough to tell apart "we asked wrong"
 *  from "the credential is wrong" from "the session is gone". */
export class OpencodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    readonly body: string,
  ) {
    super(`opencode ${route} → ${status}${body ? `: ${body.slice(0, 300)}` : ''}`)
    this.name = 'OpencodeHttpError'
  }
  /** The one status with a specific meaning for this driver: the secret is
   *  wrong or absent. Spec §6's refusal, observed from the client side. */
  get unauthorized(): boolean {
    return this.status === 401
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

export interface OpencodeClient {
  /** `GET /global/health` — the readiness probe the spawn path polls, and the
   *  liveness probe `adopt()` uses to prove a journal entry still describes a
   *  live server rather than a recycled port. */
  health(): Promise<boolean>
  createSession(input?: {
    title?: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
    permission?: readonly OpencodePermissionRule[]
  }): Promise<OpencodeSession>
  getSession(sessionId: OpencodeSessionId): Promise<OpencodeSession>
  /** 204 = opencode has TAKEN the turn. Not "the turn finished". */
  prompt(sessionId: OpencodeSessionId, body: OpencodePromptBody): Promise<void>
  abort(sessionId: OpencodeSessionId): Promise<void>
  messages(sessionId: OpencodeSessionId): Promise<readonly OpencodeMessageWithParts[]>
  /** The OPEN asks, from the server rather than from our memory of the stream —
   *  see {@link OpencodePermissionRequest} for why the driver reconciles. */
  permissions(): Promise<readonly OpencodePermissionRequest[]>
  questions(): Promise<readonly OpencodeQuestionRequest[]>
  replyPermission(
    requestId: string,
    reply: OpencodePermissionReply,
    message?: string,
  ): Promise<void>
  replyQuestion(requestId: string, answers: OpencodeQuestionAnswers): Promise<void>
  rejectQuestion(requestId: string): Promise<void>
  /** The SSE stream. Ends when `signal` aborts or the socket closes; reconnect
   *  is the CALLER's business (see `./sse.ts`), because only the caller knows
   *  what its cursor was. */
  events(signal: AbortSignal): AsyncIterable<OpencodeEvent>
  /** The base URL, for the attach endpoint's `opencode attach <url>`. */
  readonly baseUrl: string
}

export function createOpencodeClient(config: OpencodeClientConfig): OpencodeClient {
  const doFetch = config.fetch ?? globalThis.fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const authorization = `Basic ${base64(`${config.username}:${config.password}`)}`

  const url = (path: string): string => {
    const qs = `directory=${encodeURIComponent(config.directory)}`
    return `${config.baseUrl}${path}${path.includes('?') ? '&' : '?'}${qs}`
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    /** A long-lived response body (`/event`) whose abort must outlive the
     *  headers — see the `finally` below. */
    streaming = false,
  ): Promise<Response> {
    // Every request is bounded. A hung loopback socket must not hold a session
    // verb open forever — `send()` promises a receipt, and a promise that never
    // settles is the one outcome the contract has no arm for.
    const timer = new AbortController()
    const onAbort = (): void => timer.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => timer.abort(), timeoutMs)
    if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref()
    try {
      const response = await doFetch(url(path), {
        method,
        headers: {
          authorization,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: timer.signal,
      })
      if (!response.ok) {
        throw new OpencodeHttpError(response.status, `${method} ${path}`, await safeText(response))
      }
      return response
    } finally {
      clearTimeout(timeout)
      /**
       * THE FORWARDER STAYS FOR A STREAM (POD-2023 review, 7.5).
       *
       * `finally` runs as soon as the response HEADERS arrive, which for an
       * ordinary request is after the body is read and for `/event` is at the
       * very beginning of a stream that then runs for the session's life.
       * Removing the listener there left `session.stream.abort()` with nothing
       * to reach: the fetch stayed open and the consume loop exited only when
       * the next read happened to resolve. Benign while every abort is paired
       * with killing the server, and a leaked subscription the moment a
       * reconnect aborts without doing so.
       *
       * `streaming` callers keep the forwarder; the AbortSignal is garbage with
       * the request once the stream ends.
       */
      if (!streaming) signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    baseUrl: config.baseUrl,

    async health() {
      try {
        await request('GET', '/global/health')
        return true
      } catch {
        // A DEAD SERVER AND A WRONG SECRET BOTH READ AS "not usable" HERE, and
        // that is right for the two callers: the readiness poll wants "can I
        // drive it yet", and `adopt()` wants "is this journal entry still true".
        // Neither is served by a distinction they would both collapse anyway.
        return false
      }
    },

    async createSession(input) {
      const response = await request('POST', '/session', input ?? {})
      return OpencodeSession.parse(await response.json())
    },

    async getSession(sessionId) {
      const response = await request('GET', `/session/${encodeURIComponent(sessionId)}`)
      return OpencodeSession.parse(await response.json())
    },

    async prompt(sessionId, body) {
      await request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body)
    },

    async abort(sessionId) {
      await request('POST', `/session/${encodeURIComponent(sessionId)}/abort`, {})
    },

    async messages(sessionId) {
      const response = await request('GET', `/session/${encodeURIComponent(sessionId)}/message`)
      const rows: unknown = await response.json()
      if (!Array.isArray(rows)) return []
      return rows.map((row) => OpencodeMessageWithPartsSchema.parse(row))
    },

    async permissions() {
      const response = await request('GET', '/permission')
      const rows: unknown = await response.json()
      if (!Array.isArray(rows)) return []
      return rows.map((row) => OpencodePermissionRequest.parse(row))
    },

    async questions() {
      const response = await request('GET', '/question')
      const rows: unknown = await response.json()
      if (!Array.isArray(rows)) return []
      return rows.map((row) => OpencodeQuestionRequest.parse(row))
    },

    async replyPermission(requestId, reply, message) {
      await request('POST', `/permission/${encodeURIComponent(requestId)}/reply`, {
        reply,
        ...(message ? { message } : {}),
      })
    },

    async replyQuestion(requestId, answers) {
      await request('POST', `/question/${encodeURIComponent(requestId)}/reply`, {
        answers: answers.map((selection) => [...selection]),
      })
    },

    async rejectQuestion(requestId) {
      await request('POST', `/question/${encodeURIComponent(requestId)}/reject`, {})
    },

    events(signal) {
      return streamEvents(() => request('GET', '/event', undefined, signal, true), signal)
    },
  }
}

/**
 * Read one `text/event-stream` body as parsed events.
 *
 * A HAND-ROLLED SSE READER, and the reason is the same as the hand-written
 * client: the format is six lines of parsing, and every library that implements
 * it also implements auto-reconnect with its own retry policy — which would
 * silently re-subscribe WITHOUT the cursor discipline this driver depends on.
 * Reconnect belongs to `./sse.ts`, where the high-water mark lives.
 *
 * `server.heartbeat` (which is not in `/doc`'s union at all, and arrives every
 * few seconds) parses to `null` and costs one comparison.
 */
async function* streamEvents(
  open: () => Promise<Response>,
  signal: AbortSignal,
): AsyncIterable<OpencodeEvent> {
  const response = await open()
  const body = response.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseFrame(frame)
        if (event) yield event
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    // Releasing the lock is what lets the socket actually close; without it an
    // aborted stream leaks a reader and the server keeps the subscription.
    reader.cancel().catch(() => {})
  }
}

function parseFrame(frame: string): OpencodeEvent | null {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    let raw: unknown
    try {
      raw = JSON.parse(payload)
    } catch {
      // Not JSON at all: a comment frame or a keep-alive. Never fatal.
      continue
    }
    const event = parseOpencodeEvent(raw)
    if (event) return event
  }
  return null
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** Base64 without assuming a Node `Buffer` — this file also runs under a bundler
 *  that targets a plain runtime, and `btoa` is the one form both have. */
function base64(input: string): string {
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(input)
  }
  return Buffer.from(input, 'utf8').toString('base64')
}
