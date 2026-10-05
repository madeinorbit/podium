import { asSessionId, type TranscriptItem } from '@podium/model'
import { expect, it } from 'vitest'
import { insideReader, measureWork } from '../../../worklist-proto/harness/src/work-meter'
import { latestPendingQuestion } from '../values/ask-question'
import {
  createTranscriptController,
  type TranscriptControllerOptions,
  type TranscriptPage,
  type TranscriptSource,
} from './controller'

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
  questions?: TranscriptControllerOptions['questions'],
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
  const controller = createTranscriptController({
    sessionId: asSessionId('facts'),
    source,
    initialLimit,
    retainHistory: () => retainHistory,
    visible: () => false,
    questions,
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
        prompt = f.controller.latestOperatorPrompt()
      })
      expect(prompt).toBe('  Original prompt\n')
      expect(f.controller.getSnapshot().latestOperatorPrompt).toBe(prompt)
      const questionRead = await measure(() => {
        question = f.controller.latestPendingQuestion()
      })
      expect(question).toBe(items[1])
      expect(f.controller.getSnapshot().pendingQuestion).toBe(question)
      const itemRead = await measure(() => {
        found = f.controller.getItem('prompt')
      })
      expect(found).toBe(items[0])
      const absent = await measure(() => {
        found = f.controller.getItem('absent')
      })
      expect(found).toBeUndefined()
      const control = await measure(() => {
        latestPendingQuestion(f.controller.getSnapshot().items)
      })
      expect(control.roleReads).toBe(128 * scale + 1)
      const actions = { promptRead, questionRead, itemRead, absent }
      for (const result of Object.values(actions)) {
        expect(result.roleReads).toBe(0)
        expect(result.pointReads).toBe(1)
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
    expect(f.controller.latestOperatorPrompt()).toBe('u2')
    expect(f.controller.latestPendingQuestion()?.id).toBe('q2')
    f.emit([ask('q2', 4, true)])
    expect(f.controller.latestPendingQuestion()).toBeNull()
    expect(f.controller.getSnapshot().pendingQuestion).toBeNull()
    f.emit([row('u2', 'user', 3, { text: '   ' }), row('q2', 'assistant', 4)])
    expect(f.controller.latestOperatorPrompt()).toBe('u1')
    expect(f.controller.latestPendingQuestion()?.id).toBe('q1')
    f.emit([ask('q3', 5), ask('q3', 5, true)])
    expect(f.controller.latestPendingQuestion()).toBeNull()
    f.emit([row('q3', 'user', 5, { text: '  New original\n' })])
    expect(f.controller.latestOperatorPrompt()).toBe('  New original\n')
    expect(f.controller.latestPendingQuestion()?.id).toBe('q1')
    expect(f.controller.getSnapshot().latestOperatorPrompt).toBe('  New original\n')
    expect(f.controller.getSnapshot().pendingQuestion?.id).toBe('q1')
  } finally {
    f.controller.dispose()
  }
})

it('keeps raw-order winners across out-of-order frames, prepend and authoritative reset', async () => {
  const f = await fixture([row('u', 'user', 10), ask('q', 20), row('a', 'assistant', 30)])
  try {
    f.emit([ask('older', 15), row('earlier', 'user', 5)])
    expect(f.controller.latestOperatorPrompt()).toBe('u')
    expect(f.controller.latestPendingQuestion()?.id).toBe('q')
    f.page({ items: [ask('oldest', 1), row('old-prompt', 'user', 2)], head: 'old', hasMore: false })
    await f.controller.loadOlder()
    expect(f.controller.latestPendingQuestion()).toBe(
      latestPendingQuestion(f.controller.getSnapshot().items),
    )
    expect(f.controller.latestOperatorPrompt()).toBe('u')
    f.page({ items: [], hasMore: false })
    f.emit([], true)
    expect(f.controller.latestPendingQuestion()).toBeNull()
    expect(f.controller.latestOperatorPrompt()).toBeNull()
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
    expect(f.controller.getSnapshot().items).toHaveLength(4)
    expect(f.controller.latestOperatorPrompt()).toBeNull()
    expect(f.controller.latestPendingQuestion()).toBeNull()
    f.page({ items: [row('prompt', 'user', 1), ask('question', 2)], head: 'old', hasMore: false })
    await f.controller.loadOlder()
    expect(f.controller.latestOperatorPrompt()).toBe('prompt')
    expect(f.controller.latestPendingQuestion()?.id).toBe('question')
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
          latest = f.controller.getSnapshot().latestRecordedAt
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
    expect(f.controller.getSnapshot().latestRecordedAt).toBe(Date.parse('2026-09-29T01:34:00.000Z'))
    f.emit([
      row('t', 'tool', 3, { ts: 'invalid' }),
      row('u2', 'user', 2, { text: 'new', toolPaths: ['b', 'a'] }),
    ])
    expect(f.controller.hasUserEcho('same')).toBe(false)
    expect(f.controller.hasUserEcho('new')).toBe(true)
    expect(f.controller.hasUserEcho('other', ['a', 'b'])).toBe(false)
    expect(f.controller.hasUserEcho('other', ['b', 'a'])).toBe(true)
    expect(f.controller.getSnapshot().latestRecordedAt).toBe(Date.parse('2026-09-29T01:31:00.000Z'))
    f.emit(Array.from({ length: 5 }, (_, index) => row(`tail${index}`, 'assistant', index + 4)))
    expect(f.controller.hasUserEcho('new')).toBe(false)
    expect(f.controller.getSnapshot().latestRecordedAt).toBeNull()
    f.page({
      items: [row('old', 'user', 0, { text: 'restored', ts: '2026-09-29T01:36:00.000Z' })],
      hasMore: false,
    })
    await f.controller.loadOlder()
    expect(f.controller.hasUserEcho('restored')).toBe(true)
    expect(f.controller.getSnapshot().latestRecordedAt).toBe(Date.parse('2026-09-29T01:36:00.000Z'))
    f.page({ items: [], hasMore: false })
    f.emit([], true)
    expect(f.controller.hasUserEcho('restored')).toBe(false)
    expect(f.controller.getSnapshot().latestRecordedAt).toBeNull()
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
  const f = await fixture([item])
  try {
    expect(timeReads).toBe(0)
    expect(pathReads).toBe(0)
    expect(f.controller.getSnapshot().latestRecordedAt).toBeNull()
    expect(() => f.controller.hasUserEcho('prompt')).toThrow('must declare')
  } finally {
    f.controller.dispose()
  }
})
