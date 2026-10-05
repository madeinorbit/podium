import { asSessionId, type TranscriptItem } from '@podium/model'
import { expect, it } from 'vitest'
import { insideReader, measureWork } from '../../../worklist-proto/harness/src/work-meter'
import { latestPendingQuestion } from '../values/ask-question'
import {
  createTranscriptController,
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

async function fixture(items: TranscriptItem[], initialLimit = 1024, retainHistory = true) {
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
