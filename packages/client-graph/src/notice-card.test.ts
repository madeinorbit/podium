import { pendingInteractionCard as coreCard } from '@podium/client-core/values'
import { asSessionId } from '@podium/model'
import type { PendingInteractionWire, QuestionPrompt } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { pendingInteractionCard as graphCard } from './notice-card'

const question: QuestionPrompt = {
  question: 'Which database?',
  multiSelect: false,
  previewLayout: false,
  options: [{ label: 'Postgres' }, { label: 'SQLite' }],
}

const origins = [
  {
    name: 'transcript',
    source: 'hook',
    answerable: 'keystroke-emulated',
    surface: 'transcript',
    destination: 'conversation',
  },
  {
    name: 'screen classifier',
    source: 'screen-classifier',
    answerable: 'keystroke-emulated',
    surface: 'aggregate',
    destination: 'terminal',
  },
  {
    name: 'structured protocol',
    source: 'protocol',
    answerable: 'structured',
    surface: 'aggregate',
    destination: 'requesting tool',
  },
] as const

const forms: { name: string; questions: QuestionPrompt[]; pressable: boolean }[] = [
  { name: 'single question', questions: [question], pressable: true },
  {
    name: 'two questions',
    questions: [question, { ...question, question: 'Which region?' }],
    pressable: false,
  },
  {
    name: 'preview',
    questions: [
      { ...question, previewLayout: true, options: [{ label: 'A', preview: 'Layout A' }] },
    ],
    pressable: false,
  },
  { name: 'multiselect', questions: [{ ...question, multiSelect: true }], pressable: false },
]

describe.each([
  { name: 'pool projection', project: graphCard },
  { name: 'client-core projection', project: coreCard },
])('$name question cards', ({ project }) => {
  for (const origin of origins) {
    const row = (questions: QuestionPrompt[]): PendingInteractionWire => ({
      id: 'question-1',
      sessionId: asSessionId('session-1'),
      kind: 'question',
      status: 'asked',
      source: origin.source,
      answerable: origin.answerable,
      askedAt: '2026-10-25T12:00:00Z',
      fingerprint: 'question-1',
      payload: { v: 1, questions },
    })

    it.each(forms)(`${origin.name}: readable $name keeps its owner and generic answer limits`, ({
      questions,
      pressable,
    }) => {
      const card = project(row(questions))
      expect(card.surface).toBe(origin.surface)
      expect(card.detail).toBe(questions.map((q) => q.question).join(' / '))
      expect(card.note ?? '').not.toContain('could not read')
      if (pressable) {
        expect(card.note).toBeUndefined()
        expect(card.actions.map((action) => action.label)).toEqual(['Postgres', 'SQLite'])
        expect(card.actions[0]?.answer).toEqual({
          kind: 'question',
          selections: [{ optionIndices: [1] }],
        })
      } else {
        expect(card.actions).toEqual([])
        expect(card.note).toContain(origin.destination)
        if (origin.answerable === 'structured') expect(card.note).not.toContain('terminal')
      }
    })

    it.each([
      { name: 'no questions', questions: [] },
      { name: 'no options', questions: [{ ...question, options: [] }] },
      {
        name: 'a later question missing options',
        questions: [question, { ...question, options: [] }],
      },
    ])(`${origin.name}: $name keeps the unreadable fallback`, ({ questions }) => {
      const card = project(row(questions))
      expect(card.surface).toBe('aggregate')
      expect(card.actions).toEqual([])
      expect(card.note).toContain('could not read')
    })
  }
})
