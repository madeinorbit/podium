/**
 * A FAKE `codex app-server`, SPEAKING THE RECORDED SHAPES (POD-1761 W6).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS FAKE
 * ---------------------------------------------------------------------------
 *
 * REAL: every line of the driver, the JSON-RPC client, the frame parsing, the
 * notification mapping, the receipt logic, the approval inversion — AND THE
 * FRAMING. This server writes newline-delimited JSON over a duplex the client
 * reads exactly as it reads a child's stdout, it omits the `jsonrpc` member from
 * its responses because the real one does, it answers nothing before
 * `initialize`, and its server→client request ids start at ZERO. Each of those
 * is a property the recorded fixtures pin and a real client would trip over.
 *
 * FAKE: the agent. No model runs, nothing waits out a timing ladder. That is
 * what makes the conformance run deterministic end to end.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A REAL SOCKET, WHEN W5's FAKE USED ONE
 * ---------------------------------------------------------------------------
 *
 * The opencode fixture stands up an actual `node:http` listener, and it does so
 * for one specific reason: opencode's per-session secret is a security property
 * that can only be PROVED by opening a real unauthenticated connection. This
 * transport has no listener and no secret — it is an inherited pipe — so there
 * is no equivalent thing to prove by binding a port. Using a real socket here
 * would test node's networking rather than this driver, and the property it
 * would be standing in for is one this transport satisfies by construction (see
 * `connectWithoutSecret` in the conformance fixture).
 */

import type { CodexTransport } from '../client.js'
import type { CodexTurn } from '../protocol.js'

/**
 * The server→client half of the pipe.
 *
 * SYNCHRONOUS DELIVERY, because that is what a pipe does: Node calls a stream's
 * `data` handler as the bytes arrive, not a tick later. It also makes the
 * corpus's synchronous control surface meaningful — `askInteraction` returns an
 * id, and the very next `interactions()` must already see the ask, exactly as a
 * caller reading a session that just blocked must.
 *
 * Lines written before the client registers its reader are BUFFERED rather than
 * dropped. The client registers during construction, so this only covers the
 * fixture's own ordering, but dropping them would make a lost frame look like a
 * driver bug.
 */
interface Pipe {
  push(line: string): void
  end(): void
  attach(handler: { line(line: string): void; closed(): void }): void
}

function makePipe(): Pipe {
  const buffered: string[] = []
  let handler: { line(line: string): void; closed(): void } | undefined
  let ended = false
  return {
    push(line) {
      if (ended) return
      if (handler) {
        handler.line(line)
        return
      }
      buffered.push(line)
    },
    end() {
      if (ended) return
      ended = true
      handler?.closed()
    },
    attach(next) {
      handler = next
      for (const line of buffered.splice(0)) handler.line(line)
      if (ended) handler.closed()
    },
  }
}

export interface FakeAppServerOptions {
  /** Thread ids to mint, in order. Deterministic so a test can name them. */
  threadIds?: readonly string[]
}

export interface FakeAppServer {
  /** The pipe the driver's client talks over. */
  transport: CodexTransport
  /** Is the child still running? Flipped by `crash()` and by a kill. */
  alive: boolean
  /** The thread this server started or resumed, once it has. */
  threadId: string | undefined
  /**
   * How many `turn/start` calls have been ACCEPTED.
   *
   * KEPT SEPARATE FROM {@link steers} on purpose. The corpus's `textDeliveries`
   * witness is the SUM of the two — a native steer delivers the caller's words
   * without opening a turn — and the conformance fixture adds them there,
   * deliberately and with the contract's rule 2 cited. Exposing one pre-summed
   * number here would hide which of the two moved, which is the distinction the
   * whole redesign was about.
   */
  turnStarts: number
  /** `turn/steer` calls that were accepted into an open turn. */
  steers: number
  /** Make the next `turn/start` answer a JSON-RPC error. */
  failNextTurn(): void
  /** Swallow the next request without answering it — a server that is still
   *  thinking. The only way to have a request genuinely IN FLIGHT when the pipe
   *  dies, which is what the "one dead pipe rejects them all" guarantee is
   *  about. */
  stallNextRequest(): void
  /**
   * Hold `turn/started` back after the next `turn/start` ack, so a test can act
   * INSIDE the ack-before-open window instead of around it. This is the live
   * ordering, held still: the turn is acked but not yet steerable.
   */
  deferTurnStarted(): void
  /** Let the held-back `turn/started` through. */
  releaseTurnStarted(): void
  /** Raise a server→client approval request; returns the ask id the driver will
   *  use (the stringified JSON-RPC id). */
  askCommandApproval(options?: { canAlwaysAllow?: boolean; command?: string }): string
  /** Raise an MCP elicitation request. */
  askElicitation(message?: string): string
  /** Answers received for server→client requests, by request id. */
  answers: Map<number, unknown>
  /** Drive the open turn to completion with a verdict Codex would report. */
  completeTurn(status?: 'completed' | 'interrupted' | 'failed'): void
  /** Emit an agent-message item, as `item/started` then `item/completed`. */
  emitAgentMessage(text: string, itemId?: string): void
  /** Emit a token fragment. Suppressed when the handshake opted out, exactly as
   *  the real server suppresses it. */
  emitDelta(itemId: string, delta: string): void
  /** Did this connection's handshake opt out of the deltas? */
  optedOutOfDeltas: boolean
  /** The child died. Closes the pipe, which is the only liveness signal this
   *  transport has. */
  crash(): void
  close(): void
}

export function startFakeAppServer(options: FakeAppServerOptions = {}): FakeAppServer {
  const toClient = makePipe()
  const threadIds = [...(options.threadIds ?? ['thr-1', 'thr-2', 'thr-3', 'thr-4', 'thr-5'])]
  let mintedThreads = 0
  let ready = false
  let failNext = false
  let stallNext = false
  let deferStarted = false
  let pendingStart: (() => void) | undefined
  /**
   * THE TURN IS STEERABLE ONLY ONCE `turn/started` HAS BEEN SENT.
   *
   * Two variables rather than one, because the live server has two states and
   * the gap between them is the whole hazard: `turn/start` answers with an
   * `inProgress` turn (that is `pendingTurn`), and only later does
   * `turn/started` arrive (that is `openTurn`). A steer in between is refused
   * with "no active turn to steer" — recorded in
   * `../__fixtures__/steer-interrupt.json`. A fake that collapsed the two would
   * let a driver treat the ack as the open turn and still pass.
   */
  let pendingTurn: string | undefined
  let openTurn: string | undefined
  let lastCompletedTurn: CodexTurn | undefined
  let turnSeq = 0
  let itemSeq = 0
  /** SERVER→CLIENT REQUEST IDS START AT ZERO, as the real server's do. A driver
   *  with a truthiness check on the id drops the first approval of every
   *  session, so the fixture makes that the FIRST case exercised rather than an
   *  edge one. */
  let nextRequestId = 0

  const server: FakeAppServer = {
    transport: {
      write(line) {
        handle(line)
      },
      onLine: (handler) => toClient.attach(handler),
      close() {
        toClient.end()
      },
    },
    alive: true,
    threadId: undefined,
    turnStarts: 0,
    steers: 0,
    answers: new Map(),
    optedOutOfDeltas: false,
    failNextTurn() {
      failNext = true
    },
    stallNextRequest() {
      stallNext = true
    },
    deferTurnStarted() {
      deferStarted = true
    },
    releaseTurnStarted() {
      deferStarted = false
      const release = pendingStart
      pendingStart = undefined
      release?.()
    },
    askCommandApproval(opts) {
      const id = nextRequestId++
      request(id, 'item/commandExecution/requestApproval', {
        threadId: server.threadId ?? 'thr-0',
        turnId: openTurn ?? 'turn-0',
        itemId: `exec-${id}`,
        startedAtMs: 1_786_699_418_214,
        command: opts?.command ?? "/bin/bash -lc 'echo hi'",
        cwd: '/tmp/conformance-codex',
        // The RECORDED live shape: `accept`, an amendment arm, and `cancel` —
        // and NO `acceptForSession` unless the test asks for one. That absence
        // is what makes `canAlwaysAllow: false` the honest answer.
        availableDecisions: opts?.canAlwaysAllow
          ? ['accept', 'acceptForSession', 'decline', 'cancel']
          : ['accept', 'cancel'],
      })
      return String(id)
    },
    askElicitation(message) {
      const id = nextRequestId++
      request(id, 'mcpServer/elicitation/request', {
        threadId: server.threadId ?? 'thr-0',
        message: message ?? 'Which environment?',
        requestedSchema: { type: 'object', properties: {} },
      })
      return String(id)
    },
    completeTurn(status = 'completed') {
      const turnId = openTurn ?? pendingTurn
      if (!turnId) {
        if (lastCompletedTurn) {
          notify('turn/completed', { threadId: server.threadId, turn: lastCompletedTurn })
        }
        return
      }
      const turn = {
        id: turnId,
        items: [],
        status,
        error: status === 'failed' ? { message: 'provider exploded' } : null,
        startedAt: 1_786_700_009,
        completedAt: 1_786_700_071,
        durationMs: 62_603,
      }
      openTurn = undefined
      pendingTurn = undefined
      lastCompletedTurn = turn
      notify('thread/status/changed', {
        threadId: server.threadId,
        status: { type: 'idle' },
      })
      notify('turn/completed', { threadId: server.threadId, turn })
    },
    emitAgentMessage(text, itemId) {
      const id = itemId ?? `msg_${++itemSeq}`
      const item = { type: 'agentMessage', id, text: '', phase: 'commentary', memoryCitation: null }
      notify('item/started', {
        threadId: server.threadId,
        turnId: openTurn,
        item,
        startedAtMs: 1_786_700_070_000,
      })
      notify('item/completed', {
        threadId: server.threadId,
        turnId: openTurn,
        item: { ...item, text, phase: 'final_answer' },
        completedAtMs: 1_786_700_071_000,
      })
    },
    emitDelta(itemId, delta) {
      // THE SERVER HONOURS ITS OWN OPT-OUT. A fake that sent deltas anyway would
      // let a driver pass the coarse watch level by filtering, which is exactly
      // the behaviour the negotiated knob exists to replace.
      if (server.optedOutOfDeltas) return
      notify('item/agentMessage/delta', {
        threadId: server.threadId,
        turnId: openTurn,
        itemId,
        delta,
      })
    },
    crash() {
      server.alive = false
      toClient.end()
    },
    close() {
      server.alive = false
      toClient.end()
    },
  }

  /** Responses OMIT `jsonrpc`, as the real server's do. */
  const respond = (id: number | string, result: unknown): void =>
    toClient.push(JSON.stringify({ id, result }))
  const respondError = (id: number | string, code: number, message: string): void =>
    toClient.push(JSON.stringify({ id, error: { code, message } }))
  const notify = (method: string, params: unknown): void =>
    toClient.push(JSON.stringify({ jsonrpc: '2.0', method, params, emittedAtMs: 1_786_700_000_000 }))
  const request = (id: number, method: string, params: unknown): void =>
    toClient.push(JSON.stringify({ jsonrpc: '2.0', id, method, params }))

  /** Move a turn from ACKED to STEERABLE, which is what `turn/started` means. */
  function announceStarted(turnId: string): void {
    pendingTurn = undefined
    openTurn = turnId
    notify('thread/status/changed', {
      threadId: server.threadId,
      status: { type: 'active', activeFlags: [] },
    })
    notify('turn/started', {
      threadId: server.threadId,
      turn: {
        id: turnId,
        items: [],
        status: 'inProgress',
        error: null,
        startedAt: 1_786_700_009,
        completedAt: null,
        durationMs: null,
      },
    })
  }

  function threadPayload(id: string): unknown {
    return {
      id,
      sessionId: id,
      forkedFromId: null,
      parentThreadId: null,
      preview: '',
      status: { type: 'idle' },
      path: `/home/agent/.codex/sessions/rollout-${id}.jsonl`,
      cwd: '/tmp/conformance-codex',
      createdAt: 1_786_700_008,
      updatedAt: 1_786_700_008,
    }
  }

  function handle(line: string): void {
    if (!server.alive) return
    let frame: {
      id?: number | string
      method?: string
      params?: Record<string, unknown>
      result?: unknown
    }
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }

    // A RESPONSE TO ONE OF OUR REQUESTS — the approval answer.
    if (frame.id !== undefined && frame.method === undefined) {
      server.answers.set(Number(frame.id), frame.result)
      notify('serverRequest/resolved', { threadId: server.threadId, requestId: Number(frame.id) })
      return
    }

    const { method, params = {}, id } = frame

    if (method === 'initialized') {
      return
    }

    /**
     * NOTHING IS ANSWERED BEFORE `initialize` — WITH SILENCE, NOT AN ERROR.
     *
     * This is the measured behaviour and it is the reason the client refuses to
     * send early rather than trying and recovering: on the real server an early
     * call also POISONS the connection, so there is nothing to recover to.
     */
    if (!ready && method !== 'initialize') return

    if (id === undefined) return

    if (stallNext) {
      // Received, understood, and never answered. The request stays in flight
      // until the pipe decides otherwise.
      stallNext = false
      return
    }

    switch (method) {
      case 'initialize': {
        const capabilities = (params.capabilities ?? {}) as {
          optOutNotificationMethods?: string[]
        }
        server.optedOutOfDeltas = (capabilities.optOutNotificationMethods ?? []).includes(
          'item/agentMessage/delta',
        )
        ready = true
        respond(id, {
          userAgent: 'podium/0.147.0 (fake)',
          codexHome: '/home/agent/.codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        })
        return
      }
      case 'getAuthStatus':
        respond(id, { authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true })
        return
      case 'thread/start': {
        const threadId = threadIds[mintedThreads++] ?? `thr-${mintedThreads}`
        server.threadId = threadId
        respond(id, { thread: threadPayload(threadId) })
        notify('thread/started', { thread: threadPayload(threadId) })
        return
      }
      case 'thread/resume': {
        const threadId = String(params.threadId)
        server.threadId = threadId
        respond(id, { thread: threadPayload(threadId) })
        notify('thread/started', { thread: threadPayload(threadId) })
        return
      }
      case 'thread/read':
        respond(id, { thread: { turns: [] } })
        return
      case 'turn/start': {
        if (failNext) {
          failNext = false
          // A REFUSED TURN, not an unprovable one. There is no verification
          // window in this family: the call either answered with a turn or it
          // answered an error, and the corpus pushes at `unverified` here.
          respondError(id, -32000, 'model provider refused the turn')
          return
        }
        server.turnStarts += 1
        const turnId = `turn-${++turnSeq}`
        pendingTurn = turnId
        /**
         * THE ACK LANDS BEFORE `turn/started`, EXACTLY AS MEASURED. The gap is
         * what makes a naive steer race, so the fixture reproduces it rather
         * than smoothing it out: the notification is pushed after the response,
         * and — crucially — the turn is not STEERABLE until it is. A driver that
         * treats the ack as an open turn gets the recorded refusal.
         */
        respond(id, {
          turn: {
            id: turnId,
            items: [],
            itemsView: 'notLoaded',
            status: 'inProgress',
            error: null,
            startedAt: 1_786_700_009,
            completedAt: null,
            durationMs: null,
          },
        })
        if (deferStarted) {
          // Held open so a test can act INSIDE the window rather than around it.
          pendingStart = () => announceStarted(turnId)
          return
        }
        announceStarted(turnId)
        return
      }
      case 'turn/steer': {
        const expected = String(params.expectedTurnId)
        if (!openTurn) {
          respondError(id, -32600, 'no active turn to steer')
          return
        }
        if (expected !== openTurn) {
          respondError(id, -32600, `expected active turn id ${expected} but found ${openTurn}`)
          return
        }
        server.steers += 1
        respond(id, { turnId: openTurn })
        return
      }
      case 'turn/interrupt': {
        const named = String(params.turnId)
        if (!openTurn) {
          respondError(id, -32600, `expected active turn id ${named} but found none`)
          return
        }
        if (named !== openTurn) {
          respondError(id, -32600, `expected active turn id ${named} but found ${openTurn}`)
          return
        }
        respond(id, {})
        // The FENCE arrives as its own notification, on the provider's schedule
        // — never synthesized by the driver. That is what makes
        // `fenceOnProviderConfirmation` testable.
        server.completeTurn('interrupted')
        return
      }
      case 'thread/fork': {
        const forked = `${server.threadId}-fork`
        respond(id, { thread: threadPayload(forked) })
        return
      }
      default:
        respondError(id, -32601, `fake app-server does not implement ${String(method)}`)
    }
  }

  return server
}
