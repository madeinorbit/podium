import {
  type Attribution,
  actorAgent,
  asAgentIdentityId,
  asMutationId,
  asSessionId,
  asUserId,
  type SessionId,
} from '@podium/model'
import {
  asDelegationRef,
} from '@podium/protocol'
import {
  type TurnReceipt,
} from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConn } from '../../gateway/client-registry'
import { harnessDisplayName, harnessInterrupt } from '../../harness-manifest'
import { testClientPrincipal } from '../../test-support/client-principal'
import { type InboxPrincipalReference, type QueuedInboxMessage, SessionInbox } from './inbox'
import type { Session } from './session'

const SID = asSessionId('session-target')
const ALICE = asUserId('user:alice')
const AGENT = asSessionId('session-agent')

const agentPrincipal = (): InboxPrincipalReference => ({
  kind: 'agent',
  principalRef: AGENT,
  delegation: asDelegationRef(AGENT),
  attribution: {
    actor: actorAgent(asAgentIdentityId(AGENT)),
    onBehalfOf: ALICE,
  },
})

function harness(
  options: {
    owner?: typeof ALICE | null
    status?: string
    agentKind?: 'codex' | 'opencode' | 'grok' | 'claude-code' | 'shell'
    /** The harness's observed phase — what the interrupt's idle guard reads, and
     *  what a queued send meets: `working` is WHY the send was queued (POD-1242). */
    phase?: string
    userTurns?: number
    /** Whether the transcript can WITNESS a send — production's normal state for
     *  an agent session, and what the confirmation gate keys off (POD-1100). */
    transcriptAvailable?: boolean
    stateObservedAt?: string
    /** Model a server-family session (no PTY bridge behind it) — POD-2291. */
    serverDriven?: boolean
    /** Receipts the fake contract port answers with, in order; when omitted
     *  entirely the port itself is absent (the bare-fixture shape). */
    contractReceipts?: TurnReceipt[]
  } = {},
) {
  const rows: Array<QueuedInboxMessage & { sessionId: SessionId; queuedAt: number }> = []
  const sent: unknown[] = []
  const contractCalls: unknown[] = []
  const rejected: unknown[] = []
  const answered: unknown[] = []
  let authorized = true
  const applied = vi.fn()
  const injected = vi.fn()
  const handleInput = vi.fn()
  const transcript: Array<{ id: string; role: 'user' | 'assistant'; text: string }> = Array.from(
    { length: options.userTurns ?? 0 },
    (_, index) => ({ id: `u${index}`, role: 'user' as const, text: `turn ${index}` }),
  )
  const session = {
    sessionId: SID,
    machineId: 'machine-1',
    status: options.status ?? 'live',
    agentKind: options.agentKind ?? 'codex',
    resume: { kind: 'codex', value: 'resume-1' },
    queuedMessageCount: 0,
    transcriptAvailable: options.transcriptAvailable ?? false,
    agentState: {
      phase: options.phase ?? 'idle',
      since: '2026-08-15T00:00:00.000Z',
      ...(options.stateObservedAt ? { stateObservedAt: options.stateObservedAt } : {}),
    },
    terminal: {
      lastOutputAtMs: 0,
      transcriptItems: () => transcript,
      recordInputActivity: vi.fn(),
      // POD-1081 added a live last-input attribution call on the real terminal
      // (terminal.ts). This fixture is `as unknown as Session`, so the compiler
      // cannot see the gap — the drift surfaces only as a runtime TypeError on
      // whichever line happens to be exercised. See POD-1459.
      noteInputAttribution: vi.fn(),
      handleInput,
      requestControl: vi.fn(),
      handleResize: vi.fn(),
      reconcileGeometry: vi.fn(),
    },
  } as unknown as Session
  const inbox = new SessionInbox({
    getSession: (id) => (id === SID ? session : undefined),
    queue: {
      enqueue: (row) => {
        if (rows.some((existing) => existing.id === row.id)) return false
        rows.push({ ...row, attempts: 0 })
        return true
      },
      list: (id) =>
        rows.filter((row) => row.sessionId === id).sort((a, b) => a.queuedAt - b.queuedAt),
      bumpAttempts: (id) => {
        const row = rows.find((candidate) => candidate.id === id)
        if (row) row.attempts += 1
      },
      resetAttempts: (id) => {
        const row = rows.find((candidate) => candidate.id === id)
        if (row) row.attempts = 0
      },
      delete: (id) => {
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
      },
    },
    daemon: { sendInput: (_machineId, message) => sent.push(message) },
    authorization: {
      authorizeAtDrain: () =>
        authorized ? ({ ok: true } as const) : ({ ok: false, reason: 'revoked' } as const),
      applied,
      injected,
      rejected: (input) => rejected.push(input),
    },
    attention: {
      stateChanged: vi.fn(),
      answered: (input) => answered.push(input),
    },
    now: () => Date.now(),
    persist: vi.fn(),
    broadcast: vi.fn(),
    needsSubmitVerification: (agentKind) => agentKind === 'claude-code',
    usesRawFirstTurn: (agentKind) => agentKind === 'grok',
    // The REAL manifest lookups, not stubs: which key aborts which CLI is the
    // fact under test, and a stubbed table would let the manifests drift from it.
    harnessInterrupt,
    harnessName: harnessDisplayName,
    prepareSend: vi.fn(),
    ownerOf: () => (options.owner === undefined ? ALICE : options.owner),
    resurrect: async () => ({ ok: true }),
    ...(options.serverDriven !== undefined
      ? { serverDriven: () => options.serverDriven === true }
      : {}),
    ...(options.contractReceipts
      ? {
          contractDeliver: (input: unknown) => {
            contractCalls.push(input)
            return Promise.resolve(
              options.contractReceipts?.shift() ??
                ({
                  outcome: 'accepted',
                  turnEpoch: 1,
                  deliveredAs: 'when-ready',
                  provenBy: 'protocol-ack',
                  at: new Date().toISOString(),
                } satisfies TurnReceipt),
            )
          },
        }
      : {}),
  })
  return {
    inbox,
    session,
    rows,
    sent,
    contractCalls,
    rejected,
    answered,
    applied,
    injected,
    handleInput,
    transcript,
    revoke: () => {
      authorized = false
    },
    /** The CLI accepted a prompt: it becomes the transcript's last user turn. */
    landTurn: (text: string) => {
      transcript.push({ id: `u${transcript.length}`, role: 'user', text })
    },
    /** The harness speaking for the resumed process. */
    observeState: (at: string) => {
      ;(session as unknown as { agentState: Record<string, unknown> }).agentState = {
        phase: 'idle',
        since: at,
        stateObservedAt: at,
      }
    },
    setStatus: (status: string) => {
      ;(session as unknown as { status: string }).status = status
    },
    /** The harness starting or finishing a turn. */
    setPhase: (phase: string) => {
      ;(session as unknown as { agentState: Record<string, unknown> }).agentState.phase = phase
    },
  }
}

const PASTE_OPEN = '\x1b[200~'
const PASTE_CLOSE = '\x1b[201~'

/** Decoded payloads the daemon gateway received, bracketed paste unwrapped and
 *  the submitting CR dropped — i.e. the prompts an operator actually sent. */
const typedTexts = (sent: unknown[]): string[] =>
  sent
    .map((entry) => Buffer.from((entry as { data: string }).data, 'base64').toString())
    .filter((text) => text !== '\r')
    .map((text) =>
      text.startsWith(PASTE_OPEN) && text.endsWith(PASTE_CLOSE)
        ? text.slice(PASTE_OPEN.length, -PASTE_CLOSE.length)
        : text,
    )

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionInbox authorization and identity', () => {
  it('stores only a delegation reference and re-authorizes immediately before drain', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness()
    const principal = agentPrincipal()

    expect(
      h.inbox.queueText({
        sessionId: SID,
        text: 'queued before revocation',
        mutationId: asMutationId('queued-1'),
        principal,
      }),
    ).toEqual({ ok: true, queued: true })
    expect(h.rows[0]?.principal).toEqual(principal)

    h.revoke()
    vi.advanceTimersByTime(7_000)

    expect(h.sent).toEqual([])
    expect(h.rows).toEqual([])
    expect(h.rejected).toEqual([
      expect.objectContaining({
        queueId: 'queued-1',
        principal,
        reason: 'revoked',
      }),
    ])
  })

  it('confirms a source message only when its queued input crosses the PTY boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness()

    h.inbox.queueText({
      sessionId: SID,
      text: 'deliver after boot',
      mutationId: asMutationId('queued-apply'),
      sourceMessageId: 'msg_pending',
      principal: agentPrincipal(),
    })
    expect(h.applied).not.toHaveBeenCalled()

    vi.advanceTimersByTime(7_000)

    expect(h.applied).toHaveBeenCalledWith({
      sourceMessageId: 'msg_pending',
      sessionId: SID,
    })
  })

  it('retracts a source message before the queued input reaches the PTY', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness()

    h.inbox.queueText({
      sessionId: SID,
      text: 'changed my mind',
      mutationId: asMutationId('queued-cancel'),
      sourceMessageId: 'msg_cancelled',
      principal: agentPrincipal(),
    })
    expect(h.inbox.cancelQueuedMessage(SID, 'msg_cancelled')).toBe(true)

    vi.advanceTimersByTime(7_000)

    expect(h.sent).toEqual([])
    expect(h.rows).toEqual([])
    expect(h.applied).not.toHaveBeenCalled()
  })

  it('types a first Grok chat send as raw keystrokes, not bracketed paste', () => {
    vi.useFakeTimers()
    const h = harness({ agentKind: 'grok' })
    expect(h.inbox.sendText({ sessionId: SID, text: 'hello grok' })).toEqual({ ok: true })
    const decode = (entry: unknown) =>
      Buffer.from((entry as { data: string }).data, 'base64').toString()
    expect(decode(h.sent[0])).toBe('hello grok')
    vi.advanceTimersByTime(100)
    expect(decode(h.sent[1])).toBe('\r')
  })

  it('keeps bracketed paste for later Grok turns once a user turn exists', () => {
    vi.useFakeTimers()
    const h = harness({ agentKind: 'grok', userTurns: 1 })
    expect(h.inbox.sendText({ sessionId: SID, text: 'follow up' })).toEqual({ ok: true })
    const decode = (entry: unknown) =>
      Buffer.from((entry as { data: string }).data, 'base64').toString()
    expect(decode(h.sent[0])).toBe('\x1b[200~follow up\x1b[201~')
    vi.advanceTimersByTime(100)
    expect(decode(h.sent[1])).toBe('\r')
  })

  it('queues a first Grok send while the TUI is still starting', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ agentKind: 'grok', status: 'starting' })
    expect(h.inbox.sendText({ sessionId: SID, text: 'too early' })).toEqual({
      ok: true,
      queued: true,
    })
    expect(h.sent).toEqual([])
    expect(h.rows).toHaveLength(1)
  })

  it('delivers OpenCode mail through the generic bracketed-paste route', () => {
    vi.useFakeTimers()
    const h = harness({ agentKind: 'opencode' })
    const principal = agentPrincipal()
    expect(
      h.inbox.sendText({ sessionId: SID, text: 'mail', inputOrigin: 'mail', principal }),
    ).toEqual({ ok: true })
    const decode = (entry: unknown) =>
      Buffer.from((entry as { data: string }).data, 'base64').toString()
    expect(decode(h.sent[0])).toBe(
      String.fromCharCode(27) + '[200~mail' + String.fromCharCode(27) + '[201~',
    )
    vi.advanceTimersByTime(100)
    expect(decode(h.sent[1])).toBe(String.fromCharCode(13))
  })

  it('carries the browser principal through controller gating into PTY attribution', () => {
    const h = harness()
    const principal = testClientPrincipal('browser-1')
    const client = { id: 'client-1' } as ClientConn

    h.inbox.handleControllerInput(principal, client, SID, 'x')

    expect(h.handleInput).toHaveBeenCalledWith('client-1', 'x', {
      actor: { kind: 'user', id: principal.user },
      onBehalfOf: principal.user,
    })
  })

  it('fails closed when a needs-human answer has no owner', () => {
    const h = harness({ owner: null })

    expect(
      h.inbox.answerAskUserQuestion({
        sessionId: SID,
        choices: [{ optionIndices: [2] }],
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: false })
    expect(h.sent).toEqual([])
    expect(h.answered).toEqual([])
  })

  it('attributes an answer as actor plus on-behalf-of and routes it to the owner', () => {
    const h = harness()
    const principal = agentPrincipal()

    expect(
      h.inbox.answerAskUserQuestion({
        sessionId: SID,
        choices: [{ optionIndices: [2] }],
        principal,
      }),
    ).toEqual({ ok: true })

    expect(h.sent).toEqual([
      expect.objectContaining({
        type: 'input',
        attribution: principal.attribution satisfies Attribution,
      }),
    ])
    expect(h.answered).toEqual([
      {
        ownerUserId: ALICE,
        sessionId: SID,
        attribution: principal.attribution,
      },
    ])
  })

  it('skip sends Esc and still records which human answered', () => {
    const h = harness()
    const principal = agentPrincipal()

    expect(
      h.inbox.answerAskUserQuestion({
        sessionId: SID,
        skip: true,
        principal,
      }),
    ).toEqual({ ok: true })

    expect(h.sent).toEqual([
      expect.objectContaining({
        type: 'input',
        data: Buffer.from('\x1b').toString('base64'),
        attribution: principal.attribution,
      }),
    ])
    expect(h.answered).toEqual([
      {
        ownerUserId: ALICE,
        sessionId: SID,
        attribution: principal.attribution,
      },
    ])
  })

  // ONE keystroke, and WHICH keystroke is the harness's fact, not a constant
  // (POD-1214). Measured on this host: claude-code and grok cancel on Esc and
  // ignore Ctrl-C; codex ignores Esc entirely and cancels on Ctrl-C.
  it.each([
    { agentKind: 'claude-code' as const, key: '\x1b' },
    { agentKind: 'grok' as const, key: '\x1b' },
    { agentKind: 'codex' as const, key: '\x03' },
    { agentKind: 'shell' as const, key: '\x03' },
  ])('interrupt sends $agentKind its own abort key with the authenticated principal attribution', ({
    agentKind,
    key,
  }) => {
    const h = harness({ agentKind, phase: 'working' })
    const principal = agentPrincipal()

    expect(h.inbox.interruptTurn({ sessionId: SID, principal })).toEqual({ ok: true })

    expect(h.sent).toEqual([
      expect.objectContaining({
        type: 'input',
        data: Buffer.from(key).toString('base64'),
        attribution: principal.attribution,
      }),
    ])
    expect(h.answered).toEqual([])
  })

  // The guard that keeps the fix from becoming a worse bug: one Ctrl-C at an
  // IDLE codex prompt exits the CLI, so a stop aimed at a turn that already
  // ended must refuse rather than kill the session.
  it('refuses to interrupt an idle codex instead of sending the key that would quit it', () => {
    const h = harness({ agentKind: 'codex', phase: 'idle' })

    const result = h.inbox.interruptTurn({ sessionId: SID, principal: agentPrincipal() })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('only takes an interrupt while it is working')
    expect(h.sent).toEqual([])
  })

  // Esc is inert at an idle prompt, so it needs no guard — and gating it would
  // reintroduce the stale-phase hole the client just stopped relying on.
  it('interrupts an idle Esc harness anyway', () => {
    const h = harness({ agentKind: 'claude-code', phase: 'idle' })

    expect(h.inbox.interruptTurn({ sessionId: SID, principal: agentPrincipal() })).toEqual({
      ok: true,
    })
    expect(h.sent).toHaveLength(1)
  })

  // interruptText SKIPS the key rather than refusing: its job is to deliver the
  // message, and an interrupt-urgency mail must never be what kills a session.
  it('delivers interrupt-urgency text to an idle codex without the quit-when-idle key', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ agentKind: 'codex', phase: 'idle' })

      expect(
        h.inbox.interruptText({
          sessionId: SID,
          text: 'stop and read this',
          principal: agentPrincipal(),
        }),
      ).toEqual({ ok: true })
      await vi.advanceTimersByTimeAsync(500)

      const decoded = h.sent.map((m) =>
        Buffer.from((m as { data: string }).data, 'base64').toString(),
      )
      expect(decoded.some((d) => d.includes('\x03'))).toBe(false)
      expect(decoded.some((d) => d.includes('stop and read this'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to interrupt a session that is not running', () => {
    const h = harness({ status: 'exited' })

    expect(h.inbox.interruptTurn({ sessionId: SID, principal: agentPrincipal() })).toEqual({
      ok: false,
      reason: 'session not running',
    })
    expect(h.sent).toEqual([])
  })

  it('free-text via Other schedules digit, then text, then CR', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const principal = agentPrincipal()

      expect(
        h.inbox.answerAskUserQuestion({
          sessionId: SID,
          choices: [{ freeText: 'custom', otherIndex: 3 }],
          principal,
        }),
      ).toEqual({ ok: true })

      const decoded = () =>
        h.sent.map((m) => Buffer.from((m as { data: string }).data, 'base64').toString())

      expect(decoded()).toEqual(['3'])
      await vi.advanceTimersByTimeAsync(120)
      expect(decoded()).toEqual(['3', 'custom'])
      await vi.advanceTimersByTimeAsync(120)
      // A LONE single-select question auto-submits on that CR, so the script
      // stops there — no closing confirm (POD-609).
      expect(decoded()).toEqual(['3', 'custom', '\r'])
      expect(h.answered).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // POD-770 — an answer the script cannot express is a REFUSAL, never a partial
  // script. The keystrokes for the preview layout are pinned in the command
  // oracle; these pin the half that decides whether anything is typed at all,
  // because a partial script is exactly how the bug stayed silent: the questions
  // it skipped stayed on their first row and the closing CR committed them.
  describe.each([
    [
      'free text whose Other row is off the digit range',
      { freeText: 'custom', otherIndex: 12 },
      "question 1: Other is at 12, outside the menu's 1-9 digits",
    ],
    [
      'an option index no digit can reach',
      { optionIndices: [11] },
      "question 1: no option in the menu's 1-9 digits (got 11)",
    ],
    [
      'a preview question claiming to be multi-select',
      { optionIndices: [1], previewLayout: true, multiSelect: true },
      'question 1: a preview question cannot be multi-select',
    ],
    [
      'several options on a preview question, which selects exactly one',
      { optionIndices: [1, 2], previewLayout: true },
      'question 1: a preview question takes one option, got 1,2',
    ],
  ])('an undeliverable answer (%s)', (_name, choice, reason) => {
    it('is refused with the reason and types nothing', () => {
      const h = harness()

      expect(
        h.inbox.answerAskUserQuestion({
          sessionId: SID,
          choices: [choice],
          principal: agentPrincipal(),
        }),
      ).toEqual({ ok: false, reason })
      expect(h.sent).toEqual([])
      // Nothing was delivered, so the question is still the operator's to answer.
      expect(h.answered).toEqual([])
    })
  })

  it('refuses one undeliverable question without typing the answerable ones before it', () => {
    const h = harness()

    expect(
      h.inbox.answerAskUserQuestion({
        sessionId: SID,
        choices: [{ optionIndices: [1] }, { optionIndices: [] }],
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: false, reason: "question 2: no option in the menu's 1-9 digits (got nothing)" })
    expect(h.sent).toEqual([])
  })

  // The keystroke SEQUENCES are pinned in oracle-commands.test.ts; what this
  // covers is the half only the inbox can see — the script outlives the call,
  // so every later keystroke has to re-ask whether there is still a menu.
  it('drops the rest of the answer script when the session leaves before it is typed', () => {
    vi.useFakeTimers()
    const h = harness()

    expect(
      h.inbox.answerAskUserQuestion({
        sessionId: SID,
        choices: [{ optionIndices: [1, 3], multiSelect: true }],
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: true })
    // The first digit leaves immediately; the Tab and the confirm CR are still
    // on their timers when the process goes.
    expect(h.sent).toHaveLength(1)

    Object.assign(h.session, { status: 'exited' })
    vi.advanceTimersByTime(5_000)

    expect(h.sent).toHaveLength(1)
  })
})

/**
 * POD-1100. A queued row used to leave the queue when its bytes reached the
 * daemon, which is a claim about the write and not about the agent. On a wake
 * the two come apart by tens of seconds: the PTY binds early, the CLI reads
 * late, and the paste in between went nowhere while the queue, the badge and
 * the ledger receipt all reported a delivery.
 */
describe('SessionInbox queued delivery is confirmed, not assumed', () => {
  const PROMPT = 'merge the branch and close the issue'

  it('keeps the row queued when the typed prompt never becomes a turn', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-unconfirmed'),
      sourceMessageId: 'msg_unconfirmed',
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(7_000)

    // It WAS typed — and that is exactly the evidence the old code mistook for
    // delivery. Nothing came back, so the row is still the operator's.
    expect(typedTexts(h.sent)).toEqual([PROMPT])
    expect(h.rows).toHaveLength(1)
    expect(h.session.queuedMessageCount).toBe(1)
    expect(h.applied).not.toHaveBeenCalled()
  })

  it('settles the row once the prompt appears as the transcript tail', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-confirmed'),
      sourceMessageId: 'msg_confirmed',
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(6_300)
    expect(h.rows).toHaveLength(1)

    h.landTurn(PROMPT)
    vi.advanceTimersByTime(1_000)

    expect(h.rows).toEqual([])
    expect(h.session.queuedMessageCount).toBe(0)
    expect(h.applied).toHaveBeenCalledWith({ sourceMessageId: 'msg_confirmed', sessionId: SID })
  })

  it('retypes an unconfirmed prompt after a backoff', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-retry'),
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(12_000)
    expect(typedTexts(h.sent)).toEqual([PROMPT])

    vi.advanceTimersByTime(2_000)
    expect(typedTexts(h.sent)).toEqual([PROMPT, PROMPT])

    h.landTurn(PROMPT)
    vi.advanceTimersByTime(1_000)
    expect(h.rows).toEqual([])
  })

  it('does not send twice when the first attempt landed late', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-late'),
      sourceMessageId: 'msg_late',
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(12_000)
    expect(typedTexts(h.sent)).toEqual([PROMPT])

    // The slow harness wrote the record after we had given up waiting — the
    // retry must read that before it types, or the operator gets it twice.
    h.landTurn(PROMPT)
    vi.advanceTimersByTime(4_000)

    expect(typedTexts(h.sent)).toEqual([PROMPT])
    expect(h.rows).toEqual([])
    expect(h.applied).toHaveBeenCalledTimes(1)
  })

  it('stops retyping after the attempt cap, leaving the row for a later re-arm', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-capped'),
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(180_000)

    expect(typedTexts(h.sent)).toHaveLength(5)
    expect(h.rows).toHaveLength(1)
    expect(h.session.queuedMessageCount).toBe(1)
  })

  it('waits for the resumed harness to speak before typing into a woken CLI', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ status: 'hibernated', transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-wake'),
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(400)

    // The PTY binds. markLive has already flipped the status, so the drain is
    // told what it cannot see: this CLI has proven nothing yet.
    h.setStatus('live')
    h.inbox.drain(SID, { justBound: true })
    vi.advanceTimersByTime(9_000)

    // Terminal silence here is a CLI still rehydrating, not one waiting to read.
    expect(typedTexts(h.sent)).toEqual([])

    h.observeState('2026-08-15T00:01:00.000Z')
    vi.advanceTimersByTime(400)

    expect(typedTexts(h.sent)).toEqual([PROMPT])
  })

  it('delivers a woken session whose harness reports no runtime state at all', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ status: 'hibernated', transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-silent'),
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(400)
    h.setStatus('live')
    h.inbox.drain(SID, { justBound: true })

    // Nothing will ever speak for this session, so the grace expires and the
    // quiet heuristic takes over rather than holding the prompt forever.
    vi.advanceTimersByTime(10_400)

    expect(typedTexts(h.sent)).toEqual([PROMPT])
  })

  it('waits out a running turn instead of retyping into it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    // The state a queued send meets by definition: the agent is mid-turn, which
    // is WHY the send was queued. The CLI takes the prompt into its own composer
    // queue and writes no user turn until the turn ends, so the five-second
    // confirmation can never succeed — and used to retype on that schedule.
    const h = harness({ transcriptAvailable: true, phase: 'working' })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-busy'),
      sourceMessageId: 'msg_busy',
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(240_000)

    expect(typedTexts(h.sent)).toEqual([PROMPT])
    expect(h.rows).toHaveLength(1)
    // Typed, not taken: the operator's bubble may settle, the ledger may not.
    expect(h.injected).toHaveBeenCalledWith({ sourceMessageId: 'msg_busy', sessionId: SID })
    expect(h.applied).not.toHaveBeenCalled()
  })

  it('settles the held row at the turn boundary that finally takes it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true, phase: 'working' })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-held'),
      sourceMessageId: 'msg_held',
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(600_000)
    expect(h.rows).toHaveLength(1)

    // Ten minutes later the turn ends and the CLI submits what it was holding.
    h.landTurn(PROMPT)
    h.setPhase('idle')
    vi.advanceTimersByTime(1_100)

    expect(typedTexts(h.sent)).toEqual([PROMPT])
    expect(h.rows).toEqual([])
    expect(h.applied).toHaveBeenCalledWith({ sourceMessageId: 'msg_held', sessionId: SID })
  })

  it('retypes once the agent is free and the prompt never arrived', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true, phase: 'working' })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-freed'),
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(60_000)
    expect(typedTexts(h.sent)).toEqual([PROMPT])

    // The turn ended and took something else — our prompt is not in the
    // transcript and nothing is holding it any more. NOW it was lost.
    h.setPhase('idle')
    vi.advanceTimersByTime(9_000)

    expect(typedTexts(h.sent)).toEqual([PROMPT, PROMPT])
  })

  it('does not retype into a busy agent when a later pass re-arms the drain', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-rearm'),
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(7_000)
    expect(typedTexts(h.sent)).toEqual([PROMPT])

    // The prompt it is holding started a turn. A reconnect re-arms the drain —
    // which is the second engine that put eight copies of one click on screen.
    h.setPhase('working')
    vi.advanceTimersByTime(120_000)
    h.inbox.drain(SID)
    vi.advanceTimersByTime(120_000)

    expect(typedTexts(h.sent)).toEqual([PROMPT])
    expect(h.rows).toHaveLength(1)
  })

  it('counts type attempts across drain passes, not within each one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-budget'),
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(180_000)
    expect(typedTexts(h.sent)).toHaveLength(5)

    // The row is still queued, and every bind, idle edge and machine reconnect
    // re-arms this pass. A per-pass cap makes the cap mean nothing.
    h.inbox.drain(SID)
    vi.advanceTimersByTime(180_000)

    expect(typedTexts(h.sent)).toHaveLength(5)
    expect(h.rows).toHaveLength(1)
  })

  it('gives a freshly bound CLI the attempt budget the dead one used up', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const h = harness({ transcriptAvailable: true })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-rebound'),
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(180_000)
    expect(typedTexts(h.sent)).toHaveLength(5)

    // A new process never saw any of those five: whatever the old CLI was
    // holding died with it, so the row is undelivered rather than over-delivered.
    h.inbox.drain(SID, { justBound: true })
    vi.advanceTimersByTime(180_000)

    expect(typedTexts(h.sent)).toHaveLength(10)
  })

  it('removes on write when the transcript cannot witness the send', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    // No transcript for this session: a blind retry could only duplicate, so the
    // old remove-on-write behaviour is the honest one.
    const h = harness({ transcriptAvailable: false })

    h.inbox.queueText({
      sessionId: SID,
      text: PROMPT,
      mutationId: asMutationId('queued-blind'),
      sourceMessageId: 'msg_blind',
      principal: agentPrincipal(),
    })
    vi.advanceTimersByTime(7_000)

    expect(typedTexts(h.sent)).toEqual([PROMPT])
    expect(h.rows).toEqual([])
    expect(h.applied).toHaveBeenCalledWith({ sourceMessageId: 'msg_blind', sessionId: SID })
  })
})

/**
 * POD-2291: a server-family session has no PTY bridge, so the drain must never
 * "type" a queued row at it — the daemon discards the bytes silently while this
 * side reports them applied, which is how the operator's first codex prompt
 * vanished with no transcript entry, no error and no dead-letter. Queued input
 * either delivers through the runtime contract, or stays visibly queued.
 */
describe('server-family drain via the runtime contract [POD-2291]', () => {
  const queueOne = (h: ReturnType<typeof harness>, id: string, sourceMessageId?: string) =>
    h.inbox.queueText({
      sessionId: SID,
      text: 'first prompt',
      mutationId: asMutationId(id),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      principal: agentPrincipal(),
    })

  it('delivers a queued row through the contract and never as PTY bytes', async () => {
    vi.useFakeTimers()
    const h = harness({ serverDriven: true, contractReceipts: [] })

    expect(queueOne(h, 'srv-1', 'msg_srv_1')).toEqual({ ok: true, queued: true })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(h.contractCalls).toEqual([
      expect.objectContaining({
        sessionId: SID,
        turnId: 'msg_srv_1',
        text: 'first prompt',
      }),
    ])
    // NOTHING typed toward the PTY: those bytes have nowhere to go.
    expect(h.sent).toEqual([])
    expect(h.applied).toHaveBeenCalledWith({ sourceMessageId: 'msg_srv_1', sessionId: SID })
    expect(h.rows).toEqual([])
  })

  it('keeps the row visibly queued when the contract refuses (not_running)', async () => {
    vi.useFakeTimers()
    const h = harness({
      serverDriven: true,
      contractReceipts: [
        { outcome: 'refused', refusal: { reason: 'not_running', detail: 'daemon gone' } },
      ],
    })

    expect(queueOne(h, 'srv-2', 'msg_srv_2')).toEqual({ ok: true, queued: true })
    await vi.advanceTimersByTimeAsync(5_000)

    // One attempt, then the drain ended — the row REMAINS, visible, for the
    // next bind/reconnect drain. It is never confirmed and never silently gone.
    expect(h.contractCalls).toHaveLength(1)
    expect(h.applied).not.toHaveBeenCalled()
    expect(h.rows).toHaveLength(1)
    expect(h.sent).toEqual([])
  })

  it('waits out a busy turn — past the PTY drain deadline — and delivers at the boundary', async () => {
    vi.useFakeTimers()
    const h = harness({ serverDriven: true, contractReceipts: [], phase: 'working' })

    expect(queueOne(h, 'srv-3', 'msg_srv_3')).toEqual({ ok: true, queued: true })
    // Well past the 25s never-live deadline: a busy server session is making
    // progress, so the drain must keep polling rather than strand the row.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(h.contractCalls).toEqual([])
    expect(h.rows).toHaveLength(1)

    Object.assign(h.session, { agentState: { phase: 'idle' } })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(h.contractCalls).toHaveLength(1)
    expect(h.rows).toEqual([])
    expect(h.applied).toHaveBeenCalledWith({ sourceMessageId: 'msg_srv_3', sessionId: SID })
  })

  it('re-polls after a busy refusal (the turn opened between the check and the send)', async () => {
    vi.useFakeTimers()
    const h = harness({
      serverDriven: true,
      contractReceipts: [{ outcome: 'refused', refusal: { reason: 'busy' } }],
    })

    expect(queueOne(h, 'srv-4', 'msg_srv_4')).toEqual({ ok: true, queued: true })
    await vi.advanceTimersByTimeAsync(2_000)

    // First receipt refused busy; the drain kept polling and the default
    // accepted receipt then confirmed the row.
    expect(h.contractCalls.length).toBeGreaterThanOrEqual(2)
    expect(h.rows).toEqual([])
    expect(h.applied).toHaveBeenCalledWith({ sourceMessageId: 'msg_srv_4', sessionId: SID })
  })

  it('keeps the row visibly queued on an unverified receipt (the RPC timeout answer)', async () => {
    vi.useFakeTimers()
    // This receipt is byte-for-byte what machines/rpc.ts synthesizes when the
    // runtimeSendRequest window closes with no daemon reply — the frame may
    // never have reached any daemon. Server drivers never legitimately emit
    // `unverified` (conformance pins it terminal-only), so confirming here
    // would delete a row nobody delivered: the original vanish, back through
    // a different door.
    const h = harness({
      serverDriven: true,
      contractReceipts: [
        {
          outcome: 'unverified',
          deliveredAs: 'when-ready',
          verificationWindowMs: 12_000,
          at: new Date().toISOString(),
        },
      ],
    })

    expect(queueOne(h, 'srv-6', 'msg_srv_6')).toEqual({ ok: true, queued: true })
    await vi.advanceTimersByTimeAsync(30_000)

    // One attempt, then stop — the row REMAINS queued and unconfirmed, and no
    // retry storms out of this drain (the next bind/reconnect re-drains it).
    expect(h.contractCalls).toHaveLength(1)
    expect(h.applied).not.toHaveBeenCalled()
    expect(h.rows).toHaveLength(1)
    expect(h.sent).toEqual([])
  })

  it('leaves the row queued when no contract port is wired, rather than typing into the void', async () => {
    vi.useFakeTimers()
    const h = harness({ serverDriven: true })

    expect(queueOne(h, 'srv-5', 'msg_srv_5')).toEqual({ ok: true, queued: true })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(h.sent).toEqual([])
    expect(h.rows).toHaveLength(1)
    expect(h.applied).not.toHaveBeenCalled()
  })

  it('refuses a direct typeText toward a server-family session', () => {
    vi.useFakeTimers()
    const h = harness({ serverDriven: true })

    expect(h.inbox.sendText({ sessionId: SID, text: 'typed at nothing' })).toEqual({ ok: false })
    expect(h.sent).toEqual([])
  })
})
