import type { TranscriptItem } from '@podium/model'
import { expect, it } from 'vitest'
import { autorun } from 'mobx'
import { lazyKeptCount } from '@podium/mobx-helpers'
import { TranscriptGraph as Before } from './transcript-graph.before'
import { TranscriptGraph as After } from './transcript-graph'

const item = (id: string, role: TranscriptItem['role'], text = id): TranscriptItem => ({
  id,
  role,
  text,
})
const call = (id: string): TranscriptItem => ({
  ...item(id, 'tool', ''),
  toolName: 'Read',
  toolUseId: id,
  toolInput: '/needle',
})
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
function sameAnswers(before: Before, after: After) {
  for (const verbosity of ['normal', 'summary', 'verbose'] as const) {
    expect(plain(after.snapshot(verbosity))).toEqual(plain(before.snapshot(verbosity)))
    for (const query of ['', 'needle', 'missing', ' NEEDLE ', 'a'])
      for (const cursor of [-1, 0, 1, 99])
        expect(after.search(query, cursor, verbosity)).toEqual(
          before.search(query, cursor, verbosity),
        )
  }
}

it('answers the old pairing, rows and search questions on the same evolving fixtures', () => {
  const fixtures: TranscriptItem[][] = [
    [],
    [item('a', 'assistant', 'needle')],
    [item('prompt', 'user'), call('c1'), call('c2'), item('tail', 'assistant', 'needle')],
    [
      { ...item('orphan', 'tool', ''), toolUseId: 'c1', toolResult: 'error needle' },
      item('tail', 'assistant'),
    ],
    [
      item('prompt', 'user'),
      {
        ...item('media', 'user', ''),
        tags: [{ kind: 'image', label: 'image' }],
        toolPaths: ['/image'],
      },
    ],
  ]
  for (const fixture of fixtures) {
    const before = new Before(fixture),
      after = new After(fixture)
    sameAnswers(before, after)
    for (const change of [
      { changed: [item('incoming', 'assistant', 'needle next')], insertions: [{ id: 'incoming' }] },
      { changed: [item('incoming', 'assistant', 'different text')] },
      {
        changed: [
          { ...item('result', 'tool', ''), toolUseId: 'c1', toolResult: 'complete needle' },
        ],
        insertions: [{ id: 'result' }],
      },
      { changed: [], removed: ['incoming'] },
    ]) {
      before.apply(change)
      after.apply(change)
      sameAnswers(before, after)
    }
    before.reset(fixture)
    after.reset(fixture)
    sameAnswers(before, after)
    before.dispose()
    after.dispose()
  }
})

it('rejects an intentionally wrong candidate answer', () => {
  const before = new Before([item('a', 'assistant', 'needle')]),
    after = new After([])
  expect(() => sameAnswers(before, after)).toThrow()
})

it('keeps unrelated blocks asleep and releases lazy fields when their reader leaves', async () => {
  const after = new After([item('a', 'assistant'), item('b', 'assistant')])
  let a = 0,
    b = 0
  const stopA = autorun(() => {
    after.block('a')
    a++
  })
  const stopB = autorun(() => {
    after.block('b')
    b++
  })
  a = b = 0
  after.apply({ changed: [item('b', 'assistant', 'changed')] })
  expect({ a, b }).toEqual({ a: 0, b: 1 })
  const record = after.record('a')!
  const companion = after.presentation(record)
  expect(lazyKeptCount(companion)).toBeGreaterThan(0)
  stopA()
  stopB()
  await Promise.resolve()
  expect(lazyKeptCount(companion)).toBe(0)
  after.dispose()
})
