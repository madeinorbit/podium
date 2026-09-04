/**
 * ANSWERING THE MENU THE ASK READ ITSELF (POD-2414).
 *
 * Every claim here is about the two rules this route inherits from the
 * established delivery gate rather than relaxes: nothing types unless a menu is
 * actually drawn, and nothing types at all unless EVERY choice is expressible.
 */

import { type AgentRuntimeState, asSessionId } from '@podium/model'
import type { QuestionPrompt } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { AnswerChoice, InboxPrincipalReference } from '../sessions/inbox'
import { deliverToNativeMenu, nativeMenuChoices } from './native-menu-delivery'

const S = asSessionId('ses_1')

const PRINCIPAL: InboxPrincipalReference = {
  kind: 'system',
  attribution: { actor: { kind: 'system', job: 'native-menu-test' }, onBehalfOf: null },
  principalRef: 'native-menu-test',
  delegation: null,
}

const prompt = (partial: Partial<QuestionPrompt> = {}): QuestionPrompt => ({
  question: 'Set up auto mode for your environment?',
  multiSelect: false,
  previewLayout: false,
  options: [{ label: 'Set it up' }, { label: "Don't show again" }],
  otherIndex: 3,
  ...partial,
})

const menuUp = (partial: Partial<AgentRuntimeState> = {}): AgentRuntimeState => ({
  phase: 'needs_user',
  since: '2026-08-14T00:00:00.000Z',
  nativeSubagentCount: 0,
  need: { kind: 'question' },
  ...partial,
})

/** Records what reached the keystroke path, so a test can assert that NOTHING
 *  did on every refusal. */
const recorder = (result: { ok: boolean; reason?: string } = { ok: true }) => {
  const typed: AnswerChoice[][] = []
  return {
    typed,
    answer: (input: { choices: AnswerChoice[] }) => {
      typed.push(input.choices)
      return result
    },
  }
}

describe('nativeMenuChoices', () => {
  it('maps a chosen option onto the digit the menu shows', () => {
    const mapped = nativeMenuChoices([prompt()], [{ optionIndices: [2] }])
    expect(mapped).toEqual({ ok: true, choices: [{ optionIndices: [2] }] })
  })

  it('carries the menu SHAPE, because the shape decides the keystrokes', () => {
    // POD-609/POD-770: a multi-select digit only toggles and needs a Tab, and a
    // preview dialog's digit only moves the cursor. Dropping these would type an
    // answer the operator did not give.
    const multi = nativeMenuChoices([prompt({ multiSelect: true })], [{ optionIndices: [1, 2] }])
    expect(multi).toEqual({ ok: true, choices: [{ multiSelect: true, optionIndices: [1, 2] }] })
    const preview = nativeMenuChoices([prompt({ previewLayout: true })], [{ optionIndices: [1] }])
    expect(preview).toEqual({ ok: true, choices: [{ previewLayout: true, optionIndices: [1] }] })
  })

  it('refuses an index the screen does not have', () => {
    // The classifier read two options. A third is an answer to some other menu,
    // and pressing row 3 on THIS one is a decision nobody made.
    const mapped = nativeMenuChoices([prompt()], [{ optionIndices: [3] }])
    expect(mapped.ok).toBe(false)
    expect(mapped.ok === false && mapped.reason).toContain('beyond the 2 option(s)')
  })

  it('refuses free text where the menu drew no Other row', () => {
    const mapped = nativeMenuChoices(
      [prompt({ otherIndex: undefined })],
      [{ optionIndices: [], text: 'something else' }],
    )
    expect(mapped.ok).toBe(false)
    expect(mapped.ok === false && mapped.reason).toContain('no free-text row')
  })

  it('refuses a PARTIAL answer rather than committing the rest', () => {
    // The closing CR commits every prompt the menu holds open, so answering one
    // of two would commit the second on whatever row it was sitting.
    const mapped = nativeMenuChoices([prompt(), prompt()], [{ optionIndices: [1] }])
    expect(mapped.ok).toBe(false)
    expect(mapped.ok === false && mapped.reason).toContain('2 prompt(s)')
  })

  it('refuses an ask with no readable options', () => {
    const mapped = nativeMenuChoices([], [])
    expect(mapped.ok).toBe(false)
  })
})

describe('deliverToNativeMenu', () => {
  it('types at a menu that is on screen', () => {
    const rec = recorder()
    const out = deliverToNativeMenu(
      { getState: () => menuUp(), answer: rec.answer },
      {
        sessionId: S,
        questions: [prompt()],
        selections: [{ optionIndices: [1] }],
        principal: PRINCIPAL,
      },
    )
    expect(out.ok).toBe(true)
    expect(rec.typed).toEqual([[{ optionIndices: [1] }]])
  })

  it('types NOTHING when no menu is drawn', () => {
    const rec = recorder()
    const out = deliverToNativeMenu(
      { getState: () => menuUp({ phase: 'working', need: undefined }), answer: rec.answer },
      {
        sessionId: S,
        questions: [prompt()],
        selections: [{ optionIndices: [1] }],
        principal: PRINCIPAL,
      },
    )
    expect(out).toEqual({ ok: false, reason: 'no menu on screen (phase=working)' })
    expect(rec.typed).toEqual([])
  })

  it('types NOTHING for an idle textual question, where digits become message text', () => {
    const rec = recorder()
    const out = deliverToNativeMenu(
      {
        getState: () => menuUp({ phase: 'idle', need: undefined, idle: { kind: 'question' } }),
        answer: rec.answer,
      },
      {
        sessionId: S,
        questions: [prompt()],
        selections: [{ optionIndices: [1] }],
        principal: PRINCIPAL,
      },
    )
    expect(out.ok).toBe(false)
    expect(rec.typed).toEqual([])
  })

  it('types NOTHING when the mapping refuses', () => {
    const rec = recorder()
    const out = deliverToNativeMenu(
      { getState: () => menuUp(), answer: rec.answer },
      {
        sessionId: S,
        questions: [prompt()],
        selections: [{ optionIndices: [9] }],
        principal: PRINCIPAL,
      },
    )
    expect(out.ok).toBe(false)
    expect(rec.typed).toEqual([])
  })

  it('reports the keystroke path’s own refusal verbatim', () => {
    const rec = recorder({ ok: false, reason: 'session not running' })
    const out = deliverToNativeMenu(
      { getState: () => menuUp(), answer: rec.answer },
      {
        sessionId: S,
        questions: [prompt()],
        selections: [{ optionIndices: [1] }],
        principal: PRINCIPAL,
      },
    )
    expect(out).toEqual({ ok: false, reason: 'session not running' })
  })
})
