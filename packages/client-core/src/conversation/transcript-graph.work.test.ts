import type { TranscriptItem } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { insideReader, measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { TranscriptGraph } from './transcript-graph'

it('bounds collapsed quiet-run updates, appends and prefix rekeys at 1x/4x children', async () => {
  const call = (at: number): TranscriptItem => ({ id: `call-${at}`, role: 'tool', text: '',
    toolName: 'Read', toolUseId: `use-${at}`, toolInput: JSON.stringify({ file_path: `/file-${at}` }) })
  const samples = []
  for (const scale of [1, 4]) {
    const items = Array.from({ length: 128 * scale }, (_, at) => call(at))
    const graph = new TranscriptGraph(items)
    const run = graph.run(items[0]!.id)!
    const stop = autorun(() => { run.title; run.count; run.failures; run.lastBlock; run.elapsed() })
    const count = async (name: string, update: () => void) =>
      (await measureWork(async () => insideReader(name, update), { trace: true })).work
    try {
      const result: TranscriptItem = { id: 'result', role: 'tool', text: '', toolUseId: items.at(-1)!.toolUseId,
        toolResult: 'error: failed' }
      graph.apply({ changed: [result], insertions: [{ id: result.id }] })
      const stream = await count('quietRun.result', () => graph.apply({ changed: [{ ...result, toolResult: 'complete' }] }))
      const incoming = call(items.length)
      const append = await count('quietRun.append', () => graph.apply({ changed: [incoming], insertions: [{ id: incoming.id }] }))
      const prefix = call(-1)
      const prepend = await count('quietRun.prepend', () => graph.apply({ changed: [prefix], insertions: [{ id: prefix.id, before: items[0]!.id }] }))
      expect(graph.run(prefix.id)).toBe(run)
      expect(run.count).toBe(items.length + 2)
      expect(run.failures).toBe(0)
      expect(graph.rowIdForBlock(items.at(-1)!.id)).toBe(prefix.id)
      samples.push({ scale, children: items.length, stream, append, prepend })
    } finally { stop(); graph.dispose() }
  }
  for (const name of ['stream', 'append', 'prepend'] as const) {
    expect(samples[1]![name].elements).toBeLessThanOrEqual(samples[0]![name].elements + 10)
    expect(samples[1]![name].visits).toBeLessThanOrEqual(samples[0]![name].visits + 20)
  }
  console.log('[transcript-retained-tool-work]', JSON.stringify(samples))
})

it('bounds one progress-result update when a call has 1x/4x retained result messages', async () => {
  const samples = []
  for (const scale of [1, 4]) {
    const call: TranscriptItem = { id: 'call', role: 'tool', text: '', toolName: 'Read', toolUseId: 'use' }
    const results = Array.from({ length: 128 * scale }, (_, at): TranscriptItem =>
      ({ id: `result-${at}`, role: 'tool', text: '', toolUseId: 'use', toolResult: `progress ${at}` }))
    const graph = new TranscriptGraph([call, ...results])
    const stop = autorun(() => { graph.block('call'); graph.run('call')?.failures })
    try {
      const work = await measureWork(async () => insideReader('tool.progress', () =>
        graph.apply({ changed: [{ ...results.at(-1)!, toolResult: 'complete' }] })), { trace: true })
      expect(graph.block('call')?.result).toBe('complete')
      samples.push(work.work)
    } finally { stop(); graph.dispose() }
  }
  expect(samples[1]!.elements).toBeLessThanOrEqual(samples[0]!.elements + 10)
  expect(samples[1]!.visits).toBeLessThanOrEqual(samples[0]!.visits + 20)
  console.log('[transcript-retained-result-work]', JSON.stringify(samples))
})
