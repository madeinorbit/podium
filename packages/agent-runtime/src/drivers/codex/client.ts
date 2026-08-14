/**
 * THE BIDIRECTIONAL JSON-RPC CLIENT (POD-1761 W6; plan §2).
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS DIFFERENT FROM W5's CLIENT
 * ---------------------------------------------------------------------------
 *
 * opencode's client is request/response over HTTP with a separate one-way event
 * stream, so nothing the server says can BLOCK. This one is a single duplex pipe
 * on which the server asks US questions and waits for answers — the approval
 * inversion, and the novel machinery of this driver. Three consequences shape
 * everything below:
 *
 *   1. A server→client request that is never answered PARKS THE TURN forever.
 *      There is no timeout on Codex's side that rescues it. So the handler is
 *      mandatory, and {@link CodexClient.respond} is the only way out.
 *   2. The transport is a PIPE, not a socket per call. One dead pipe kills every
 *      in-flight request at once, which is why `close()` rejects them all rather
 *      than letting callers hang on promises that can no longer settle.
 *   3. Ordering is the protocol. See the handshake note below.
 *
 * ---------------------------------------------------------------------------
 * THE HANDSHAKE IS STRICT AND ITS VIOLATION IS SILENT
 * ---------------------------------------------------------------------------
 *
 * Measured on 0.147.0: a `thread/start` sent before `initialize` gets NO
 * response — and it also poisons the connection, so the `initialize` that
 * follows never answers either. The failure is a hang, not an error, which is
 * the worst kind to debug and the easiest to prevent: this client REFUSES to
 * send anything but `initialize` until the handshake has completed, and refuses
 * to send `initialize` twice. That refusal is a typed throw at the call site
 * rather than a silent queue, because a caller that got the order wrong has a
 * bug that a queue would hide.
 */

import {
  type CodexAuthStatus,
  CodexAuthStatus as CodexAuthStatusSchema,
  CodexFrame,
  type CodexInitializeParams,
  type CodexInitializeResponse,
  CodexInitializeResponse as CodexInitializeResponseSchema,
  type CodexNotification,
  CodexProtocolError,
  CodexRpcError,
  CODEX_METHODS,
  parseCodexNotification,
} from './protocol.js'

/**
 * The pipe, abstracted.
 *
 * The driver package may not spawn a process (that is the daemon's, per the
 * split W3 and W5 both use), so the transport arrives already connected. Tests
 * hand in an in-memory pair; the daemon hands in a child's stdin/stdout.
 */
export interface CodexTransport {
  /** Write one framed line. The client appends the newline. */
  write(line: string): void
  /**
   * Register the reader. Called ONCE, by the client, at construction.
   *
   * PUSH, NOT PULL, and the choice matters twice over. It is how a pipe actually
   * behaves — Node invokes a stream's `data` handler synchronously as bytes
   * arrive, so an async-iterator wrapper adds a scheduling hop that the real
   * transport does not have. And that hop is not harmless: a server→client
   * approval request would then be observable by the driver only after a
   * microtask, so a caller that asked `interactions()` immediately after one
   * arrived would be told the session is unblocked when it is not. Delivering on
   * the same tick removes the gap rather than papering over it.
   *
   * `onClose` fires when the pipe ends for any reason.
   */
  onLine(handler: { line(line: string): void; closed(): void }): void
  /** Tear the pipe down. Idempotent. */
  close(): void
}

/** A server→client request, as the driver sees it. MUST be answered. */
export interface CodexServerRequest {
  id: number | string
  method: string
  params: unknown
}

export interface CodexClientConfig {
  transport: CodexTransport
  /** Called for every notification arm this driver consumes; unknown arms never
   *  reach it (see `parseCodexNotification`). */
  onNotification(notification: CodexNotification): void
  /** Called for every server→client request. The handler MUST eventually call
   *  `respond` — an unanswered approval parks the turn with no timeout. */
  onServerRequest(request: CodexServerRequest): void
  /**
   * The pipe ended without anyone asking it to.
   *
   * THE ONLY LIVENESS SIGNAL THIS TRANSPORT HAS, and the reason it is a callback
   * rather than something a caller polls: there is no port to probe and no
   * health endpoint. The child writing EOF is the child being gone, and a driver
   * that learned about it only when its next RPC timed out would report a dead
   * session as a slow one for however long that timeout is.
   *
   * NOT called for a `close()` the driver initiated — a stop, a kill and a
   * hibernate are all expected endings and must not be reported as a crash.
   */
  onClose?(): void
  /** Per-request ceiling. A hung request must not hold a session verb open
   *  forever: `send()` promises a receipt, and a promise that never settles is
   *  the one outcome the contract has no arm for. */
  timeoutMs?: number
  /** Injected so a test can drive time. */
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

const DEFAULT_TIMEOUT_MS = 120_000

export interface CodexClient {
  /** `initialize` + `initialized`, in that order, exactly once. */
  handshake(params: CodexInitializeParams): Promise<CodexInitializeResponse>
  /** Has the handshake completed? Everything else refuses until it has. */
  readonly ready: boolean
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  /** Answer a server→client request. The ONLY way an approval stops blocking. */
  respond(id: number | string, result: unknown): void
  /** Answer a server→client request with an error, for an ask we cannot honour. */
  respondError(id: number | string, code: number, message: string): void
  getAuthStatus(): Promise<CodexAuthStatus>
  close(): void
}

export function createCodexClient(config: CodexClientConfig): CodexClient {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const setTimer =
    config.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)
      // Unref'd: a pending RPC deadline must never hold the daemon up on
      // shutdown, exactly as every timer in the ported mechanics is.
      if (typeof handle === 'object' && 'unref' in handle) handle.unref()
      return handle
    })
  const clearTimer = config.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))

  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string; timer: unknown }
  >()
  let nextId = 1
  let ready = false
  let handshakeStarted = false
  let closed = false

  const fail = (err: Error): void => {
    // ONE DEAD PIPE KILLS EVERY IN-FLIGHT REQUEST. Leaving them pending would
    // hang whichever session verb is awaiting one, forever.
    for (const [, entry] of pending) {
      clearTimer(entry.timer)
      entry.reject(err)
    }
    pending.clear()
  }

  function dispatch(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      // Not JSON at all. Codex writes its own diagnostics to STDERR, so a
      // non-JSON line on stdout is either a banner or a bug upstream; either
      // way it is not fatal to the session and must not kill the read loop.
      return
    }
    const frame = CodexFrame.safeParse(raw)
    if (!frame.success) return

    const { id, method } = frame.data
    if (id !== undefined && method !== undefined) {
      // SERVER→CLIENT REQUEST. Note the id can be 0 — see the guard below.
      config.onServerRequest({ id, method, params: frame.data.params })
      return
    }
    if (id !== undefined) {
      /**
       * A RESPONSE. `id === 0` IS A VALID ID, and Codex's server→client ids
       * start at zero — a `if (id)` check here would drop the first approval of
       * every session. The map lookup is on the number, so this is only a
       * hazard for hand-written truthiness checks; it is called out because the
       * fixture proves the case is real, not hypothetical.
       */
      const key = typeof id === 'number' ? id : Number(id)
      const entry = pending.get(key)
      if (!entry) return
      pending.delete(key)
      clearTimer(entry.timer)
      if (frame.data.error) {
        entry.reject(
          new CodexRpcError(
            frame.data.error.code,
            entry.method,
            frame.data.error.message,
            frame.data.error.data,
          ),
        )
        return
      }
      entry.resolve(frame.data.result)
      return
    }
    const notification = parseCodexNotification(frame.data)
    if (notification) config.onNotification(notification)
  }

  config.transport.onLine({
    line(line) {
      if (closed) return
      dispatch(line)
    },
    closed() {
      // The pipe ended. Everything still awaiting an answer will never get one,
      // so they are rejected rather than left to their timeouts.
      if (closed) return
      /**
       * AND THE CLIENT IS CLOSED, not merely drained (POD-2024 review nit).
       *
       * Only `close()` used to set this, so a `call()` issued AFTER the pipe died
       * was accepted, written to a dead transport and left to time out — 120
       * seconds to learn something the client already knew. A dead pipe is a
       * closed client whoever noticed first.
       */
      closed = true
      fail(new CodexProtocolError('codex app-server closed its pipe'))
      config.onClose?.()
    },
  })

  const send = (frame: Record<string, unknown>): void => {
    if (closed) throw new CodexProtocolError('codex client is closed')
    config.transport.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  }

  function call<T>(method: string, params?: unknown): Promise<T> {
    if (!ready && method !== CODEX_METHODS.initialize) {
      // THE STRICT ORDER, ENFORCED HERE RATHER THAN DISCOVERED IN PRODUCTION.
      // Sending this would hang forever AND poison the connection for the
      // handshake that follows.
      return Promise.reject(
        new CodexProtocolError(
          `codex app-server refuses '${method}' before the initialize handshake completes, and answers it with silence rather than an error — so this is refused here instead`,
        ),
      )
    }
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(id)
        reject(new CodexProtocolError(`codex ${method} did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
        timer,
      })
      try {
        send({ id, method, ...(params !== undefined ? { params } : {}) })
      } catch (err) {
        pending.delete(id)
        clearTimer(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  return {
    get ready() {
      return ready
    },

    async handshake(params: CodexInitializeParams): Promise<CodexInitializeResponse> {
      if (handshakeStarted) {
        throw new CodexProtocolError('codex handshake already performed on this connection')
      }
      handshakeStarted = true
      const result = await call<unknown>(CODEX_METHODS.initialize, params)
      const parsed = CodexInitializeResponseSchema.parse(result)
      /**
       * `initialized` IS A NOTIFICATION, and it is the gate: the server accepts
       * no other method until it has been sent.
       *
       * The comment that used to sit here described the OPPOSITE of the order
       * below. `ready` is flipped first because the two statements cannot
       * interleave — this runs synchronously to completion, so no caller can
       * observe the window — and this order keeps the flag meaning "the
       * handshake succeeded" rather than "the notification reached a socket
       * buffer", which is not a fact any caller should be gated on.
       */
      ready = true
      send({ method: CODEX_METHODS.initialized })
      return parsed
    },

    call,

    respond(id, result) {
      // NO `jsonrpc` VALIDATION EXPECTED BACK, and none needed going out — the
      // server accepts the member and never sends it.
      send({ id, result })
    },

    respondError(id, code, message) {
      send({ id, error: { code, message } })
    },

    async getAuthStatus(): Promise<CodexAuthStatus> {
      const result = await call<unknown>(CODEX_METHODS.getAuthStatus, {
        includeToken: false,
        refreshToken: false,
      })
      return CodexAuthStatusSchema.parse(result)
    },

    close() {
      if (closed) return
      closed = true
      fail(new CodexProtocolError('codex client closed'))
      config.transport.close()
    },
  }
}
