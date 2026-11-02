import type { TranscriptItem } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { TranscriptActivityRun, TranscriptGraph, TranscriptToolRun } from '../conversation'
import { activityRowSingletonDisplay, activitySingletonDisplay } from './activity-display'
import { buildChatRows, pairToolResults, presentToolBlock } from './chat'

const envelope = (id: string) =>
  `[podium message ${id} · from issue:POD-12 · to issue:POD-34]\nReady for review\n[end podium message ${id}]`
const note = (count = 1): TranscriptItem => ({
  id: 'note',
  role: 'user',
  text: Array.from({ length: count }, (_, i) => envelope(`msg-${i}`)).join('\n'),
})
const tool = (command = 'git status'): TranscriptItem => ({
  id: 'tool',
  role: 'tool',
  text: '',
  toolName: 'Bash',
  toolInput: command,
})

it.each([
  [note(), 'received-notes', true, false, true],
  [note(2), 'received-notes', false, true, true],
  [tool(), 'tool', false, false, false],
  [tool('podium issue mail send POD-12 --body ready'), 'sent-note', true, false, true],
  [tool('podium issue mail inbox'), 'inbox-read', true, false, true],
  [{ ...tool('podium issue mail inbox'), toolResult: 'error: failed' }, 'tool', false, false, true],
] as const)('describes singleton %s as %s', (item, kind, inline, multiple, asBlock) => {
  const block = presentToolBlock({ item })
  const display = activitySingletonDisplay(block)
  expect(display).toMatchObject({ kind, inline, multiple, asBlock })
  expect(display.block).toBe(block)
})

it('keeps retained and snapshot descriptors aligned as a singleton becomes mixed', () => {
  const items = [note()]
  const graph = new TranscriptGraph(items)
  const run = graph.run('note')!
  const stop = autorun(() => {
    run.singletonDisplay
    run.count
  })
  try {
    const snapshot = buildChatRows(pairToolResults(items))[0]!
    if (snapshot.kind !== 'tools') throw new Error('expected activity')
    expect(activityRowSingletonDisplay(snapshot)).toMatchObject({
      kind: 'received-notes',
      inline: true,
    })
    expect(run.singletonDisplay).toMatchObject({ kind: 'received-notes', inline: true })
    graph.apply({ changed: [tool()], insertions: [{ id: 'tool' }] })
    expect(graph.run('note')).toBe(run)
    expect(run.singletonDisplay).toBeUndefined()
    expect(run.ids).toEqual(['note', 'tool'])
    expect(TranscriptToolRun).toBe(TranscriptActivityRun)
  } finally {
    stop()
    graph.dispose()
  }
})

it('never materializes snapshot members when a retained source owns the descriptor', () => {
  const row = {
    kind: 'tools' as const,
    get blocks(): never {
      throw new Error('unbounded read')
    },
    blockIndices: [],
    title: '',
  }
  expect(activityRowSingletonDisplay(row, { singletonDisplay: undefined })).toBeUndefined()
})
