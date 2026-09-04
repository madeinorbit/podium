/**
 * Answer resolution and the default answer table (POD-2020).
 *
 * The claims here are about what an operator's words MEAN against a specific
 * ask, which is the layer that stands between free text and digits landing on a
 * PTY. Where it refuses matters as much as where it resolves.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_ANSWERS, defaultAnswerFor, describeAnswer, resolveAnswerText } from './answers'
import type { InteractionAskSpec } from './synthesis'

const permission = (canAlwaysAllow: boolean): InteractionAskSpec => ({
  kind: 'permission',
  payload: { v: 1, toolName: 'Bash', inputSummary: 'ls', canAlwaysAllow },
})

const question = (
  options: string[],
  extra: { multiSelect?: boolean; otherIndex?: number; previewLayout?: boolean } = {},
): InteractionAskSpec => ({
  kind: 'question',
  payload: {
    v: 1,
    questions: [
      {
        question: 'Which database?',
        multiSelect: extra.multiSelect ?? false,
        previewLayout: extra.previewLayout ?? false,
        options: options.map((label) => ({ label })),
        ...(extra.otherIndex !== undefined ? { otherIndex: extra.otherIndex } : {}),
      },
    ],
  },
})

describe('resolveAnswerText — permission', () => {
  it('reads the three decisions', () => {
    expect(resolveAnswerText(permission(false), 'yes')).toEqual({
      ok: true,
      answer: { kind: 'permission', decision: 'allow-once' },
    })
    expect(resolveAnswerText(permission(false), 'deny')).toEqual({
      ok: true,
      answer: { kind: 'permission', decision: 'deny' },
    })
    expect(resolveAnswerText(permission(true), 'always')).toEqual({
      ok: true,
      answer: { kind: 'permission', decision: 'allow-always' },
    })
  })

  it('REFUSES allow-always when the prompt never offered one', () => {
    // The load-bearing case: downgrading to allow-once would report a persistent
    // grant that was never made.
    const r = resolveAnswerText(permission(false), 'always')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('did not offer an always-allow')
  })

  it('refuses a word it cannot read rather than guessing at consent', () => {
    const r = resolveAnswerText(permission(false), 'maybe')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('allow, always, or deny')
  })
})

describe('resolveAnswerText — question', () => {
  it('resolves a digit, an exact label, and a unique substring', () => {
    for (const input of ['1', 'Postgres', 'postg']) {
      expect(resolveAnswerText(question(['Postgres', 'SQLite']), input)).toEqual({
        ok: true,
        answer: { kind: 'question', selections: [{ optionIndices: [1] }] },
      })
    }
  })

  it('keeps every index on a multi-select and only the first on a single-select', () => {
    expect(
      resolveAnswerText(question(['A', 'B', 'C'], { multiSelect: true }), '1,3'),
    ).toMatchObject({ answer: { selections: [{ optionIndices: [1, 3] }] } })
    expect(resolveAnswerText(question(['A', 'B', 'C']), '1,3')).toMatchObject({
      answer: { selections: [{ optionIndices: [1] }] },
    })
  })

  it('routes unmatched text to the Other row when the menu drew one', () => {
    expect(resolveAnswerText(question(['Postgres', 'Other'], { otherIndex: 2 }), 'DuckDB')).toEqual(
      {
        ok: true,
        answer: { kind: 'question', selections: [{ optionIndices: [2], text: 'DuckDB' }] },
      },
    )
  })

  it('REFUSES free text on a preview-layout question — it has no Other row', () => {
    // POD-770: in that dialog a digit only moves the cursor and the closing CR
    // commits whatever is highlighted, so routing text through `otherIndex`
    // selects option 1 and throws the text away. Fail closed instead.
    const r = resolveAnswerText(
      question(['Expand', 'Rebuild'], { previewLayout: true, otherIndex: 3 }),
      'Something else',
    )
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('no Other row')
  })

  it('refuses unmatched text with the options listed, when there is no Other', () => {
    const r = resolveAnswerText(question(['Postgres', 'SQLite']), 'DuckDB')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('1) Postgres, 2) SQLite')
  })

  it('refuses an option-less prompt rather than typing at an unreadable menu', () => {
    const r = resolveAnswerText(question([]), '1')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('no readable options')
  })
})

describe('resolveAnswerText — the other kinds', () => {
  const plan: InteractionAskSpec = {
    kind: 'plan-approval',
    payload: { v: 1, plan: 'Rewrite it', autoAcceptOffered: true },
  }

  it('takes prose at a plan as redirection, not as an unreadable answer', () => {
    expect(resolveAnswerText(plan, 'Split step 2 first')).toEqual({
      ok: true,
      answer: { kind: 'plan-approval', decision: 'reject', feedback: 'Split step 2 first' },
    })
  })

  it('carries auto-accept only when the harness offered it', () => {
    expect(resolveAnswerText(plan, 'always')).toMatchObject({
      answer: { decision: 'approve', autoAcceptEdits: true },
    })
    const notOffered: InteractionAskSpec = {
      kind: 'plan-approval',
      payload: { v: 1, plan: 'Rewrite it', autoAcceptOffered: false },
    }
    expect(resolveAnswerText(notOffered, 'always')).toEqual({
      ok: true,
      answer: { kind: 'plan-approval', decision: 'approve' },
    })
  })

  it('takes a login answer as a report and never as a credential', () => {
    expect(
      resolveAnswerText(
        { kind: 'login', payload: { v: 1, provider: 'anthropic', reason: 'auth-expired' } },
        'done',
      ),
    ).toEqual({
      ok: true,
      answer: { kind: 'login', outcome: 'completed' },
    })
  })

  it('accepts only the recovery choices this harness offered', () => {
    const ask: InteractionAskSpec = {
      kind: 'recovery',
      payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: ['summary-resume'] },
    }
    expect(resolveAnswerText(ask, 'summary')).toMatchObject({
      answer: { choice: 'summary-resume' },
    })
    const r = resolveAnswerText(ask, 'full-resume')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('summary-resume')
  })

  it('refuses free text at an elicitation — a form is not a sentence', () => {
    const ask: InteractionAskSpec = {
      kind: 'elicitation',
      payload: { v: 1, message: 'Your name?', requestedSchema: { type: 'object' } },
    }
    expect(resolveAnswerText(ask, 'Ada')).toMatchObject({ ok: false })
    expect(resolveAnswerText(ask, 'decline')).toEqual({
      ok: true,
      answer: { kind: 'elicitation', action: 'decline' },
    })
  })
})

describe('the default answer table', () => {
  it('holds recovery → full-resume, and NOTHING for permission or plan-approval', () => {
    // The absence is the security property: a table that auto-allowed
    // permissions would be a consent decision made by a default value.
    expect(DEFAULT_ANSWERS.recovery).toEqual({ kind: 'recovery', choice: 'full-resume' })
    expect(DEFAULT_ANSWERS.permission).toBeUndefined()
    expect(DEFAULT_ANSWERS['plan-approval']).toBeUndefined()
    expect(DEFAULT_ANSWERS.login).toBeUndefined()
  })

  it('falls back to summary-resume only when no full path is offered', () => {
    const offered = (choices: string[]): InteractionAskSpec => ({
      kind: 'recovery',
      payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: choices as never },
    })
    expect(defaultAnswerFor(offered(['full-resume', 'summary-resume']))).toMatchObject({
      choice: 'full-resume',
    })
    expect(defaultAnswerFor(offered(['summary-resume']))).toMatchObject({
      choice: 'summary-resume',
    })
    // Nothing usable offered → no default, and the ask escalates.
    expect(defaultAnswerFor(offered(['abandon']))).toBeNull()
  })

  it('has no default for a permission ask', () => {
    expect(defaultAnswerFor(permission(true))).toBeNull()
  })
})

describe('describeAnswer', () => {
  it('renders every kind', () => {
    expect(describeAnswer({ kind: 'permission', decision: 'allow-once' })).toBe('allow-once')
    expect(describeAnswer({ kind: 'question', selections: [{ optionIndices: [1, 2] }] })).toBe(
      '1+2',
    )
    expect(
      describeAnswer({ kind: 'plan-approval', decision: 'approve', autoAcceptEdits: true }),
    ).toBe('approve (auto-accept edits)')
    expect(describeAnswer({ kind: 'recovery', choice: 'full-resume' })).toBe('full-resume')
  })
})
