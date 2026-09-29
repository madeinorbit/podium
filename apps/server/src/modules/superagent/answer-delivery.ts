/**
 * Answer delivery to an agent session (issue #53): the answer_question matching
 * path, extracted from the superagent tool belt so the web-callable
 * `issues.answerQuestion` command and the `answer_question` MCP tool share ONE
 * implementation of the dangerous part — deciding whether a live native menu is
 * up and which digits (if any) may touch the PTY.
 *
 * Two modes:
 *  - menu-only (the MCP tool's contract): a session without a live pending
 *    AskUserQuestion menu is a refusal, never a stray keystroke;
 *  - with `textFallback` (the Tray's issues.answerQuestion, prose interaction
 *    answers): no live menu means the answer is the ANSWERER's own message
 *    (POD-4846) — a person's words unwrapped, an agent's as its mail — stored,
 *    with a delivery status, waking a parked session.
 *    A LIVE menu whose options can't be read or matched still fails closed —
 *    free text must never land on top of an open menu.
 */

import type { SessionId, TranscriptItem } from '@podium/model'
import { type MessageDeliveryService, senderFromInboxPrincipal } from '../messages/service'
import type { AnswerChoice, InboxPrincipalReference } from '../sessions/inbox'

/** The session shape the delivery gate reads (SessionMeta subset). */
export interface AnswerTargetSession {
  agentState?: { phase?: string; need?: { kind?: string } } | null
}

export interface AnswerDeliveryDeps {
  getSession(sessionId: SessionId): AnswerTargetSession | undefined | Promise<AnswerTargetSession | undefined>
  sessions: {
    pendingQuestion?(sessionId: SessionId): Promise<import('@podium/protocol').PendingInteractionWire | null>
    answerAskUserQuestion(input: {
      interactionId?: string
      sessionId: SessionId
      choices?: AnswerChoice[]
      skip?: boolean
      principal: InboxPrincipalReference
    }): Promise<{ ok: boolean; reason?: string }>
  }
  /** The text fallback's one send path (POD-4846). */
  messages: Pick<MessageDeliveryService, 'send'>
  rpc: {
    readTranscript(input: {
      sessionId: SessionId
      direction: 'before' | 'after'
      limit: number
    }): Promise<{ items: TranscriptItem[] }>
  }
}

export type AnswerDeliveryResult =
  /** Digits typed into the live native menu. */
  | { ok: true; via: 'menu'; choices: AnswerChoice[]; note?: string }
  /** Delivered as a chat message (textFallback, no live menu). */
  | { ok: true; via: 'text' }
  /** Not delivered; `message` keeps the tool belt's exact refusal strings. */
  | { ok: false; message: string }

export async function deliverAnswerToSession(
  deps: AnswerDeliveryDeps,
  input: {
    sessionId: SessionId
    answer: string
    principal: InboxPrincipalReference
    textFallback?: boolean
  },
): Promise<AnswerDeliveryResult> {
  const { sessionId, answer } = input
  const session = await deps.getSession(sessionId)
  if (!session) return { ok: false, message: 'unknown session' }
  // Gate on a LIVE pending menu before touching the PTY: the claude-code
  // classifier resolves an unresolved AskUserQuestion as needs_user with
  // need.kind 'question' (agent-bridge ask_user_tool label) — the ONLY
  // shape a real on-screen menu produces. idle+idle.kind 'question' is a
  // textual question (no menu; digits would land as message text), and a
  // working agent must never get stray digits/Enter mid-turn from a stale
  // menu still sitting in the transcript tail.
  const state = session.agentState
  if (!(state?.phase === 'needs_user' && state.need?.kind === 'question')) {
    if (!input.textFallback) {
      return { ok: false, message: `no pending question (phase=${state?.phase ?? 'unknown'})` }
    }
    // No live menu → the answer is an ordinary message from whoever answered
    // (POD-4846): a person's words unwrapped, an agent's as its mail. `wake`, so
    // a parked session is resumed and a starting one gets it once it is up.
    //
    // NOTE THE PHASE READ ABOVE STAYS (POD-1761 W4, C4). It asks whether there
    // is a QUESTION ON SCREEN to answer natively — a question about what the
    // agent is showing, which no send receipt can answer and which decides
    // between two different actions, not two deliveries.
    const r = await deps.messages.send(senderFromInboxPrincipal(input.principal), {
      to: { kind: 'session', id: sessionId },
      kind: 'message',
      urgency: 'next-turn',
      lifecycle: 'wake',
      body: answer,
    })
    // Stored is delivered-to-come: a push the transport refused is the sweep's
    // to retry. Only an answer that ended undelivered is a failure.
    return r.disposition === 'dead_letter'
      ? { ok: false, message: r.reason ?? 'send failed' }
      : { ok: true, via: 'text' }
  }
  // The live prompt's options live in the transcript: the LAST
  // AskUserQuestion call carries them as structured toolInputJson (the same
  // source the chat card renders from).
  // Capture identity before any asynchronous option work; replacement never
  // redirects this answer onto the new menu.
  const pending = await deps.sessions.pendingQuestion?.(sessionId)
  if (deps.sessions.pendingQuestion && !pending) return { ok: false, message: 'no authoritative pending question' }
  let questions: Array<{
    question?: string
    multiSelect?: boolean
    options?: ReadonlyArray<{ label?: string; preview?: string }>
  }> = []
  if (pending) {
    questions = [...(pending.payload as import('@podium/protocol').QuestionAsk).questions]
  } else {
    const { items } = await deps.rpc.readTranscript({ sessionId, direction: 'before', limit: 50 })
    const q = [...items].reverse().find((i) => i.role === 'tool' && i.toolName === 'AskUserQuestion' && i.toolInputJson)
    if (!q) return { ok: false, message: 'no pending AskUserQuestion found in the transcript tail' }
    try {
      const parsed = JSON.parse(q.toolInputJson ?? '{}') as { questions?: unknown }
      if (Array.isArray(parsed.questions)) questions = parsed.questions
    } catch {}
  }
  if (questions.length === 0)
    return { ok: false, message: 'pending question has no parseable options' }
  // One choice entry per question (the registry types digits into the
  // native menu). The single answer text is resolved against each
  // question's options — the dominant case is a single question.
  const choices: AnswerChoice[] = []
  const notes: string[] = []
  for (const qq of questions) {
    const labels = (qq.options ?? []).map((o) => o.label ?? '')
    const idx = matchAnswerToOptions(answer, labels)
    if (idx.length === 0) {
      return {
        ok: false,
        message: `could not match ${JSON.stringify(answer)} to the options: ${labels
          .map((l, i) => `${i + 1}) ${l}`)
          .join(', ')}`,
      }
    }
    // The native menu takes single digits — the relay silently drops
    // indices outside 1-9, so fail loudly here instead of reporting a
    // success that never reached the agent.
    const over = idx.find((n) => n > 9)
    if (over !== undefined) {
      return {
        ok: false,
        message: `option ${over} is beyond the native menu's 1-9 range — answer by label instead`,
      }
    }
    if (!qq.multiSelect && idx.length > 1) {
      notes.push(`single-select — used first of ${idx.join(',')}`)
    }
    // The shape rides along: a multi-select question's digits only toggle, so
    // the menu needs a Tab from us to move off it (POD-609), and a question with
    // per-option previews draws the side-by-side dialog, where the digit only
    // moves the cursor and a CR is what selects (POD-770).
    const previewLayout =
      !qq.multiSelect && (qq.options ?? []).some((o) => (o.preview ?? '') !== '')
    choices.push({
      optionIndices: qq.multiSelect ? idx : idx.slice(0, 1),
      ...(qq.multiSelect ? { multiSelect: true } : {}),
      ...(previewLayout ? { previewLayout: true } : {}),
    })
  }
  const r = await deps.sessions.answerAskUserQuestion({ sessionId, interactionId: pending?.id, choices, principal: input.principal })
  // A reason only ever accompanies the undeliverable-choice refusal; the older
  // not-live refusal is bare, and keeps its original wording.
  if (!r.ok) return { ok: false, message: `failed: ${r.reason ?? 'session not running'}` }
  return { ok: true, via: 'menu', choices, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) }
}

/**
 * Map a free-text answer to 1-based option indices for one AskUserQuestion:
 * bare number(s) win ("2", "1,3" — repeats deduped), then a case-insensitive
 * exact label match, then a UNIQUE case-insensitive substring match.
 * Empty result = no match. (Moved verbatim from tools.ts for issue #53.)
 */
export function matchAnswerToOptions(answer: string, labels: string[]): number[] {
  const t = answer.trim()
  if (/^\d+(\s*,\s*\d+)*$/.test(t)) {
    const idx = [...new Set(t.split(',').map((s) => Number.parseInt(s.trim(), 10)))]
    return idx.every((n) => n >= 1 && n <= labels.length) ? idx : []
  }
  const lower = t.toLowerCase()
  const exact = labels.findIndex((l) => l.trim().toLowerCase() === lower)
  if (exact !== -1) return [exact + 1]
  const subs = labels.flatMap((l, i) => (l.toLowerCase().includes(lower) ? [i + 1] : []))
  return subs.length === 1 ? subs : []
}
