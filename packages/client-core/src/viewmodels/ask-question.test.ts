import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  isPreviewLayout,
  latestPendingQuestion,
  optionPreview,
  parseAskQuestions,
  pendingAskFromState,
} from './ask-question'

function ask(id: string, overrides: Partial<TranscriptItem> = {}): TranscriptItem {
  return {
    id,
    role: 'tool',
    text: '',
    toolName: 'AskUserQuestion',
    toolInputJson: JSON.stringify({
      questions: [{ question: 'Which way?', options: [{ label: 'Left' }, { label: 'Right' }] }],
    }),
    ...overrides,
  }
}

describe('ask question view model', () => {
  it('parses questions with options from toolInputJson', () => {
    const questions = parseAskQuestions(ask('q1').toolInputJson)
    expect(questions).toHaveLength(1)
    expect(questions[0]?.options.map((o) => o.label)).toEqual(['Left', 'Right'])
  })

  it('returns empty on malformed input', () => {
    expect(parseAskQuestions('not json')).toEqual([])
    expect(parseAskQuestions(undefined)).toEqual([])
  })

  // POD-770 — mirrors the CLI's own predicate. Getting this wrong in either
  // direction types the wrong script into a live menu: a missed preview commits
  // option 1 over the operator's typed answer, and a false positive presses `n`
  // at a list that has no Notes field.
  it.each([
    ['no previews at all', { options: [{ label: 'Left' }, { label: 'Right' }] }, false],
    [
      'a preview on any option',
      { options: [{ label: 'Left' }, { label: 'R', preview: 'r' }] },
      true,
    ],
    [
      'an empty preview string, which the CLI reads as falsy',
      { options: [{ label: 'L', preview: '' }] },
      false,
    ],
    [
      'a multi-select, which never previews',
      { multiSelect: true, options: [{ label: 'L', preview: 'l' }] },
      false,
    ],
  ])('is %s → %s', (_name, question, expected) => {
    expect(isPreviewLayout(question)).toBe(expected)
  })

  // What to DRAW, as opposed to what dialog is on screen. A blank preview flips
  // the native layout but has nothing in it, so the card must not open a well
  // for it (POD-708).
  it('offers a preview only when there is something to draw', () => {
    const [q] = parseAskQuestions(
      JSON.stringify({
        questions: [
          {
            question: 'Which layout?',
            options: [
              { label: 'Left', preview: 'a\nb' },
              { label: 'Right', preview: '   ' },
              { label: 'Neither' },
            ],
          },
        ],
      }),
    )
    expect(optionPreview(q?.options[0])).toBe('a\nb')
    expect(optionPreview(q?.options[1])).toBeUndefined()
    expect(optionPreview(q?.options[2])).toBeUndefined()
    expect(optionPreview(undefined)).toBeUndefined()
  })

  it('finds the last unanswered question and ignores answered ones', () => {
    const answered = ask('q1', { toolResult: 'User selected "Left"' })
    const pending = ask('q2')
    const items: TranscriptItem[] = [answered, { id: 'm1', role: 'assistant', text: 'ok' }, pending]
    expect(latestPendingQuestion(items)?.id).toBe('q2')
    expect(latestPendingQuestion([answered])).toBeNull()
  })

  // POD-1273 — the window this exists for: Claude Code writes a tool call into
  // its transcript only once the call RESOLVES, so while the agent is actually
  // waiting there is no item and the transcript-derived card draws nothing.
  describe('the question the transcript does not have yet', () => {
    const interview = {
      questions: [{ question: 'Which way?', options: [{ label: 'Left' }, { label: 'Right' }] }],
    }
    const need = { kind: 'question' as const, interview }

    it('synthesizes the block the card already knows how to render', () => {
      const block = pendingAskFromState(need, 'live', 'needs_user', false)
      expect(block).not.toBeNull()
      const questions = parseAskQuestions(block?.item.toolInputJson)
      expect(questions[0]?.question).toBe('Which way?')
      expect(questions[0]?.options.map((o) => o.label)).toEqual(['Left', 'Right'])
      // No result — the card reads that as "still answerable".
      expect(block?.item.toolResult).toBeUndefined()
    })

    it('stands down the moment the transcript has a pending question of its own', () => {
      expect(pendingAskFromState(need, 'live', 'needs_user', true)).toBeNull()
    })

    // The hand-back needs no id matching: answering moves the session out of
    // needs_user, which is the whole condition.
    it('disappears when the wait ends', () => {
      expect(pendingAskFromState(need, 'live', 'working', false)).toBeNull()
      expect(pendingAskFromState(need, 'live', 'idle', false)).toBeNull()
    })

    it('draws nothing for a wait that is not a question, or a session that cannot answer', () => {
      expect(pendingAskFromState({ kind: 'permission' }, 'live', 'needs_user', false)).toBeNull()
      expect(pendingAskFromState(need, 'hibernated', 'needs_user', false)).toBeNull()
      expect(pendingAskFromState(undefined, 'live', 'needs_user', false)).toBeNull()
    })

    // An older daemon reports the wait without the ask. A card with no questions
    // is worse than none — it would claim the operator can act and give them
    // nothing to act on — so the feed keeps its old behaviour there.
    it('draws nothing when the channel carried no questions', () => {
      expect(pendingAskFromState({ kind: 'question' }, 'live', 'needs_user', false)).toBeNull()
      expect(
        pendingAskFromState(
          { kind: 'question', interview: { questions: [] } },
          'live',
          'needs_user',
          false,
        ),
      ).toBeNull()
    })

    it('keeps one identity across restatements so a half-made selection survives', () => {
      const a = pendingAskFromState(need, 'live', 'needs_user', false)
      const b = pendingAskFromState(need, 'live', 'needs_user', false)
      expect(a?.item.id).toBe(b?.item.id)
    })
  })
})
