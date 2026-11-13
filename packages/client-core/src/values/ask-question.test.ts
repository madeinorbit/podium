import type { TranscriptItem } from '@podium/model'
import { PendingInteractionWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from '../../../harness/src/adapters/claude-code/transcript'
import { TranscriptGraph } from '../conversation/transcript-graph'
import {
  askQuestionAnswerText,
  askQuestionOutcome,
  codexAsyncQuestionReply,
  isChosenOption,
  isPendingAskQuestion,
  isPreviewLayout,
  latestPendingQuestion,
  matchesQuestionInteraction,
  optionPreview,
  parseAskQuestions,
  pendingAskFromState,
} from './ask-question'

it.each([
  ['Choose a plan?\nKeep the cache or reset?', 'Keep', false],
  ['Choose a plan?', 'Keep\nthe cache', false],
  ['Choose a "safe" plan?\nKeep C:\\cache?', 'Keep "warm"\nC:\\cache', true],
] as const)('settles native multiline and escaped answer %j / %j', (question, answer, escaped) => {
  const quoted = (value: string) => (escaped ? JSON.stringify(value) : `"${value}"`)
  const result = `User has answered your questions: ${quoted(question)} = ${quoted(answer)}. You can now continue with the user's answers in mind.`
  const items = [
    ...claudeRecordToItems({
      type: 'assistant',
      uuid: 'call',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'use',
            name: 'AskUserQuestion',
            input: { questions: [{ question, options: [{ label: answer }] }] },
          },
        ],
      },
    }),
    ...claudeRecordToItems({
      type: 'user',
      uuid: 'result',
      message: { content: [{ type: 'tool_result', tool_use_id: 'use', content: result }] },
    }),
  ]
  const graph = new TranscriptGraph(items)
  const block = graph.block(items[0]!.id)!
  expect(askQuestionOutcome(block)).toBe('answered')
  expect(askQuestionAnswerText(block)).toBe(answer)
  expect(graph.pendingQuestionId).toBeUndefined()
  expect(isChosenOption(result, answer)).toBe(true)
  expect(
    askQuestionOutcome({ ...block, result: `Error: answer could not be delivered\n${result}` }),
  ).toBe('failed')
  graph.dispose()
})

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

it('uses only a live native interaction when state announces a question outside the transcript', () => {
  const row = PendingInteractionWire.parse({
    id: 'current',
    sessionId: 'session',
    askedAt: '2026-11-13T12:00:00Z',
    source: 'hook',
    answerable: 'keystroke-emulated',
    fingerprint: 'current',
    kind: 'question',
    status: 'asked',
    payload: {
      v: 1,
      questions: [
        {
          question: 'Current?',
          multiSelect: false,
          previewLayout: false,
          options: [{ label: 'One' }],
        },
      ],
    },
  })
  const announced = pendingAskFromState(undefined, 'live', 'working', false, row)
  expect(announced?.item.toolInputJson).toContain('Current?')
  expect(matchesQuestionInteraction(row, announced?.item.toolInputJson ?? '')).toBe(true)
  expect(
    pendingAskFromState(undefined, 'live', 'working', false, { ...row, answerable: 'structured' }),
  ).toBeNull()
  expect(
    pendingAskFromState(undefined, 'live', 'working', false, {
      ...row,
      source: 'screen-classifier',
    }),
  ).toBeNull()
  expect(
    pendingAskFromState(undefined, 'live', 'working', false, { ...row, status: 'superseded' }),
  ).toBeNull()
})

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

it('keeps an acknowledged async interview pending and builds a correlated chat reply', () => {
  const item = ask('call_async', { toolName: 'request_user_input_async', toolUseId: 'call_async' })
  // The phone's native-menu reader must not offer to answer this via keystrokes.
  expect(latestPendingQuestion([item])).toBeNull()
  expect(isPendingAskQuestion({ item, result: '{"accepted":true}' })).toBe(true)
  expect(isPendingAskQuestion({ item: ask('claude'), result: '{"accepted":true}' })).toBe(false)
  const text = codexAsyncQuestionReply(item, [
    { freeText: 'main, using an isolated branch', otherIndex: 3 },
  ])
  const json = text.split('\n')[1] ?? ''
  expect(JSON.parse(json)).toEqual([
    {
      answer: 'main, using an isolated branch',
      question: 'Which way?',
      questionItemId: '["request_user_input_async","call_async",0]',
    },
  ])
  expect(() => codexAsyncQuestionReply(item, [])).toThrow('unavailable')
})

it.each([
  ['', 'unknown'],
  ['Error: answer could not be delivered', 'failed'],
  [
    "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown.]",
    'unknown',
  ],
  ['{"accepted":true}', 'unknown'],
  ['Unrecognized output', 'unknown'],
  ['User has answered your questions: "Which way?"="Left".', 'answered'],
  ['You answered use another branch', 'answered'],
  ['Left', 'answered'],
  ['{"answers":{"question":"Left"}}', 'answered'],
  ['{"answers":{"question":{"answers":["Left"]}}}', 'answered'],
  ['{"answers":{}}', 'unknown'],
  ['{"answers":{"question":{"answers":[]}}}', 'unknown'],
  ['{"error":"answer could not be delivered","answers":{"question":"Left"}}', 'failed'],
  ['User declined to answer the questions', 'skipped'],
] as const)('classifies question result %s as %s without inventing an answer', (result, outcome) => {
  const block = { item: ask('question'), result }
  expect(askQuestionOutcome(block)).toBe(outcome)
  expect(isPendingAskQuestion(block)).toBe(false)
})

it.each([
  [
    'The user answered your questions: "Which way?"="Medium custom". Continue with the answer.',
    'Medium custom',
  ],
  [
    'User has answered your questions: "Which way?"="Keep \\"warm\\"\\nC:\\\\cache".',
    'Keep "warm"\nC:\\cache',
  ],
  ['User has answered your questions: "Which way?"="Keep\nthe cache".', 'Keep\nthe cache'],
  ['You answered use another branch', 'use another branch'],
  ['You selected "Left"', 'Left'],
  ['Left', 'Left'],
  ['{"answers":{"Which way?":"Medium custom"}}', 'Medium custom'],
  ['{"answers":{"question":{"answers":["Left", "Right"]}}}', 'Left, Right'],
  ['Error: answer could not be delivered', undefined],
  ['User declined to answer the questions', undefined],
  ['Unrecognized output', undefined],
  ['{"accepted":true}', undefined],
] as const)('shows only the classified answer from %j', (result, answer) => {
  expect(askQuestionAnswerText({ item: ask('question'), result })).toBe(answer)
})

it('reads a Codex custom answer and omits its registration acknowledgement', () => {
  const item = ask('async', { toolName: 'request_user_input_async' })
  expect(askQuestionAnswerText({ item, result: '[{"answer":"Medium custom"}]' })).toBe(
    'Medium custom',
  )
  expect(askQuestionAnswerText({ item, result: '{"accepted":true}' })).toBeUndefined()
})

it('refuses a rendered question whose text, options, or layout differs from its interaction', () => {
  const row = PendingInteractionWire.parse({
    id: 'ask:new',
    sessionId: 'session',
    askedAt: '2026-09-18T00:00:00.000Z',
    source: 'screen-classifier',
    answerable: 'keystroke-emulated',
    fingerprint: 'runtime:ask:new',
    kind: 'question',
    status: 'asked',
    payload: {
      v: 1,
      questions: [
        {
          question: 'Pick',
          multiSelect: false,
          previewLayout: false,
          options: [{ label: 'One' }, { label: 'Two' }],
        },
      ],
    },
  })
  const raw = (
    question = 'Pick',
    options = [{ label: 'One' }, { label: 'Two' }],
    multiSelect = false,
  ) => JSON.stringify({ questions: [{ question, options, multiSelect }] })
  expect(matchesQuestionInteraction(row, raw())).toBe(true)
  expect(matchesQuestionInteraction(row, raw('Old question'))).toBe(false)
  expect(matchesQuestionInteraction(row, raw('Pick', [{ label: 'Old choice' }]))).toBe(false)
  expect(matchesQuestionInteraction(row, raw('Pick', undefined, true))).toBe(false)
  expect(matchesQuestionInteraction({ ...row, status: 'superseded' }, raw())).toBe(false)
})
