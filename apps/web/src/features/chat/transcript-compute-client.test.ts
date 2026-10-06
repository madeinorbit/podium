import { computeTranscript } from '@podium/client-core/values'
import { TranscriptGraph } from '@podium/client-core/conversation'
import type { TranscriptItem } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptComputeWorkerRequest } from './transcript-compute.worker'
import { TranscriptComputeClient } from './transcript-compute-client'
import type { TranscriptGraphSource } from './transcript-compute-client'

class ControlledWorker {
  static latest: ControlledWorker
  messages: TranscriptComputeWorkerRequest[] = []
  onmessage?: (event: MessageEvent) => void
  onerror?: (event: ErrorEvent) => void
  constructor() {
    ControlledWorker.latest = this
  }
  postMessage(message: TranscriptComputeWorkerRequest) {
    this.messages.push(message)
  }
  terminate() {}
  reply(items: TranscriptItem[], markdown: Array<[string, string]> = []) {
    const request = this.messages.at(-1)!
    this.onmessage?.({
      data: {
        id: request.id,
        kind: 'transcript',
        ok: true,
        result: computeTranscript({ items, verbosity: 'normal', query: '', cursor: 0 }),
        markdown,
      },
    } as MessageEvent)
  }
  replyModel(ok = true) {
    const request = this.messages.at(-1)!
    this.onmessage?.({ data: ok ? { id: request.id, kind: 'model', ok: true,
      search: computeTranscript({ items: [], verbosity: 'normal', query: '', cursor: 0 }).search, markdown: [] }
      : { id: request.id, kind: 'model', ok: false, error: 'missing base' } } as MessageEvent)
  }
}

afterEach(() => vi.unstubAllGlobals())

const item = (
  overrides: Partial<TranscriptItem> & Pick<TranscriptItem, 'id' | 'role'>,
): TranscriptItem => ({
  text: '',
  ...overrides,
})

describe('TranscriptComputeClient', () => {
  it('keeps cancelled model credit and recovers its base after an unobserved failed flight', async () => {
    vi.stubGlobal('Worker', ControlledWorker)
    const client = new TranscriptComputeClient()
    const items = [item({ id: 'a', role: 'assistant', text: 'initial' })]
    let reset = true
    const snapshot = vi.fn(() => items)
    const source: TranscriptGraphSource = { graph: new TranscriptGraph(items), version: 0,
      get needsReset() { return reset }, snapshot, pending: () => ({ changed: [] }), sent: () => { reset = false } }
    const abort = new AbortController()
    const hidden = client.computeGraph(source, '', 0, { signal: abort.signal }).catch(error => error.name)
    abort.abort()
    expect(await hidden).toBe('AbortError')
    const queued = client.computeGraph(source, 'needle', 0)
    const worker = ControlledWorker.latest
    expect(worker.messages).toHaveLength(1)
    worker.replyModel(false)
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]).toMatchObject({ kind: 'model', items })
    expect(snapshot).toHaveBeenCalledTimes(2)
    worker.replyModel()
    await queued
    const search = client.computeGraph(source, 'needle', 1, { verbosity: 'summary' })
    expect(worker.messages.at(-1)).toMatchObject({ kind: 'model', verbosity: 'summary' })
    expect(worker.messages.at(-1)).not.toHaveProperty('items')
    expect(worker.messages.at(-1)).not.toHaveProperty('change')
    worker.replyModel()
    await search
    client.forgetGraph(source)
    expect(worker.messages.at(-1)).toMatchObject({ kind: 'forget-model' })
    client.dispose()
  })
  it('posts one in-flight job and only the latest queued frame instead of cloning a backlog', async () => {
    vi.stubGlobal('Worker', ControlledWorker)
    const client = new TranscriptComputeClient()
    const initial = [item({ id: 'initial', role: 'assistant', text: 'initial' })]
    const first = client.compute({ items: initial, verbosity: 'normal', query: '', cursor: 0 })
    const worker = ControlledWorker.latest
    const pending: Array<Promise<unknown>> = []
    let latest: TranscriptItem[] = []
    for (let index = 0; index < 1_000; index++) {
      latest = [item({ id: 'live', role: 'assistant', text: `revision ${index}` })]
      pending.push(
        client
          .compute({ items: latest, verbosity: 'normal', query: '', cursor: 0 })
          .catch((error) => error.name),
      )
    }
    expect(worker.messages).toHaveLength(1)
    worker.reply(initial)
    await first
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]).toMatchObject({ kind: 'delta', changed: latest, order: ['live'] })
    worker.reply(latest)
    const results = await Promise.all(pending)
    expect(results.slice(0, -1).every((result) => result === 'AbortError')).toBe(true)
    expect(results.at(-1)).toMatchObject({ blocks: expect.any(Array) })
    client.dispose()
  })
  it('cancels a hidden pane without losing worker credit or another pane’s request', async () => {
    vi.stubGlobal('Worker', ControlledWorker)
    const client = new TranscriptComputeClient()
    const signal = new AbortController()
    const input = {
      items: [item({ id: 'a', role: 'assistant', text: 'a' })],
      verbosity: 'normal' as const,
      query: '',
      cursor: 0,
    }
    const hidden = client
      .compute(input, { owner: {}, signal: signal.signal })
      .catch((error) => error.name)
    const other = client.compute(input, { owner: {} })
    signal.abort()
    expect(await hidden).toBe('AbortError')
    const worker = ControlledWorker.latest
    expect(worker.messages).toHaveLength(1)
    worker.reply(input.items, [['a', '<p>a</p>']])
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]?.kind).toBe('search')
    worker.reply(input.items)
    expect((await other).markdownHtml.get('a')).toBe('<p>a</p>')
    client.dispose()
  })
  it('sends only changed item content for a rolling window and growing same-id row', async () => {
    vi.stubGlobal('Worker', ControlledWorker)
    const client = new TranscriptComputeClient()
    const firstItems = [
      item({ id: 'old', role: 'user' }),
      item({ id: 'held', role: 'assistant', text: 'partial' }),
    ]
    const first = client.compute({ items: firstItems, verbosity: 'normal', query: '', cursor: 0 })
    ControlledWorker.latest.reply(firstItems)
    await first
    const changed = item({ id: 'held', role: 'assistant', text: 'complete' })
    const nextItems = [changed, item({ id: 'new', role: 'assistant', text: 'new' })]
    const next = client.compute({ items: nextItems, verbosity: 'normal', query: '', cursor: 0 })
    expect(ControlledWorker.latest.messages.at(-1)).toMatchObject({
      kind: 'delta',
      order: ['held', 'new'],
      changed: nextItems,
    })
    ControlledWorker.latest.reply(nextItems)
    await next
    client.dispose()
  })
  it('keeps the indexed graph stable when only search state changes', () => {
    const client = new TranscriptComputeClient()
    const items = [
      item({ id: 'u1', role: 'user', text: 'Prompt' }),
      item({ id: 'a1', role: 'assistant', text: 'The NEEDLE is here' }),
    ]

    const first = client.computeOnMain({ items, verbosity: 'normal', query: '', cursor: 0 })
    const second = client.computeOnMain({ items, verbosity: 'normal', query: 'needle', cursor: 0 })

    expect(second.blocks).toBe(first.blocks)
    expect(second.rows).toBe(first.rows)
    expect(second.markdownHtml).toBe(first.markdownHtml)
    expect(second.search.matches).toEqual([1])
  })

  it('uses the deferred renderer supplied by the feed when no Worker is available', async () => {
    vi.stubGlobal('Worker', undefined)
    const client = new TranscriptComputeClient()
    const renderOnMain = vi.fn((text: string) => `<p>${text}</p>`)

    await expect(client.computeMarkdown('streaming', renderOnMain)).resolves.toBe(
      '<p>streaming</p>',
    )
    expect(renderOnMain).toHaveBeenCalledOnce()
  })
})
