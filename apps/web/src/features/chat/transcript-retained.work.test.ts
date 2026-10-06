import { TranscriptLog } from '@podium/client-core/conversation'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../../../tests/worklist/harness/src/work-meter'
import { ConversationPresentation } from './conversation-presentation'
import { TranscriptComputeClient, type TranscriptGraphSource } from './transcript-compute-client'
import type { TranscriptComputeWorkerRequest, TranscriptWorkerResponse } from './transcript-compute.worker'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

/** Both sides of the shipped protocol run here. Message shape proves the clone
 * boundary is sparse; collection work covers ingress, main graph and worker. */
it('bounds warm web stream, append, prepend, query and cursor work at 1x/4x history', async () => {
  let worker: BridgeWorker
  const scope = { onmessage: (_event: MessageEvent<TranscriptComputeWorkerRequest>) => {},
    postMessage: (response: TranscriptWorkerResponse) => worker.onmessage?.({ data: response } as MessageEvent) }
  class BridgeWorker {
    onmessage?: (event: MessageEvent) => void
    onerror?: (event: ErrorEvent) => void
    queued: TranscriptComputeWorkerRequest[] = []
    messages: TranscriptComputeWorkerRequest[] = []
    constructor() { worker = this }
    postMessage(message: TranscriptComputeWorkerRequest) { this.queued.push(message); this.messages.push(message) }
    terminate() {}
    async flush() {
      while (this.queued.length) scope.onmessage({ data: this.queued.shift()! } as MessageEvent)
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  vi.stubGlobal('self', scope)
  vi.stubGlobal('Worker', BridgeWorker)
  await import('./transcript-compute.worker')
  const item = (at: number): TranscriptItem => ({ id: `item-${at}`, role: at % 4 === 0 ? 'user' : 'assistant',
    cursor: Buffer.from(JSON.stringify(['file', at, `item-${at}`, 0])).toString('base64url'),
    answer: at % 4 === 3, text: at === 5 ? 'unique needle' : `Settled message ${at}` })
  const samples = []
  for (const scale of [1, 4]) {
    const items = Array.from({ length: 512 * scale }, (_, at) => item(at))
    let page = { items, head: items[0]!.cursor, hasMore: true }
    const client = new TranscriptComputeClient(() => new BridgeWorker() as unknown as Worker)
    expect(client.usesWorker).toBe(true)
    let retainedSource: TranscriptGraphSource | undefined
    const computeGraph = client.computeGraph.bind(client)
    vi.spyOn(client, 'computeGraph').mockImplementation((source, ...args) => {
      retainedSource = source
      return computeGraph(source, ...args)
    })
    const presentation = new ConversationPresentation(client)
    presentation.setFollowTail(false)
    const log = new TranscriptLog({ sessionId: asSessionId('retained-web'),
      source: { read: async () => page, subscribe: () => () => {} },
      cache: { maxItems: 200, read: () => undefined, write: () => {} },
      retainHistory: () => presentation.retainHistory,
      onChange: change => presentation.changed(change) })
    presentation.bind(log)
    expect(client.usesWorker).toBe(true)
    await log.start()
    await worker!.flush()
    // Model observation remains mounted while the history grows. Its window is
    // a fixed output demand; the producer may not visit unmounted history.
    const stop = autorun(() => { presentation.renderRows(false, false); presentation.search; presentation.lastAnswer })
    const count = async (name: string, change: () => unknown) => {
      const result = await measureWork(async () => insideReader(name, async () => {
        await change()
        await worker!.flush()
      }), { trace: true })
      const request = worker!.messages.at(-1)!
      expect(request.kind).toBe('model')
      expect(request).not.toHaveProperty('items')
      expect(request).not.toHaveProperty('order')
      return { ...result.work, sites: Object.fromEntries(result.sites ?? []) }
    }
    try {
      const stream = await count('retainedWeb.stream', () => log.merge([{ ...items.at(-1)!, text: 'streamed token' }]))
      const incoming = await count('retainedWeb.incoming', () => log.merge([item(items.length)]))
      page = { items: [item(-2), item(-1), items[0]!], head: item(-2).cursor, hasMore: true }
      const older = await count('retainedWeb.older', () => log.loadOlder())
      const coalesced = await count('retainedWeb.coalesced', async () => {
        log.merge([{ ...item(items.length), text: 'coalesced stream' }])
        page = { items: [item(-4), item(-3)], head: item(-4).cursor, hasMore: false }
        await log.loadOlder()
        log.merge([item(items.length + 1)])
      })
      const search = await count('retainedWeb.search', () => presentation.setQuery('needle'))
      const cursor = await count('retainedWeb.cursor', () => presentation.moveCursor(1))
      let verbosityResult: ReturnType<TranscriptComputeClient['computeGraph']> | undefined
      const verbosity = await count('retainedWeb.verbosity', () => {
        verbosityResult = client.computeGraph(retainedSource!, '', 0, { verbosity: 'summary' })
      })
      expect((await verbosityResult)!.search.total).toBe(0)
      expect(presentation.search.total).toBe(1)
      expect(presentation.block(items.at(-1)!.id)?.item.text).toBe('streamed token')
      expect(log.ids.length).toBe(items.length + 6)
      samples.push({ scale, history: items.length, stream, incoming, older, coalesced, search, cursor, verbosity })
    } finally { stop(); presentation.dispose(); log.dispose(); client.dispose() }
  }
  for (const name of ['stream', 'incoming', 'older', 'coalesced', 'search', 'cursor', 'verbosity'] as const) {
    // Small MobX subscriber differences are allowed; a retained-history walk
    // would grow fourfold and exceed this bound by hundreds of elements.
    expect(samples[1]![name].elements).toBeLessThanOrEqual(samples[0]![name].elements + 20)
    expect(samples[1]![name].visits).toBeLessThanOrEqual(samples[0]![name].visits + 40)
  }
  console.log('[transcript-retained-web-work]', JSON.stringify(samples))
})
