import { IssueWire } from '@podium/model/browser'
import { makeIssue } from './test-issue'
import { WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type KernelAssembly, openKernelAssembly } from './kernelReplica'

let assembly: KernelAssembly | undefined
const postMessage = vi.fn()
beforeEach(() => {
  localStorage.clear()
  postMessage.mockClear()
})
afterEach(async () => {
  await assembly?.dispose()
  vi.unstubAllGlobals()
})
const meta = {
  type: 'syncMeta',
  formatVersion: 1,
  mode: 'snapshot',
  transferId: 't',
  feedId: 'f',
  epoch: 'e',
  seq: 1,
  minAvailableSeq: 0,
  wireVersion: WIRE_VERSION,
  wireSchemaDigest: wireSchemaDigest(),
  totalRows: 1,
}
const row = {
  seq: 1,
  entity: 'issue',
  entityId: 'i',
  op: 'upsert',
  value: IssueWire.parse(makeIssue({ id: 'i', title: 'HTTP' })),
}
const chunk = {
  type: 'feedBootstrap',
  feedId: 'f',
  epoch: 'e',
  fromSeq: 0,
  seq: 1,
  minAvailableSeq: 0,
  changes: [row],
  last: true,
}
const complete = { type: 'syncComplete', transferId: 't', seq: 1, records: 1, rows: 1 }
const encode = (record: unknown) => new TextEncoder().encode(JSON.stringify(record) + '\n')
async function open() {
  assembly = await openKernelAssembly({
    trpc: {} as never,
    principal: JSON.stringify(['installation-a', 'alice']),
    evidence: { kind: 'single-account', principal: JSON.stringify(['installation-a', 'alice']) },
    factory: new IDBFactory() as never,
    httpOrigin: 'https://sync.test',
    broadcastChannelFactory: () => ({ onmessage: null, postMessage, close() {} }),
  })
  return assembly
}
it('uses credentialed workspace fetch with generation cancellation and no encoding override', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
          },
        }),
        { headers: { 'content-type': 'application/x-ndjson' } },
      ),
  )
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('location', { pathname: '/w/example/' })
  const current = await open()
  expect(current.feed.syncHttp).toBe(true)
  current.feed.connected(false)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://sync.test/sync/bootstrap')
  expect(init.credentials).toBe('include')
  expect(new Headers(init.headers).has('Accept-Encoding')).toBe(false)
  expect(new Headers(init.headers).get('Podium-Workspace')).toBe('example')
  expect(init.signal).toBeInstanceOf(AbortSignal)
  controller.enqueue(encode(meta))
  controller.enqueue(encode(chunk))
  await vi.waitFor(() => expect(current.progress.getSnapshot().rowsSeen).toBe(1))
  expect(current.progress.getSnapshot().rowsCommitted).toBe(0)
  controller.enqueue(encode(complete))
  controller.close()
  await vi.waitFor(() => expect(current.progress.getSnapshot().phase).toBe('ready'))
  expect(current.progress.getSnapshot().rowsCommitted).toBe(1)
  expect(postMessage).not.toHaveBeenCalled()
  await current.dispose()
  assembly = undefined
  expect(init.signal?.aborted).toBe(true)
})
it.each([
  [401, 'auth'],
  [500, 'network'],
  [426, 'format'],
] as const)('surfaces HTTP %i as %s', async (status, error) => {
  const fetch = vi.fn(async () => new Response('', { status }))
  vi.stubGlobal('fetch', fetch)
  const current = await open()
  current.feed.connected(false)
  await vi.waitFor(() => expect(current.progress.getSnapshot().error).toBe(error))
  if (error !== 'network') expect(fetch).toHaveBeenCalledTimes(1)
})
it('keeps corrupt responses fatal until a visible retry starts a fresh HTTP attempt', async () => {
  const fetch = vi.fn(
    async () => new Response('not-json\n', { headers: { 'content-type': 'application/x-ndjson' } }),
  )
  vi.stubGlobal('fetch', fetch)
  const current = await open()
  current.feed.connected(false)
  await vi.waitFor(() => expect(current.progress.getSnapshot().error).toBe('format'))
  current.feed.connected(false)
  expect(fetch).toHaveBeenCalledTimes(1)
  fetch.mockImplementation(
    async () =>
      new Response([meta, chunk, complete].map((v) => JSON.stringify(v) + '\n').join(''), {
        headers: { 'content-type': 'application/x-ndjson' },
      }),
  )
  current.progress.retry()
  await vi.waitFor(() => expect(current.progress.getSnapshot().phase).toBe('ready'))
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(current.progress.getSnapshot()).toMatchObject({
    attempt: 2,
    rowsSeen: 1,
    rowsCommitted: 1,
    error: null,
  })
})
