/**
 * THE PINS: recorded frames, parsed by the schemas the driver actually uses
 * (POD-1761 W6).
 *
 * The behavioural frame fixtures in `./__fixtures__` were captured from a LIVE
 * `codex app-server` on codex-cli 0.147.0 — real turns, a real
 * command-execution approval answered over the wire, a real steer into an open
 * turn, a real interrupt. The turn-lifecycle and steer fixtures were
 * re-recorded from codex-cli 0.155.0 with `clientUserMessageId` on every send
 * (POD-4835), and `client-message-id.json` holds what that id is and is not.
 * The method inventory in `protocol-pins.json` was
 * regenerated from codex-cli 0.151.0 before that minor was admitted. These
 * tests parse the recorded bytes with the schemas the driver ships and pin the
 * methods it sends and listens for.
 *
 * FOUR OF THESE PIN BEHAVIOUR, NOT SHAPE, and those are the ones worth reading:
 * the missing `jsonrpc` member, the zero-based request id, the ack-before-open
 * ordering, and `availableDecisions` deciding whether an always-allow exists.
 */

import { describe, expect, it } from 'vitest'
import approvalFixture from './__fixtures__/approval-command.json' with { type: 'json' }
import clientIdFixture from './__fixtures__/client-message-id.json' with { type: 'json' }
import handshakeFixture from './__fixtures__/handshake.json' with { type: 'json' }
import pinsFixture from './__fixtures__/protocol-pins.json' with { type: 'json' }
import steerFixture from './__fixtures__/steer-interrupt.json' with { type: 'json' }
import threadFixture from './__fixtures__/thread-start.json' with { type: 'json' }
import turnFixture from './__fixtures__/turn-lifecycle.json' with { type: 'json' }
import {
  CODEX_METHODS,
  CODEX_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUESTS,
  CodexAuthStatus,
  CodexCommandApprovalParams,
  CodexFrame,
  CodexInitializeResponse,
  CodexRpcError,
  CodexThread,
  CodexTurn,
  offersDecision,
  parseCodexNotification,
  userMessageClientId,
} from './protocol.js'
import { SUPPORTED_CODEX } from './version.js'

const frame = (raw: unknown) => CodexFrame.parse(raw)

/**
 * A frame's `result`, as a record.
 *
 * `CodexFrame.result` is `unknown` BY DESIGN — the envelope does not know what
 * any given method returns, and pretending otherwise at the schema level is how
 * a client ends up trusting a shape it never checked. Each test narrows with the
 * schema that actually owns the payload (`CodexThread`, `CodexTurn`, …); this
 * helper only gets it past the envelope.
 */
const resultOf = (raw: unknown): Record<string, unknown> =>
  (frame(raw).result ?? {}) as Record<string, unknown>
/** A request frame's `params`, as a record — the same narrowing as `resultOf`. */
const paramsOf = (raw: unknown): Record<string, unknown> =>
  (frame(raw).params ?? {}) as Record<string, unknown>

describe('the recorded handshake', () => {
  it('parses the initialize response the live server actually sent', () => {
    const parsed = CodexInitializeResponse.parse(frame(handshakeFixture.initializeResponse).result)
    expect(parsed.codexHome).toContain('.codex')
    expect(parsed.platformOs).toBe('linux')
  })

  it('accepts a response with NO `jsonrpc` member, because Codex sends none', () => {
    /**
     * THE PIN THAT WOULD BREAK EVERYTHING. JSON-RPC 2.0 says a response carries
     * `"jsonrpc":"2.0"`; codex 0.147.0 does not send it. A client that required
     * it would reject every reply the server ever makes — not some, every one —
     * and the failure would present as "all my requests time out".
     */
    expect(handshakeFixture.initializeResponse).not.toHaveProperty('jsonrpc')
    expect(frame(handshakeFixture.initializeResponse).id).toBe(1)
  })

  it('reports the ChatGPT subscription as `authMethod`, not `auth_mode`', () => {
    // The plan guessed `auth_mode`. The live field is `authMethod`, and reading
    // the wrong one would make the subscription assertion silently vacuous —
    // `undefined !== 'chatgpt'` looks exactly like an API key winning.
    const status = CodexAuthStatus.parse(frame(handshakeFixture.getAuthStatusResponse).result)
    expect(status.authMethod).toBe('chatgpt')
  })

  it('sends `initialized` as a NOTIFICATION — no id, so no reply is expected', () => {
    const sent = frame(handshakeFixture.initializedNotification)
    expect(sent.method).toBe(CODEX_METHODS.initialized)
    expect(sent.id).toBeUndefined()
  })
})

describe('the recorded thread', () => {
  it('carries the id and the rollout path that make export byte-faithful', () => {
    const thread = CodexThread.parse(resultOf(threadFixture.threadStartResponse).thread)
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/)
    // ONE FILE PER THREAD is the whole reason this driver can claim
    // `byteFaithful: true` where the opencode driver could not.
    expect(thread.path).toContain('rollout-')
    expect(thread.path).toContain(thread.id)
  })

  it('starts idle, so a fresh session is not reported as working', () => {
    const thread = CodexThread.parse(resultOf(threadFixture.threadStartResponse).thread)
    expect(thread.status?.type).toBe('idle')
  })
})

describe('the recorded turn lifecycle', () => {
  it('answers `turn/start` with an inProgress turn BEFORE `turn/started` arrives', () => {
    /**
     * THE ORDERING PIN, and the one that makes a naive steer race.
     *
     * The response is the ACK — it proves Codex took the turn, which is what
     * `provenBy: 'protocol-ack'` rests on. It is NOT the open turn: a
     * `turn/steer` fired between this response and the `turn/started` below is
     * refused with "no active turn to steer", which is pinned in the steer
     * fixture. The driver parks the id as PENDING here and only treats it as
     * steerable when the notification lands.
     */
    const ack = CodexTurn.parse(resultOf(turnFixture.turnStartResponse).turn)
    expect(ack.status).toBe('inProgress')

    const methods = turnFixture.notifications.map((note) => note.method)
    const started = methods.indexOf('turn/started')
    expect(started).toBeGreaterThanOrEqual(0)
    // The response was recorded before any of these notifications; the fixture's
    // own ordering is the evidence, and the steer fixture is the consequence.
    expect(methods.slice(0, started)).not.toContain('turn/completed')
  })

  it('fences the turn with `turn/completed` carrying Codex own verdict', () => {
    const completed = turnFixture.notifications.find((note) => note.method === 'turn/completed')
    expect(completed).toBeDefined()
    const parsed = parseCodexNotification(frame(completed))
    expect(parsed?.method).toBe('turn/completed')
    if (parsed?.method !== 'turn/completed') return
    // The VERDICT is the provider's. This driver never has to infer whether an
    // interrupt took effect, which is what the opencode driver had to do.
    expect(parsed.params.turn.status).toBe('completed')
  })

  it('ignores the notification arms this driver does not consume', () => {
    /**
     * A DRIVER THAT THREW ON AN UNKNOWN ARM WOULD BREAK ON EVERY UPSTREAM
     * FEATURE. 0.147.0 emits `hook/started`, `mcpServer/startupStatus/updated`
     * and `account/rateLimits/updated` during an ordinary turn — none of them
     * this driver's business.
     */
    expect(
      parseCodexNotification(frame({ jsonrpc: '2.0', method: 'hook/started', params: {} })),
    ).toBeNull()
    expect(
      parseCodexNotification(
        frame({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: {} }),
      ),
    ).toBeNull()
  })

  it('parses every arm it DOES consume out of the recorded stream', () => {
    const consumed = turnFixture.notifications
      .map((note) => parseCodexNotification(frame(note)))
      .filter((note): note is NonNullable<typeof note> => note !== null)
      .map((note) => note.method)
    // Not a tautology: these are the arms the recorded turn actually produced,
    // so a schema that stopped matching one of them fails here.
    expect(consumed).toContain('turn/started')
    expect(consumed).toContain('item/completed')
    expect(consumed).toContain('turn/completed')
    for (const method of consumed) {
      expect(CODEX_NOTIFICATION_METHODS).toContain(method)
    }
  })
})

describe('the recorded approval — the inversion', () => {
  it('arrives as a server→client REQUEST with a JSON-RPC id of ZERO', () => {
    /**
     * IDS START AT ZERO, and this is not pedantry. `if (msg.id)` is the obvious
     * way to test for a request id and it is FALSE for the first approval of
     * every session — so the very first permission prompt a user ever sees would
     * be the one silently dropped, and the turn would park with nothing to show
     * for it.
     */
    const request = frame(approvalFixture.approvalRequest)
    expect(request.id).toBe(0)
    expect(request.method).toBe(CODEX_SERVER_REQUESTS.commandApproval)
    // Both an id AND a method — that is what distinguishes a server request from
    // a response (id alone) and a notification (method alone).
    expect(request.id !== undefined && request.method !== undefined).toBe(true)
  })

  it('carries the command and the decisions it will actually accept', () => {
    const params = CodexCommandApprovalParams.parse(frame(approvalFixture.approvalRequest).params)
    expect(params.command).toContain('echo')
    /**
     * `availableDecisions` IS NOT IN THE GENERATED BINDINGS and IS on the wire.
     * The live ask offered `accept`, an execpolicy amendment and `cancel` — no
     * `acceptForSession` and no `decline`. A driver that assumed the full
     * decision enum would offer a user an always-allow the server then rejects.
     */
    expect(params.availableDecisions).toBeDefined()
    expect(offersDecision(params.availableDecisions, 'acceptForSession')).toBe(false)
    expect(offersDecision(params.availableDecisions, 'accept')).toBe(true)
  })

  it('treats a MISSING decision list as offering the plain decisions only', () => {
    // The field is newer than the requests themselves. Refusing to answer an ask
    // that omits it would strand a session on a protocol detail; claiming an
    // always-allow from its absence would report an ungranted persistent grant.
    expect(offersDecision(undefined, 'accept')).toBe(true)
    expect(offersDecision(undefined, 'decline')).toBe(true)
    expect(offersDecision(undefined, 'acceptForSession')).toBe(false)
  })

  it('closes on `serverRequest/resolved`, naming the request id', () => {
    const resolved = parseCodexNotification(frame(approvalFixture.serverRequestResolved))
    expect(resolved?.method).toBe('serverRequest/resolved')
    if (resolved?.method !== 'serverRequest/resolved') return
    // The SAME id the request carried — which is why the driver uses it as the
    // interaction id rather than minting a second one.
    expect(String(resolved.params.requestId)).toBe(
      String(frame(approvalFixture.approvalRequest).id),
    )
  })

  it('was answered with a bare decision, and that answer was accepted live', () => {
    const reply = frame(approvalFixture.approvalResponse)
    expect(reply.result).toEqual({ decision: 'accept' })
  })
})

describe('the recorded steer and interrupt', () => {
  it('accepts a steer into an OPEN turn and answers with the turn it joined', () => {
    // THE ACCEPTANCE ITEM, pinned to a live frame: `deliveredAs: 'steer'` rests
    // on this exchange having actually happened against codex 0.147.0.
    const request = frame(steerFixture.steerRequest)
    expect(request.method).toBe(CODEX_METHODS.turnSteer)
    expect(request.params).toHaveProperty('expectedTurnId')
    const response = frame(steerFixture.steerAcceptedResponse)
    expect(response.error).toBeUndefined()
    expect(response.result).toHaveProperty('turnId')
  })

  it('records a steer’s input as a later user item carrying the steer’s own id', () => {
    const request = paramsOf(steerFixture.steerRequest)
    const recorded = parseCodexNotification(frame(steerFixture.steerUserMessageCompleted))
    expect(recorded?.method).toBe('item/completed')
    if (recorded?.method !== 'item/completed') return
    // Recorded into the turn it joined, under Codex's own item id, with OUR id
    // beside it — the only id that can name a steer's entry.
    expect(recorded.params.turnId).toBe(request.expectedTurnId)
    expect(userMessageClientId(recorded.params.item)).toBe(request.clientUserMessageId)
    expect(recorded.params.item.id).not.toBe(request.clientUserMessageId)
  })

  it('does not dedupe a repeated steer id: the second steer is accepted too', () => {
    expect(paramsOf(steerFixture.duplicateSteerRequest).clientUserMessageId).toBe(
      paramsOf(steerFixture.steerRequest).clientUserMessageId,
    )
    expect(frame(steerFixture.duplicateSteerResponse).result).toHaveProperty('turnId')
  })

  it('accepts, on 0.155.0, the steer 0.147.0 refused before the turn opened', () => {
    // The driver still waits for `turn/started` — the 0.147 floor refuses.
    const early = steerFixture.steerBeforeTurnStartedAccepted
    expect(frame(early.response).error).toBeUndefined()
    const recorded = parseCodexNotification(frame(early.userMessageCompleted))
    if (recorded?.method !== 'item/completed') throw new Error('not an item')
    expect(userMessageClientId(recorded.params.item)).toBe(
      paramsOf(early.request).clientUserMessageId,
    )
  })

  it('refuses a steer sent before the turn actually opened (0.147.0)', () => {
    const response = frame(steerFixture.steerBeforeTurnStartedError)
    expect(response.error?.code).toBe(-32600)
    expect(response.error?.message).toContain('no active turn')
    // …and the driver classifies it as a precondition failure rather than a
    // transport error, which is what lets `send` fall back to the queue instead
    // of reporting the session dead.
    const err = new CodexRpcError(
      response.error?.code ?? 0,
      CODEX_METHODS.turnSteer,
      response.error?.message ?? '',
    )
    expect(err.turnPreconditionFailed).toBe(true)
  })

  it('classifies a STALE turn id the same way, from the other wording', () => {
    // Two verbs, two phrasings, one meaning. The stale-id form was recorded from
    // `turn/interrupt`; both must reach the same branch or a driver would treat
    // one of them as a dead session.
    const stale = pinsFixture.staleTurnIdInterruptError
    expect(stale).toBeTruthy()
    const err = new CodexRpcError(
      stale.error.code,
      CODEX_METHODS.turnInterrupt,
      stale.error.message,
    )
    expect(err.message).toContain('expected active turn id')
    expect(err.turnPreconditionFailed).toBe(true)
  })

  it('answers a well-formed interrupt, then fences with an `interrupted` verdict', () => {
    expect(frame(steerFixture.interruptResponse).error).toBeUndefined()
    const fence = parseCodexNotification(frame(steerFixture.interruptedTurnCompleted))
    expect(fence?.method).toBe('turn/completed')
    if (fence?.method !== 'turn/completed') return
    // PROVIDER CONFIRMATION, not a manufactured fence. `interrupt()` returns
    // nothing to await precisely because this is what ends the turn.
    expect(fence.params.turn.status).toBe('interrupted')
  })
})

describe('the recorded client message id', () => {
  const userItem = (raw: unknown) => {
    const parsed = parseCodexNotification(frame(raw))
    if (parsed?.method !== 'item/completed') throw new Error('not a completed item')
    return parsed.params
  }

  it('comes back on the turn’s user item, beside Codex’s own item id', () => {
    const sent = paramsOf(turnFixture.turnStartRequest).clientUserMessageId
    expect(sent).toBeTruthy()
    const turnId = CodexTurn.parse(resultOf(turnFixture.turnStartResponse).turn).id
    const recorded = turnFixture.notifications
      .map((note) => parseCodexNotification(frame(note)))
      .flatMap((note) =>
        note?.method === 'item/completed' && note.params.item.type === 'userMessage'
          ? [note.params]
          : [],
      )
    expect(recorded).toHaveLength(1)
    const [input] = recorded
    if (!input) throw new Error('no user item recorded')
    expect(input.turnId).toBe(turnId)
    expect(userMessageClientId(input.item)).toBe(sent)
    expect(input.item.id).not.toBe(sent)
  })

  it('is not a dedupe key: the same id again opens a second turn and a second item', () => {
    const first = userItem(clientIdFixture.firstUserMessageCompleted)
    const again = userItem(clientIdFixture.repeatUserMessageCompleted)
    expect(paramsOf(clientIdFixture.repeatTurnStartRequest).clientUserMessageId).toBe(
      userMessageClientId(first.item),
    )
    expect(userMessageClientId(again.item)).toBe(userMessageClientId(first.item))
    expect(again.turnId).not.toBe(first.turnId)
    expect(again.item.id).not.toBe(first.item.id)
  })

  it('is read back by `thread/read` on a fresh app-server — findable after a restart', () => {
    // The raw result: `CodexThread` does not model `turns`.
    const thread = resultOf(clientIdFixture.threadReadAfterRestartResponse).thread as {
      turns: { items: Record<string, unknown>[] }[]
    }
    const items = thread.turns.flatMap((turn) => turn.items)
    const first = userItem(clientIdFixture.firstUserMessageCompleted).item
    expect(items).toContainEqual(
      expect.objectContaining({ id: first.id, clientId: 'msg_podium_turn_A' }),
    )
  })

  it('reads null for an item that carries none', () => {
    expect(userMessageClientId({ type: 'userMessage', id: 'u', clientId: null })).toBeNull()
    expect(userMessageClientId({ type: 'agentMessage', id: 'a', clientId: 'x' })).toBeNull()
  })
})

describe('the method pins', () => {
  it('names only methods the pinned binary actually declares', () => {
    /**
     * The pin file was generated from `codex app-server generate-ts` on the
     * exact `verifiedThrough` version. Its `missingFromBinary` lists any method
     * this driver speaks that the binary does not know. A rename upstream shows
     * up as a non-empty list here rather than a silent approval hang.
     */
    expect(pinsFixture.pinnedVersion).toBe(SUPPORTED_CODEX.verifiedThrough)
    expect(pinsFixture.missingFromBinary.clientRequests).toEqual([])
    expect(pinsFixture.missingFromBinary.clientNotifications).toEqual([])
    expect(pinsFixture.missingFromBinary.serverRequests).toEqual([])
    expect(pinsFixture.missingFromBinary.serverNotifications).toEqual([])
  })

  it('keeps the driver constants and the pin file in agreement', () => {
    // Two sources of truth that must not drift: the constants the code sends and
    // the list the fixture verified against the binary.
    for (const method of Object.values(CODEX_METHODS)) {
      const known =
        pinsFixture.used.clientRequests.includes(method) ||
        pinsFixture.used.clientNotifications.includes(method)
      expect(known, `${method} is missing from protocol-pins.json`).toBe(true)
    }
    for (const method of Object.values(CODEX_SERVER_REQUESTS)) {
      expect(pinsFixture.used.serverRequests).toContain(method)
    }
    for (const method of CODEX_NOTIFICATION_METHODS) {
      expect(pinsFixture.used.serverNotifications).toContain(method)
    }
  })
})
