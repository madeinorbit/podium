import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { latestPendingQuestion, parseAskQuestions } from './askQuestion'

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
    expect(questions[0].options.map((o) => o.label)).toEqual(['Left', 'Right'])
  })

  it('returns empty on malformed input', () => {
    expect(parseAskQuestions('not json')).toEqual([])
    expect(parseAskQuestions(undefined)).toEqual([])
  })

  it('finds the last unanswered question and ignores answered ones', () => {
    const answered = ask('q1', { toolResult: 'User selected "Left"' })
    const pending = ask('q2')
    const items: TranscriptItem[] = [answered, { id: 'm1', role: 'assistant', text: 'ok' }, pending]
    expect(latestPendingQuestion(items)?.id).toBe('q2')
    expect(latestPendingQuestion([answered])).toBeNull()
  })
})
