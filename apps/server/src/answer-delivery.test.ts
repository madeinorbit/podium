import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  type AnswerDeliveryDeps,
  deliverAnswerToSession,
} from './modules/superagent/answer-delivery'

/**
 * The shared answer-delivery path (issue #53): the answer_question menu gate +
 * matching extracted from the superagent tool belt, plus the Tray's textFallback
 * mode. The tool-belt (menu-only) behavior stays pinned by superagent.test.ts;
 * these tests cover the fallback semantics the tool never exercises.
 */

const menuItem = (multiSelect = false): TranscriptItem =>
  ({
    id: 'q1',
    role: 'tool',
    toolName: 'AskUserQuestion',
    toolInputJson: JSON.stringify({
      questions: [
        {
          question: 'Merge?',
          multiSelect,
          options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Later' }],
        },
      ],
    }),
  }) as unknown as TranscriptItem

function harness(opts: { phase?: string; needKind?: string; items?: TranscriptItem[] } = {}) {
  const answerAskUserQuestion = vi.fn(() => ({ ok: true }))
  const resumeAndSend = vi.fn(() => ({ ok: true }))
  const deps: AnswerDeliveryDeps = {
    getSession: (id) =>
      id === 'sess_1'
        ? {
            agentState: opts.phase
              ? { phase: opts.phase, ...(opts.needKind ? { need: { kind: opts.needKind } } : {}) }
              : undefined,
          }
        : undefined,
    sessions: { answerAskUserQuestion, resumeAndSend },
    rpc: { readTranscript: async () => ({ items: opts.items ?? [] }) },
  }
  return { deps, answerAskUserQuestion, resumeAndSend }
}

describe('deliverAnswerToSession (issue #53)', () => {
  it('types the matched option digit into a live menu', async () => {
    const h = harness({ phase: 'needs_user', needKind: 'question', items: [menuItem()] })
    const r = await deliverAnswerToSession(h.deps, {
      sessionId: 'sess_1',
      answer: 'No',
      textFallback: true,
    })
    expect(r).toEqual({ ok: true, via: 'menu', choices: [{ optionIndices: [2] }] })
    expect(h.answerAskUserQuestion).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      choices: [{ optionIndices: [2] }],
    })
    expect(h.resumeAndSend).not.toHaveBeenCalled()
  })

  it('textFallback delivers as a chat message when no menu is live', async () => {
    const h = harness({ phase: 'idle' })
    const r = await deliverAnswerToSession(h.deps, {
      sessionId: 'sess_1',
      answer: 'ship it',
      textFallback: true,
    })
    expect(r).toEqual({ ok: true, via: 'text' })
    expect(h.resumeAndSend).toHaveBeenCalledWith({ sessionId: 'sess_1', text: 'ship it' })
    expect(h.answerAskUserQuestion).not.toHaveBeenCalled()
  })

  it('fails closed on a live menu the answer cannot match — even with textFallback', async () => {
    // Free text must never land on top of an open native menu: no resumeAndSend,
    // no digits, an explicit refusal instead.
    const h = harness({ phase: 'needs_user', needKind: 'question', items: [menuItem()] })
    const r = await deliverAnswerToSession(h.deps, {
      sessionId: 'sess_1',
      answer: 'maybe tomorrow',
      textFallback: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/could not match "maybe tomorrow"/)
    expect(h.resumeAndSend).not.toHaveBeenCalled()
    expect(h.answerAskUserQuestion).not.toHaveBeenCalled()
  })

  it('menu-only mode (the MCP tool contract) refuses without a live menu', async () => {
    const h = harness({ phase: 'idle' })
    const r = await deliverAnswerToSession(h.deps, { sessionId: 'sess_1', answer: 'Yes' })
    expect(r).toEqual({ ok: false, message: 'no pending question (phase=idle)' })
    expect(h.resumeAndSend).not.toHaveBeenCalled()
  })

  it('unknown session is a refusal in both modes', async () => {
    const h = harness()
    expect(
      await deliverAnswerToSession(h.deps, {
        sessionId: 'nope',
        answer: 'Yes',
        textFallback: true,
      }),
    ).toEqual({ ok: false, message: 'unknown session' })
  })

  it('propagates a failed text send instead of claiming delivery', async () => {
    const h = harness({ phase: 'idle' })
    h.resumeAndSend.mockReturnValueOnce({ ok: false, reason: 'unknown session' } as never)
    const r = await deliverAnswerToSession(h.deps, {
      sessionId: 'sess_1',
      answer: 'x',
      textFallback: true,
    })
    expect(r).toEqual({ ok: false, message: 'unknown session' })
  })
})
