import { reaction } from 'mobx'
import { TranscriptLog, type TranscriptLogOptions } from './transcript-log'
const createTranscriptLog = (options: TranscriptLogOptions) => new TranscriptLog(options)
import { asSessionId, type TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { insideReader, measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { latestPendingQuestion } from '../values/ask-question'
import { pairLatestPromptAndAnswer } from '../values/handoff'
import { parseEnvelopeBatch } from '../values/message-envelope'
import {
  type TranscriptSourceOptions,
  type TranscriptPage,
  type TranscriptSource,
} from '../transcript/contracts'

const cursor = (offset: number) =>
  Buffer.from(JSON.stringify(['file', offset, `id${offset}`, 0])).toString('base64url')
const row = (
  id: string,
  role: TranscriptItem['role'],
  offset: number,
  extra: Partial<TranscriptItem> = {},
): TranscriptItem => ({ id, role, cursor: cursor(offset), text: id, ...extra })
const ask = (id: string, offset: number, answered = false) =>
  row(id, 'tool', offset, {
    text: '',
    toolName: 'AskUserQuestion',
    toolInputJson: '{"questions":[]}',
    ...(answered ? { toolResult: 'Answered' } : {}),
  })

async function fixture(
  items: TranscriptItem[],
  initialLimit = 1024,
  retainHistory = true,
  questions?: TranscriptSourceOptions['questions'],
  collapseMachineContext = false,
) {
  let page: TranscriptPage = { items, head: 'head', tail: items.at(-1)?.cursor, hasMore: true }
  let listener: Parameters<TranscriptSource['subscribe']>[2] | undefined
  const source: TranscriptSource = {
    read: async () => page,
    subscribe: (_id, _since, next) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
  }
  const controller = createTranscriptLog({
    sessionId: asSessionId('facts'),
    source,
    initialLimit,
    retainHistory: () => retainHistory,
    visible: () => false,
    questions,
    collapseMachineContext,
  })
  await controller.start()
  return {
    controller,
    emit: (next: TranscriptItem[], reset = false) => listener?.(next, { reset }),
    page: (next: TranscriptPage) => {
      page = next
    },
  }
}

it('answers raw question, prompt and item facts without scanning retained rows at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    let roleReads = 0
    const items = [
      row('prompt', 'user', 0, { text: '  Original prompt\n' }),
      ask('question', 1),
      ...Array.from({ length: 128 * scale }, (_, index) =>
        row(`a${index}`, 'assistant', index + 2),
      ),
    ].map((item) => ({
      ...item,
      get role() {
        roleReads++
        return item.role
      },
    }))
    const f = await fixture(items)
    const get = f.controller.getItem.bind(f.controller)
    let pointReads = 0
    f.controller.getItem = (id) => {
      pointReads++
      return get(id)
    }
    const measure = async (action: () => void) => {
      roleReads = 0
      pointReads = 0
      const result = await measureWork(async () => insideReader('raw transcript fact', action))
      return { work: result.work, roleReads, pointReads }
    }
    try {
      let prompt: string | null = null,
        question: TranscriptItem | null = null,
        found: TranscriptItem | undefined
      const promptRead = await measure(() => {
        prompt = f.controller.latestOperatorPrompt
      })
      expect(prompt).toBe('  Original prompt\n')
      expect(f.controller.latestOperatorPrompt).toBe(prompt)
      const questionRead = await measure(() => {
        question = f.controller.pendingQuestion
      })
      expect(question).toBe(items[1])
      expect(f.controller.pendingQuestion).toBe(question)
      const itemRead = await measure(() => {
        found = f.controller.getItem('prompt')
      })
      expect(found).toBe(items[0])
      const absent = await measure(() => {
        found = f.controller.getItem('absent')
      })
      expect(found).toBeUndefined()
      const control = await measure(() => {
        latestPendingQuestion(f.controller.items)
      })
      expect(control.roleReads).toBe(128 * scale + 1)
      const actions = { promptRead, questionRead, itemRead, absent }
      for (const result of Object.values(actions)) {
        expect(result.roleReads).toBe(0)
        expect(result.pointReads).toBe(result === promptRead || result === questionRead ? 0 : 1)
        expect(result.work).toMatchObject({ derivations: 1, elements: 0, visits: 0 })
      }
      samples.push({ scale, actions, control })
    } finally {
      f.controller.getItem = get
      f.controller.dispose()
    }
  }
  expect(samples[1]!.actions).toEqual(samples[0]!.actions)
  expect(samples[1]!.control.roleReads).toBeGreaterThan(samples[0]!.control.roleReads * 3)
  console.log('[raw transcript facts work1x4x]', JSON.stringify(samples))
})

it('preserves answered latest questions, role edits, blank prompts and repeated IDs in atomic frames', async () => {
  const f = await fixture([row('u1', 'user', 1), ask('q1', 2), row('u2', 'user', 3), ask('q2', 4)])
  try {
    expect(f.controller.latestOperatorPrompt).toBe('u2')
    expect(f.controller.pendingQuestion?.id).toBe('q2')
    f.emit([ask('q2', 4, true)])
    expect(f.controller.pendingQuestion).toBeNull()
    expect(f.controller.pendingQuestion).toBeNull()
    f.emit([row('u2', 'user', 3, { text: '   ' }), row('q2', 'assistant', 4)])
    expect(f.controller.latestOperatorPrompt).toBe('u1')
    expect(f.controller.pendingQuestion?.id).toBe('q1')
    f.emit([ask('q3', 5), ask('q3', 5, true)])
    expect(f.controller.pendingQuestion).toBeNull()
    f.emit([row('q3', 'user', 5, { text: '  New original\n' })])
    expect(f.controller.latestOperatorPrompt).toBe('  New original\n')
    expect(f.controller.pendingQuestion?.id).toBe('q1')
    expect(f.controller.latestOperatorPrompt).toBe('  New original\n')
    expect(f.controller.pendingQuestion?.id).toBe('q1')
  } finally {
    f.controller.dispose()
  }
})

it('keeps raw-order winners across out-of-order frames, prepend and authoritative reset', async () => {
  const f = await fixture([row('u', 'user', 10), ask('q', 20), row('a', 'assistant', 30)])
  try {
    f.emit([ask('older', 15), row('earlier', 'user', 5)])
    expect(f.controller.latestOperatorPrompt).toBe('u')
    expect(f.controller.pendingQuestion?.id).toBe('q')
    f.page({ items: [ask('oldest', 1), row('old-prompt', 'user', 2)], head: 'old', hasMore: false })
    await f.controller.loadOlder()
    expect(f.controller.pendingQuestion).toBe(latestPendingQuestion(f.controller.items))
    expect(f.controller.latestOperatorPrompt).toBe('u')
    f.page({ items: [], hasMore: false })
    f.emit([], true)
    expect(f.controller.pendingQuestion).toBeNull()
    expect(f.controller.latestOperatorPrompt).toBeNull()
    expect(f.controller.getItem('q')).toBeUndefined()
    await Promise.resolve()
  } finally {
    f.controller.dispose()
  }
})

it('drops trimmed facts and restores them only when their raw history returns', async () => {
  const f = await fixture([row('prompt', 'user', 1), ask('question', 2)], 2, false)
  try {
    f.emit(Array.from({ length: 5 }, (_, index) => row(`a${index}`, 'assistant', index + 3)))
    expect(f.controller.items).toHaveLength(4)
    expect(f.controller.latestOperatorPrompt).toBeNull()
    expect(f.controller.pendingQuestion).toBeNull()
    f.page({ items: [row('prompt', 'user', 1), ask('question', 2)], head: 'old', hasMore: false })
    await f.controller.loadOlder()
    expect(f.controller.latestOperatorPrompt).toBe('prompt')
    expect(f.controller.pendingQuestion?.id).toBe('question')
  } finally {
    f.controller.dispose()
  }
})

it('answers echo membership and latest raw time with no retained-row reads at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    let roleReads = 0,
      timeReads = 0
    const items = [
      row('echo', 'user', 1, { text: '  Same prompt  ', toolPaths: ['/a', '/b'] }),
      ...Array.from({ length: 128 * scale }, (_, index) =>
        row(`a${index}`, 'assistant', index + 2),
      ),
    ].map((item) => ({
      ...item,
      get role() {
        roleReads++
        return item.role
      },
      get ts() {
        timeReads++
        return '2026-09-29T01:30:00.000Z'
      },
    }))
    const f = await fixture(items, 1024, true, ['userEcho', 'latestRecordedAt'])
    try {
      roleReads = 0
      timeReads = 0
      let answers: boolean[] = []
      let latest: number | null = null
      const result = await measureWork(async () =>
        insideReader('raw transcript echo and time', () => {
          answers = [
            f.controller.hasUserEcho('Same prompt'),
            f.controller.hasUserEcho('other', ['/a', '/b']),
            f.controller.hasUserEcho('Same prompt', ['/b', '/a']),
            f.controller.hasUserEcho('absent'),
          ]
          latest = f.controller.latestRecordedAt
        }),
      )
      expect(answers).toEqual([true, true, false, false])
      expect(latest).toBe(Date.parse('2026-09-29T01:30:00.000Z'))
      expect(roleReads).toBe(0)
      expect(timeReads).toBe(0)
      const action = { roleReads, timeReads, work: result.work }
      const control = await measureWork(async () =>
        insideReader('former raw failure check', () => {
          items.some(
            (item) =>
              item.ts !== undefined && Date.parse(item.ts) > Date.parse('2026-09-29T01:31:00.000Z'),
          )
        }),
      )
      expect(timeReads).toBe(items.length * 2)
      samples.push({ scale, action, control: { timeReads, work: control.work } })
    } finally {
      f.controller.dispose()
    }
  }
  expect(samples[1]!.action).toEqual(samples[0]!.action)
  expect(samples[1]!.control.timeReads).toBeGreaterThan(samples[0]!.control.timeReads * 3)
  console.log('[raw transcript echo and time work1x4x]', JSON.stringify(samples))
})

it('maintains duplicate echo counts, ordered path identity and raw timestamp edits through reset and trim', async () => {
  const f = await fixture(
    [
      row('u1', 'user', 1, { text: ' same ', toolPaths: ['a,b'], ts: '2026-09-29T01:35:00.000Z' }),
      row('u2', 'user', 2, { text: 'same', toolPaths: ['a', 'b'], ts: '2026-09-29T01:32:00.000Z' }),
      row('t', 'tool', 3, { ts: '2026-09-29T01:34:00.000Z' }),
    ],
    2,
    false,
    ['userEcho', 'latestRecordedAt'],
  )
  try {
    expect(f.controller.hasUserEcho('same')).toBe(true)
    expect(f.controller.hasUserEcho('other', ['a,b'])).toBe(true)
    expect(f.controller.hasUserEcho('other', ['a', 'b'])).toBe(true)
    f.emit([row('u1', 'assistant', 1, { ts: '2026-09-29T01:31:00.000Z' })])
    expect(f.controller.hasUserEcho('same')).toBe(true)
    expect(f.controller.hasUserEcho('other', ['a,b'])).toBe(false)
    expect(f.controller.latestRecordedAt).toBe(Date.parse('2026-09-29T01:34:00.000Z'))
    f.emit([
      row('t', 'tool', 3, { ts: 'invalid' }),
      row('u2', 'user', 2, { text: 'new', toolPaths: ['b', 'a'] }),
    ])
    expect(f.controller.hasUserEcho('same')).toBe(false)
    expect(f.controller.hasUserEcho('new')).toBe(true)
    expect(f.controller.hasUserEcho('other', ['a', 'b'])).toBe(false)
    expect(f.controller.hasUserEcho('other', ['b', 'a'])).toBe(true)
    expect(f.controller.latestRecordedAt).toBe(Date.parse('2026-09-29T01:31:00.000Z'))
    f.emit(Array.from({ length: 5 }, (_, index) => row(`tail${index}`, 'assistant', index + 4)))
    expect(f.controller.hasUserEcho('new')).toBe(false)
    expect(f.controller.latestRecordedAt).toBeNull()
    f.page({
      items: [row('old', 'user', 0, { text: 'restored', ts: '2026-09-29T01:36:00.000Z' })],
      hasMore: false,
    })
    await f.controller.loadOlder()
    expect(f.controller.hasUserEcho('restored')).toBe(true)
    expect(f.controller.latestRecordedAt).toBe(Date.parse('2026-09-29T01:36:00.000Z'))
    f.page({ items: [], hasMore: false })
    f.emit([], true)
    expect(f.controller.hasUserEcho('restored')).toBe(false)
    expect(f.controller.latestRecordedAt).toBeNull()
  } finally {
    f.controller.dispose()
  }
})

it('does not maintain undeclared echo or timestamp questions', async () => {
  let timeReads = 0,
    pathReads = 0
  const item: TranscriptItem = {
    id: 'u',
    role: 'user',
    text: 'prompt',
    get ts() {
      timeReads++
      return '2026-09-29T01:30:00.000Z'
    },
    get toolPaths() {
      pathReads++
      return ['/a']
    },
  }
  const f = await fixture([item], 1024, true, [])
  try {
    expect(timeReads).toBe(0)
    expect(pathReads).toBe(0)
    expect(f.controller.latestRecordedAt).toBeNull()
    expect(() => f.controller.hasUserEcho('prompt')).toThrow('must declare')
  } finally {
    f.controller.dispose()
  }
})

describe('latest handoff pair (POD-5652)', () => {
  const sid = asSessionId('facts')
  const promptOptions = (collapseMachineContext: boolean) => ({
    collapseMachineContext,
    operatorTextOf: (text: string) => parseEnvelopeBatch(text)?.operatorText,
  })
  const norm = (pair: {
    prompt: { item: TranscriptItem; anchor: { itemKey: string } }
    answer?: { item: TranscriptItem; anchor: { itemKey: string }; legacy: boolean }
  } | null) =>
    pair
      ? {
          prompt: pair.prompt.item.id,
          text: pair.prompt.item.text,
          promptKey: pair.prompt.anchor.itemKey,
          answer: pair.answer?.item.id,
          legacy: pair.answer?.legacy,
          answerKey: pair.answer?.anchor.itemKey,
        }
      : null
  const scenarios: Array<{ name: string; items: TranscriptItem[] }> = [
    {
      name: 'marked answer',
      items: [
        row('prompt', 'user', 1, { text: 'Do it' }),
        row('working', 'assistant', 2, { text: 'working' }),
        row('answer', 'assistant', 3, { text: 'done', answer: true }),
      ],
    },
    {
      name: 'legacy trailing turn',
      items: [
        row('prompt', 'user', 1, { text: 'Question' }),
        row('reply-1', 'assistant', 2, { text: 'first' }),
        row('reply-2', 'assistant', 3, { text: 'latest' }),
      ],
    },
    {
      name: 'latest turn only',
      items: [
        row('old-prompt', 'user', 1, { text: 'old' }),
        row('old-answer', 'assistant', 2, { text: 'old done', answer: true }),
        row('prompt', 'user', 3, { text: 'new' }),
        row('narration', 'assistant', 4, { text: 'working' }),
        row('answer', 'assistant', 5, { text: 'new done', answer: true }),
      ],
    },
    {
      name: 'markers before the prompt win nothing',
      items: [
        row('old-answer', 'assistant', 1, { text: 'old done', answer: true }),
        row('prompt', 'user', 2, { text: 'new' }),
        row('narration', 'assistant', 3, { text: 'working' }),
      ],
    },
    {
      name: 'machine seed last',
      items: [
        row('prompt', 'user', 1, { text: 'real' }),
        row('seed', 'user', 2, { text: '[CONCIERGE CONTEXT seed]' }),
        row('answer', 'assistant', 3, { text: 'done', answer: true }),
      ],
    },
    {
      name: 'envelope operator text',
      items: [
        row('prompt', 'user', 1, {
          text: '[podium message msg_1 · from issue:POD-1 · to your session · reply: podium mail reply msg_1]\ninternal\n[end podium message msg_1]latest',
        }),
        row('answer', 'assistant', 2, { text: 'done', answer: true }),
      ],
    },
    {
      name: 'no prompt',
      items: [row('a1', 'assistant', 1, { text: 'one' }), row('a2', 'assistant', 2, { text: 'two' })],
    },
    {
      name: 'prompt without answer',
      items: [row('a0', 'assistant', 1, { text: 'earlier' }), row('prompt', 'user', 2, { text: 'Q' })],
    },
  ]

  for (const collapse of [false, true]) {
    it(`matches pairLatestPromptAndAnswer across handoff shapes (collapse=${collapse})`, async () => {
      for (const scenario of scenarios) {
        const items = scenario.items.map((item) => ({ ...item }))
        const f = await fixture(items, 1024, true, undefined, collapse)
        try {
          const expected = pairLatestPromptAndAnswer(sid, items, promptOptions(collapse))
          expect(norm(f.controller.latestHandoffPair), scenario.name).toEqual(norm(expected))
          if (scenario.name === 'machine seed last') {
            expect(f.controller.latestHandoffPair?.prompt.item.id, scenario.name).toBe(
              collapse ? 'prompt' : 'seed',
            )
          }
          if (scenario.name === 'envelope operator text') {
            expect(f.controller.latestHandoffPair?.prompt.item.text).toBe('latest')
          }
          f.emit([row('tail', 'assistant', 10, { text: 'tail' })])
          const after = pairLatestPromptAndAnswer(
            sid,
            [...items, f.controller.getItem('tail')!],
            promptOptions(collapse),
          )
          expect(norm(f.controller.latestHandoffPair), `${scenario.name} after tail`).toEqual(
            norm(after),
          )
        } finally {
          f.controller.dispose()
        }
      }
    })
  }

  it('ignores interrupts and blanks, and keeps the pair reference quiet on unrelated frames', async () => {
    const f = await fixture([
      row('prompt', 'user', 1, { text: 'real' }),
      row('interrupt', 'user', 2, { text: 'stop', event: 'interrupt' }),
      row('blank', 'user', 3, { text: '   ' }),
      row('answer', 'assistant', 4, { text: 'done', answer: true }),
    ])
    try {
      const pair = f.controller.latestHandoffPair
      expect(pair?.prompt.item.id).toBe('prompt')
      expect(pair?.answer?.item.id).toBe('answer')
      f.emit([row('answer', 'assistant', 4, { text: 'done, edited', answer: true })])
      // The answer version changed, so the pair reforms around the new item.
      expect(f.controller.latestHandoffPair).not.toBe(pair)
      expect(f.controller.latestHandoffPair?.answer?.item.text).toBe('done, edited')
      const current = f.controller.latestHandoffPair
      f.emit([row('note', 'assistant', 5, { text: 'side note' })])
      // A marked pair ignores trailing prose: same reference, no observer wake.
      expect(f.controller.latestHandoffPair).toBe(current)
    } finally {
      f.controller.dispose()
    }
  })

  it('moves the pair to a newer prompt and forms it from an older page when missing', async () => {
    const f = await fixture([row('answer', 'assistant', 30, { text: 'orphan', answer: true })])
    try {
      expect(f.controller.latestHandoffPair).toBeNull()
      f.page({
        items: [
          row('prompt', 'user', 10, { text: 'older question' }),
          row('context', 'assistant', 20, { text: 'context' }),
        ],
        head: 'old',
        hasMore: false,
      })
      await f.controller.loadOlder()
      expect(f.controller.latestHandoffPair?.prompt.item.id).toBe('prompt')
      expect(f.controller.latestHandoffPair?.answer?.item.id).toBe('answer')
      const formed = f.controller.latestHandoffPair
      f.emit([row('prompt-2', 'user', 40, { text: 'newer' })])
      expect(f.controller.latestHandoffPair?.prompt.item.id).toBe('prompt-2')
      expect(f.controller.latestHandoffPair?.answer).toBeUndefined()
      expect(f.controller.latestHandoffPair).not.toBe(formed)
    } finally {
      f.controller.dispose()
    }
  })

  it('drops the pair with a trimmed prompt and restores it from the page', async () => {
    const items = [
      row('prompt', 'user', 1, { text: 'question' }),
      ...Array.from({ length: 20 }, (_, index) =>
        row(`a${index}`, 'assistant', index + 2, { text: `line ${index}` }),
      ),
    ]
    const f = await fixture(items, 8, false)
    try {
      expect(f.controller.latestHandoffPair?.prompt.item.id).toBe('prompt')
      f.emit([row('fresh', 'assistant', 30, { text: 'fresh' })])
      expect(f.controller.latestHandoffPair).toBeNull()
      f.page({
        items: [row('prompt', 'user', 1, { text: 'question' })],
        head: 'older',
        hasMore: false,
      })
      await f.controller.loadOlder()
      expect(f.controller.latestHandoffPair?.prompt.item.id).toBe('prompt')
    } finally {
      f.controller.dispose()
    }
  })

  it('holds open, new-message and older-page reads flat at 1x/4x history', async () => {
    const samples = []
    for (const scale of [1, 4] as const) {
      let fieldReads = 0
      const counted = (raw: Record<string, unknown>): TranscriptItem => {
        const out: Record<string, unknown> = {}
        for (const key of ['role', 'text', 'answer', 'cursor', 'id', 'event'] as const) {
          Object.defineProperty(out, key, {
            enumerable: true,
            get() {
              fieldReads++
              return raw[key]
            },
          })
        }
        for (const key of Object.keys(raw)) {
          if (!(key in out)) out[key] = raw[key]
        }
        return out as unknown as TranscriptItem
      }
      const at = (offset: number) =>
        Buffer.from(JSON.stringify(['file', offset, `id${offset}`, 0])).toString('base64url')
      const held = [
        counted({ id: 'prompt', role: 'user', text: 'Hand me the status.', cursor: at(1000) }),
        ...Array.from({ length: 128 * scale }, (_, index) =>
          counted({
            id: `a${index}`,
            role: 'assistant',
            text: `progress line ${index}`,
            cursor: at(1001 + index),
          }),
        ),
        counted({
          id: 'answer',
          role: 'assistant',
          text: 'Finished.',
          answer: true,
          cursor: at(1001 + 128 * scale),
        }),
      ]
      const f = await fixture(held, 4096, true)
      try {
        const pair = f.controller.latestHandoffPair
        expect(pair?.prompt.item.id).toBe('prompt')
        expect(pair?.answer?.item.id).toBe('answer')
        fieldReads = 0
        const opened = f.controller.latestHandoffPair
        const openReads = fieldReads
        fieldReads = 0
        f.emit([
          counted({
            id: 'new',
            role: 'assistant',
            text: 'one more line',
            cursor: at(1002 + 128 * scale),
          }),
        ])
        const afterNew = f.controller.latestHandoffPair
        const newReads = fieldReads
        f.page({
          items: Array.from({ length: 200 }, (_, index) =>
            counted({
              id: `old${index}`,
              role: 'assistant',
              text: `older line ${index}`,
              cursor: at(index),
            }),
          ),
          head: at(0),
          hasMore: false,
        })
        fieldReads = 0
        await f.controller.loadOlder()
        const afterPage = f.controller.latestHandoffPair
        const pageReads = fieldReads
        expect(opened).toBe(pair)
        expect(afterNew).toBe(pair)
        expect(afterPage).toBe(pair)
        expect(f.controller.items).toHaveLength(held.length + 1 + 200)
        samples.push({
          scale,
          heldItems: held.length,
          openReads,
          newReads,
          pageReads,
        })
      } finally {
        f.controller.dispose()
      }
    }
    expect(samples[1]!.openReads).toBe(samples[0]!.openReads)
    expect(samples[1]!.newReads).toBe(samples[0]!.newReads)
    expect(samples[1]!.pageReads).toBe(samples[0]!.pageReads)
    console.log('[handoff-pair-work1x4x]', JSON.stringify(samples))
  })
})
