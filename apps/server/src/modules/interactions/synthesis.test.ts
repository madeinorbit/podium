/**
 * The state → ask corpus (POD-2020). Every case here is a claim about what one
 * observed `AgentRuntimeState` MEANS, which is the part of the aggregate that
 * has to be right before anything durable is worth writing.
 */

import { type AgentRuntimeState, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type InteractionAskSpec,
  interactionFingerprint,
  normalizeQuestions,
  sourceFor,
  synthesizeAsk,
} from './synthesis'

const S = asSessionId('ses_1')

const state = (partial: Partial<AgentRuntimeState>): AgentRuntimeState => ({
  phase: 'idle',
  since: '2026-08-14T00:00:00.000Z',
  nativeSubagentCount: 0,
  ...partial,
})

describe('synthesizeAsk', () => {
  /**
   * The operator's complaint, at the synthesis seam: Claude's onboarding dialog
   * blocks every turn they send, and it is drawn by the CLI rather than by an
   * AskUserQuestion tool call — so the transcript read that supplies options
   * returns nothing for it. Before this, that produced the optionless "open the
   * terminal" card on a session they were trying to answer FROM the app.
   */
  it('answers a screen-drawn dialog from the options the classifier read', () => {
    const ask = synthesizeAsk(
      S,
      state({
        phase: 'needs_user',
        stateSource: 'classifier',
        need: {
          kind: 'question',
          summary: 'Set up auto mode for your environment?',
          interview: {
            questions: [
              {
                question: 'Set up auto mode for your environment?',
                header: 'Auto mode',
                options: [
                  { label: 'Set it up', description: 'Propose auto-mode guardrails.' },
                  { label: "Don't show again", description: 'Dismiss this setup prompt.' },
                ],
              },
            ],
          },
        },
      }),
      // The transcript has nothing to say: there is no tool call behind this
      // dialog, which is the whole reason the classifier read the screen.
      {},
    )
    expect(ask?.source).toBe('screen-classifier')
    expect(ask?.spec.kind).toBe('question')
    const questions = (ask?.spec as Extract<InteractionAskSpec, { kind: 'question' }>).payload
      .questions
    expect(questions).toHaveLength(1)
    expect(questions[0]?.question).toBe('Set up auto mode for your environment?')
    expect(questions[0]?.header).toBe('Auto mode')
    // PRESSABLE is the point: two real options, and the native Other row one
    // past them, so a surface can offer buttons and the digit path can type.
    expect(questions[0]?.options.map((o) => o.label)).toEqual(['Set it up', "Don't show again"])
    expect(questions[0]?.otherIndex).toBe(3)
  })

  it('still prefers the transcript, which is the richer record', () => {
    const ask = synthesizeAsk(
      S,
      state({
        phase: 'needs_user',
        stateSource: 'hook',
        need: {
          kind: 'question',
          summary: 'Which?',
          interview: { questions: [{ question: 'Which?', options: [{ label: 'from-screen' }] }] },
        },
      }),
      { questionOptions: [{ question: 'Which?', options: [{ label: 'from-transcript' }] }] },
    )
    const questions = (ask?.spec as Extract<InteractionAskSpec, { kind: 'question' }>).payload
      .questions
    expect(questions[0]?.options.map((o) => o.label)).toEqual(['from-transcript'])
  })

  it('turns a hook-sourced permission prompt into a typed permission ask', () => {
    const ask = synthesizeAsk(
      S,
      state({
        phase: 'needs_user',
        stateSource: 'hook',
        need: {
          kind: 'permission',
          summary: 'Bash',
          ask: { toolName: 'Bash', detail: 'rm -rf build', canAlwaysAllow: true },
        },
      }),
    )
    expect(ask?.spec).toEqual({
      kind: 'permission',
      payload: { v: 1, toolName: 'Bash', inputSummary: 'rm -rf build', canAlwaysAllow: true },
    })
    expect(ask?.source).toBe('hook')
    // Terminal-family asks are keystroke-emulated whatever their source: a hook
    // is high-confidence about WHAT is asked and says nothing about how it can
    // be answered.
    expect(ask?.answerable).toBe('keystroke-emulated')
  })

  it('keeps a permission ask that carries no tool call — the Notification channel', () => {
    const ask = synthesizeAsk(
      S,
      state({
        phase: 'needs_user',
        stateSource: 'hook',
        need: { kind: 'permission', summary: 'Claude needs your permission to use Bash' },
      }),
    )
    // A real blocking ask with a weak subject beats no row at all.
    expect(ask?.spec.kind).toBe('permission')
    expect(ask?.spec.payload).toMatchObject({ canAlwaysAllow: false })
  })

  it('reads a live AskUserQuestion menu into typed prompts', () => {
    const ask = synthesizeAsk(
      S,
      state({ phase: 'needs_user', stateSource: 'hook', need: { kind: 'question' } }),
      {
        questionOptions: [
          {
            question: 'Which database?',
            multiSelect: false,
            options: [{ label: 'Postgres', preview: 'CREATE TABLE …' }, { label: 'SQLite' }],
          },
        ],
      },
    )
    expect(ask?.spec).toEqual({
      kind: 'question',
      payload: {
        v: 1,
        questions: [
          {
            question: 'Which database?',
            multiSelect: false,
            // POD-770: a single-select question with any per-option preview
            // draws the side-by-side dialog, where a digit only moves the cursor.
            previewLayout: true,
            options: [{ label: 'Postgres', preview: 'CREATE TABLE …' }, { label: 'SQLite' }],
          },
        ],
      },
    })
  })

  it('classifies a poll/classifier observation as screen-classifier, not hook', () => {
    expect(sourceFor(state({ stateSource: 'classifier' }))).toBe('screen-classifier')
    expect(sourceFor(state({ stateSource: 'poll' }))).toBe('screen-classifier')
    // "We don't know how we learned this" must never be more trusted than
    // "we scraped it".
    expect(sourceFor(state({}))).toBe('screen-classifier')
    expect(sourceFor(state({ stateSource: 'hook' }))).toBe('hook')
  })

  it('turns a plan-mode idle into a plan-approval ask', () => {
    const ask = synthesizeAsk(
      S,
      state({ phase: 'idle', idle: { kind: 'approval', summary: 'Step 1: rewrite the parser' } }),
    )
    expect(ask?.spec).toEqual({
      kind: 'plan-approval',
      payload: { v: 1, plan: 'Step 1: rewrite the parser', autoAcceptOffered: false },
    })
  })

  it('materializes an auth failure as a login ask — the routing rule', () => {
    const ask = synthesizeAsk(
      S,
      state({ phase: 'errored', error: { class: 'auth_expired', retryable: false } }),
    )
    expect(ask?.spec).toMatchObject({ kind: 'login', payload: { reason: 'auth-expired' } })
  })

  it('leaves a non-auth error alone — a rate limit is not a blocking ask', () => {
    expect(
      synthesizeAsk(
        S,
        state({ phase: 'errored', error: { class: 'rate_limit', retryable: true } }),
      ),
    ).toBeNull()
  })

  it('does NOT mint an ask for an idle session that merely ended with a question', () => {
    // The dilution guard: an agent that STOPPED with a question is done, not
    // blocked, and the nudge/inbox machinery already owns that case. Minting
    // rows for it would break "an open interaction means a session is stuck".
    expect(synthesizeAsk(S, state({ phase: 'idle', idle: { kind: 'question' } }))).toBeNull()
    expect(synthesizeAsk(S, state({ phase: 'idle', idle: { kind: 'open_todos' } }))).toBeNull()
    expect(synthesizeAsk(S, state({ phase: 'working' }))).toBeNull()
  })
})

describe('interactionFingerprint', () => {
  const permission = (detail: string): InteractionAskSpec => ({
    kind: 'permission',
    payload: { v: 1, toolName: 'Bash', inputSummary: detail, canAlwaysAllow: false },
  })

  it('collapses two observations of the same ask', () => {
    expect(interactionFingerprint(S, permission('ls'))).toBe(
      interactionFingerprint(S, permission('ls')),
    )
  })

  it('separates genuinely different asks', () => {
    expect(interactionFingerprint(S, permission('ls'))).not.toBe(
      interactionFingerprint(S, permission('rm -rf /')),
    )
  })

  it('separates the same ask on different sessions', () => {
    expect(interactionFingerprint(S, permission('ls'))).not.toBe(
      interactionFingerprint(asSessionId('ses_2'), permission('ls')),
    )
  })

  it('is stable across incidental payload differences the fingerprint excludes', () => {
    // `canAlwaysAllow` is not decision-bearing about WHICH ask this is — the same
    // prompt re-observed with the flag read differently is still one ask.
    const a = interactionFingerprint(S, {
      kind: 'permission',
      payload: { v: 1, toolName: 'Bash', inputSummary: 'ls', canAlwaysAllow: false },
    })
    const b = interactionFingerprint(S, {
      kind: 'permission',
      payload: { v: 1, toolName: 'Bash', inputSummary: 'ls', canAlwaysAllow: true },
    })
    expect(a).toBe(b)
  })
})

describe('normalizeQuestions', () => {
  it('keeps an unreadable menu as one option-less prompt', () => {
    // Still an open ask: the session is blocked either way, and the delivery
    // gate is what refuses to type digits at it.
    expect(normalizeQuestions(undefined, 'Pick one')).toEqual([
      { question: 'Pick one', multiSelect: false, previewLayout: false, options: [] },
    ])
  })

  it('puts the Other row one past the last option, 1-based (the native rule)', () => {
    const [q] = normalizeQuestions(
      [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
      undefined,
    )
    expect(q).toMatchObject({ otherIndex: 3 })
  })

  it('gives a PREVIEW-LAYOUT question no Other row at all', () => {
    // That dialog does not draw one (POD-770); claiming an index would invite
    // an answer that silently selects option 1.
    const [q] = normalizeQuestions(
      [{ question: 'Which?', options: [{ label: 'A', preview: 'x' }, { label: 'B' }] }],
      undefined,
    )
    expect(q).toMatchObject({ previewLayout: true })
    expect(q?.otherIndex).toBeUndefined()
  })

  it('carries the question header through', () => {
    const [q] = normalizeQuestions(
      [{ question: 'Which?', header: 'Database', options: [{ label: 'A' }] }],
      undefined,
    )
    expect(q).toMatchObject({ header: 'Database' })
  })

  it('never sets previewLayout on a multi-select', () => {
    const [q] = normalizeQuestions(
      [{ question: 'Which?', multiSelect: true, options: [{ label: 'A', preview: 'x' }] }],
      undefined,
    )
    expect(q).toMatchObject({ multiSelect: true, previewLayout: false })
  })
})
