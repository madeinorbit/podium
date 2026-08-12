import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { isPreviewLayout, latestPendingQuestion, parseAskQuestions } from './ask-question'

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

  it('finds the last unanswered question and ignores answered ones', () => {
    const answered = ask('q1', { toolResult: 'User selected "Left"' })
    const pending = ask('q2')
    const items: TranscriptItem[] = [answered, { id: 'm1', role: 'assistant', text: 'ok' }, pending]
    expect(latestPendingQuestion(items)?.id).toBe('q2')
    expect(latestPendingQuestion([answered])).toBeNull()
  })
})
