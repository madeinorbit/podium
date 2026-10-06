import { TranscriptLog } from '@podium/client-core/conversation'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { afterEach, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../../../packages/worklist-proto/harness/src/work-meter'
import type { TranscriptComputeWorkerRequest, TranscriptWorkerResponse } from './transcript-compute.worker'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

/** Counts the shipped algorithms, without adding counters to product code. */
it('records retained transcript work at one and four times history', async () => {
  const responses: TranscriptWorkerResponse[] = []
  const scope = {
    onmessage: (_event: MessageEvent<TranscriptComputeWorkerRequest>) => {},
    postMessage: (response: TranscriptWorkerResponse) => responses.push(response),
  }
  vi.stubGlobal('self', scope)
  await import('./transcript-compute.worker')
  const input = { verbosity: 'normal' as const, query: '', cursor: 0 }
  let key = 0
  const send = (data: TranscriptComputeWorkerRequest) => scope.onmessage({ data } as MessageEvent)
  const count = async (name: string, action: () => unknown) => {
    const result = await measureWork(async () => insideReader(name, action), { trace: true })
    return { ...result.work, sites: Object.fromEntries(result.sites ?? []) }
  }
  const item = (index: number): TranscriptItem => ({
    id: `item-${index}`, cursor: String(index).padStart(8, '0'),
    role: index % 4 === 0 ? 'user' : 'assistant',
    answer: index % 4 === 3, text: index === 5 ? 'needle' : `Settled message ${index}`,
  })
  const samples = []
  for (const scale of [1, 4]) {
    const items = Array.from({ length: 128 * scale }, (_, index) => item(index))
    const tail = items.at(-1)!
    const streamed = { ...tail, text: `${tail.text} token` }
    const incoming = item(items.length)
    const older = [item(-2), item(-1)]
    const merge = async (name: string, frame: TranscriptItem[]) => {
      const log = new TranscriptLog({
        sessionId: asSessionId('work-probe'),
        source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} },
        cache: { read: () => ({ items, savedAt: 1 }), write: () => {} },
        retainHistory: () => true,
      })
      try { return await count(name, () => log.merge(frame)) }
      finally { log.dispose() }
    }
    const coreStream = await merge('TranscriptLog.stream', [streamed])
    const coreIncoming = await merge('TranscriptLog.incoming', [incoming])
    const log = new TranscriptLog({
      sessionId: asSessionId('work-page'),
      source: { read: async () => ({ items: older, head: older[0]!.cursor, hasMore: false }), subscribe: () => () => {} },
      cache: { read: () => ({ items, savedAt: 1 }), write: () => {} }, retainHistory: () => true,
    })
    log.head = items[0]!.cursor
    const coreOlder = await count('TranscriptLog.loadOlder', () => log.loadOlder())
    expect(log.items).toHaveLength(items.length + older.length)
    log.dispose()

    const worker = async (name: string, changed: TranscriptItem[], next: TranscriptItem[]) => {
      send({ id: ++key, kind: 'index', indexKey: key, input: { ...input, items } })
      const baseIndexKey = key
      const work = await count(name, () => send({
        id: ++key, kind: 'delta', baseIndexKey, indexKey: key,
        changed, order: next.map(item => item.id), input,
      }))
      expect(responses.at(-1)).toMatchObject({ ok: true })
      return work
    }
    const webStream = await worker('worker.stream', [streamed], [...items.slice(0, -1), streamed])
    const webIncoming = await worker('worker.incoming', [incoming], [...items, incoming])
    const webOlder = await worker('worker.loadOlder', older, [...older, ...items])
    send({ id: ++key, kind: 'index', indexKey: key, input: { ...input, items } })
    const webVerbosity = await count('worker.verbosity', () => send({
      id: ++key, kind: 'index', indexKey: key, input: { ...input, items, verbosity: 'summary' },
    }))
    const webSearch = await count('worker.search', () => send({
      id: ++key, kind: 'search', indexKey: key - 1, query: 'needle', cursor: 0,
    }))
    expect(responses.at(-1)).toMatchObject({ ok: true, result: { search: { total: 1 } } })

    samples.push({ scale, history: items.length, coreStream, coreIncoming, coreOlder,
      webStream, webIncoming, webOlder, webVerbosity, webSearch })
  }
  expect(samples[1]!.webStream.elements).toBeGreaterThan(samples[0]!.webStream.elements * 3)
  expect(samples[1]!.coreStream.elements).toBeGreaterThan(samples[0]!.coreStream.elements * 3)
  console.log('[transcript-work-baseline]', JSON.stringify(samples))
})
