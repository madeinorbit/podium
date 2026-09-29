import {
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asSessionId,
  firstAdminMemberId,
} from '@podium/model'
import type { TranscriptItem } from '@podium/model'
import { asDelegationRef } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { senderFromInboxPrincipal } from './modules/messages/service'
import type { InboxPrincipalReference } from './modules/sessions/inbox'
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

const principal: InboxPrincipalReference = {
  kind: 'user',
  attribution: {
    actor: actorUser(firstAdminMemberId()),
    onBehalfOf: firstAdminMemberId(),
  },
  principalRef: firstAdminMemberId(),
  delegation: null,
}

const deliver = async (
  deps: AnswerDeliveryDeps,
  input: Omit<Parameters<typeof deliverAnswerToSession>[1], 'principal'>,
) => await deliverAnswerToSession(deps, { ...input, principal })

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
  const answerAskUserQuestion = vi.fn(async () => ({ ok: true }))
  // The text fallback is the answerer's own message (POD-4846).
  const send = vi.fn(
    async (): Promise<{ disposition: string; ok: boolean; reason?: string }> => ({
      ok: true,
      disposition: 'queued',
    }),
  )
  const deps: AnswerDeliveryDeps = {
    getSession: (id) =>
      id === 'sess_1'
        ? {
            agentState: opts.phase
              ? { phase: opts.phase, ...(opts.needKind ? { need: { kind: opts.needKind } } : {}) }
              : undefined,
          }
        : undefined,
    sessions: { answerAskUserQuestion },
    messages: { send: send as never },
    rpc: { readTranscript: async () => ({ items: opts.items ?? [] }) },
  }
  return { deps, answerAskUserQuestion, send }
}

describe('deliverAnswerToSession (issue #53)', () => {
  it('types the matched option digit into a live menu', async () => {
    const h = harness({ phase: 'needs_user', needKind: 'question', items: [menuItem()] })
    const r = await deliver(h.deps, {
      sessionId: asSessionId('sess_1'),
      answer: 'No',
      textFallback: true,
    })
    expect(r).toEqual({ ok: true, via: 'menu', choices: [{ optionIndices: [2] }] })
    expect(h.answerAskUserQuestion).toHaveBeenCalledWith({
      sessionId: asSessionId('sess_1'),
      choices: [{ optionIndices: [2] }],
      principal,
    })
    expect(h.send).not.toHaveBeenCalled()
  })

  it("textFallback delivers as the answerer's own message when no menu is live", async () => {
    const h = harness({ phase: 'idle' })
    const r = await deliver(h.deps, {
      sessionId: asSessionId('sess_1'),
      answer: 'ship it',
      textFallback: true,
    })
    expect(r).toEqual({ ok: true, via: 'text' })
    // A person answered: their words, as their message — unwrapped, and waking
    // a parked session (POD-4846).
    expect(h.send).toHaveBeenCalledWith(
      { kind: 'operator', attribution: principal.attribution, delegationRef: null },
      {
        to: { kind: 'session', id: 'sess_1' },
        kind: 'message',
        urgency: 'next-turn',
        lifecycle: 'wake',
        body: 'ship it',
      },
    )
    expect(h.answerAskUserQuestion).not.toHaveBeenCalled()
  })

  it('fails closed on a live menu the answer cannot match — even with textFallback', async () => {
    // Free text must never land on top of an open native menu: no text send,
    // no digits, an explicit refusal instead.
    const h = harness({ phase: 'needs_user', needKind: 'question', items: [menuItem()] })
    const r = await deliver(h.deps, {
      sessionId: asSessionId('sess_1'),
      answer: 'maybe tomorrow',
      textFallback: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/could not match "maybe tomorrow"/)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.answerAskUserQuestion).not.toHaveBeenCalled()
  })

  it('menu-only mode (the MCP tool contract) refuses without a live menu', async () => {
    const h = harness({ phase: 'idle' })
    const r = await deliver(h.deps, { sessionId: asSessionId('sess_1'), answer: 'Yes' })
    expect(r).toEqual({ ok: false, message: 'no pending question (phase=idle)' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('unknown session is a refusal in both modes', async () => {
    const h = harness()
    expect(
      await deliver(h.deps, {
        sessionId: asSessionId('nope'),
        answer: 'Yes',
        textFallback: true,
      }),
    ).toEqual({ ok: false, message: 'unknown session' })
  })

  it('propagates a failed text send instead of claiming delivery', async () => {
    const h = harness({ phase: 'idle' })
    h.send.mockResolvedValueOnce({
      ok: false,
      disposition: 'dead_letter',
      reason: 'dead-lettered: session is archived',
    })
    const r = await deliver(h.deps, {
      sessionId: asSessionId('sess_1'),
      answer: 'x',
      textFallback: true,
    })
    expect(r).toEqual({ ok: false, message: 'dead-lettered: session is archived' })
  })

  it('a stored answer whose push the transport refused is still delivered, by the sweep', async () => {
    const h = harness({ phase: 'idle' })
    h.send.mockResolvedValueOnce({ ok: false, disposition: 'queued', reason: 'machine offline' })
    const r = await deliver(h.deps, {
      sessionId: asSessionId('sess_1'),
      answer: 'x',
      textFallback: true,
    })
    expect(r).toEqual({ ok: true, via: 'text' })
  })
})

// Whoever answered sends the text fallback (POD-4846): a person's answer is
// their own words, an agent's is that agent's mail, a job's is the job's.
describe('senderFromInboxPrincipal', () => {
  it('a person is the operator, carrying their own attribution', () => {
    expect(senderFromInboxPrincipal(principal)).toEqual({
      kind: 'operator',
      attribution: principal.attribution,
      delegationRef: null,
    })
  })

  it('an agent is that agent session', () => {
    const attribution = {
      actor: actorAgent(asAgentIdentityId('sess_a')),
      onBehalfOf: firstAdminMemberId(),
    }
    expect(
      senderFromInboxPrincipal({
        kind: 'agent',
        attribution,
        principalRef: 'sess_a',
        delegation: asDelegationRef('sess_a'),
      }),
    ).toEqual({ kind: 'agent', sessionId: 'sess_a', attribution, delegationRef: 'sess_a' })
  })

  it('a system job is that job', () => {
    const attribution = { actor: actorSystem('interaction-answer'), onBehalfOf: null }
    expect(
      senderFromInboxPrincipal({
        kind: 'system',
        attribution,
        principalRef: 'interaction-answer',
        delegation: null,
      }),
    ).toEqual({ kind: 'system', name: 'interaction-answer', attribution, delegationRef: null })
  })
})
