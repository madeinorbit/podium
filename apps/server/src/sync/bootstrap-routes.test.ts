import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { gzipSync, gunzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { clientAuthGuard } from '../auth-route'
import { podiumCors as cors } from '../http-cors'
import { SyncWorkerError, type BootstrapJob, type SyncMetaSummary } from '../sync-worker/worker-client'
import type { BootstrapCompletion } from '../sync-worker/worker-client'
import { registerSyncRoutes, type SyncRouteDeps } from './routes'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  let authorized = true
  let ready = true
  const transfers: { job: BootstrapJob; signal?: AbortSignal; acknowledge(): void; refuse(): void }[] = []
  const bootstrap = vi.fn((job: BootstrapJob, signal?: AbortSignal) => {
    const meta = deferred<SyncMetaSummary>()
    const completed = deferred<BootstrapCompletion>()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let done = false
    const fail = (reason: 'cancelled' | 'queue-full') => {
      if (done) return
      done = true
      const error = new SyncWorkerError(reason)
      meta.reject(error)
      controller.error(error)
      completed.resolve({ reason })
    }
    const summary: SyncMetaSummary = { type: 'syncMeta', formatVersion: 1, mode: 'snapshot', transferId: job.transferId,
      feedId: job.feedId, epoch: job.epoch, seq: 7, minAvailableSeq: 1, totalRows: 0,
      wireVersion: WIRE_VERSION, wireSchemaDigest: wireSchemaDigest() }
    const text = JSON.stringify(summary) + '\n' + JSON.stringify({ type: 'syncComplete', transferId: job.transferId, seq: 7, records: 0, rows: 0 }) + '\n'
    const bytes = job.encoding === 'gzip' ? gzipSync(text) : job.encoding === 'zstd' ? zstdCompressSync(text) : Buffer.from(text)
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      start(c) { controller = c },
      pull(c) {
        if (!sent) { sent = true; c.enqueue(bytes); return }
        done = true
        c.close()
        completed.resolve({})
      },
      cancel() { done = true; completed.resolve({ reason: 'cancelled' }) },
    }, { highWaterMark: 0 })
    signal?.addEventListener('abort', () => fail('cancelled'), { once: true })
    if (signal?.aborted) fail('cancelled')
    transfers.push({ job, signal, acknowledge: () => meta.resolve(summary), refuse: () => fail('queue-full') })
    return { meta: meta.promise, body, completed: completed.promise }
  })
  const deps: SyncRouteDeps = {
    principal: async () => DEVICE_GRADE_PRINCIPAL,
    authority: { captureHead: async () => 7, changesRange: async function* () {} },
    serving: { identity: async () => ({ feedId: 'trusted-feed', epoch: 'trusted-epoch' }), retentionFloor: async () => 1 },
    worker: () => ({ bootstrap }),
  }
  const app = new Hono()
  app.use('/sync/*', cors())
  app.use('/sync/*', async (c, next) => ready ? next() : c.body(null, 503))
  app.use('/sync/*', clientAuthGuard({ loginRequired: () => true, principalForRequest: async () => authorized ? { memberId: 'test', role: 'admin' } : undefined }))
  registerSyncRoutes(app, deps)
  const request = (signal?: AbortSignal, coding = 'identity') => app.fetch(new Request('https://localhost/sync/bootstrap?principal=attacker&feedId=forged&epoch=forged', {
    signal, headers: { 'accept-encoding': coding },
  }))
  return { request, deps, bootstrap, transfers, unauthorized: () => { authorized = false }, unready: () => { ready = false } }
}
async function started(f: ReturnType<typeof fixture>, count = 1) {
  await vi.waitFor(() => expect(f.transfers).toHaveLength(count))
  return f.transfers[count - 1]!
}

describe('bootstrap HTTP boundary', () => {
  it('rejects unauthenticated, unready, and absent feed principals before worker access', async () => {
    const noAuth = fixture(); noAuth.unauthorized()
    expect((await noAuth.request()).status).toBe(401)
    expect(noAuth.bootstrap).not.toHaveBeenCalled()
    const unready = fixture(); unready.unready()
    expect((await unready.request()).status).toBe(503)
    expect(unready.bootstrap).not.toHaveBeenCalled()
    const noPrincipal = fixture(); noPrincipal.deps.principal = async () => undefined
    expect((await noPrincipal.request()).status).toBe(403)
    expect(noPrincipal.bootstrap).not.toHaveBeenCalled()
  })
  it('keeps bearer credentials HTTPS-only', async () => {
    const app = new Hono()
    app.use('/sync/*', clientAuthGuard({ loginRequired: () => true }))
    app.get('/sync/bootstrap', c => c.text('wrong'))
    expect((await app.request('http://localhost/sync/bootstrap', { headers: { authorization: 'Bearer secret' } })).status).toBe(400)
  })
  it('waits for acknowledgement and maps queue refusal to clean 503', async () => {
    const f = fixture()
    let answered = false
    const request = Promise.resolve(f.request()).then(r => { answered = true; return r })
    const transfer = await started(f)
    expect(answered).toBe(false)
    transfer.refuse()
    const response = await request
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(await response.json()).toEqual({ error: 'queue-full' })
    expect(response.headers.get('content-type')).not.toContain('ndjson')
  })
  it('refuses an unavailable worker and unacceptable encoding', async () => {
    const f = fixture(); f.deps.worker = () => undefined
    expect((await f.request()).status).toBe(503)
    expect((await f.request(undefined, '*;q=0,identity;q=0')).status).toBe(406)
  })
  it.each(['identity', 'gzip', 'zstd'])('streams meta first with trusted identity and %s headers', async coding => {
    const f = fixture()
    const request = f.request(undefined, coding)
    const transfer = await started(f)
    transfer.acknowledge()
    const response = await request
    expect(response.status).toBe(200)
    expect(transfer.job).toMatchObject({ principal: DEVICE_GRADE_PRINCIPAL, feedId: 'trusted-feed', epoch: 'trusted-epoch', encoding: coding })
    expect(Object.keys(transfer.job).sort()).toEqual(['encoding', 'epoch', 'feedId', 'principal', 'transferId'])
    expect(response.headers.get('podium-transfer-id')).toBe(transfer.job.transferId)
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8')
    expect(response.headers.get('content-encoding')).toBe(coding === 'identity' ? null : coding)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toContain('Accept-Encoding')
    expect(response.headers.get('content-length')).toBeNull()
    const bytes = Buffer.from(await response.arrayBuffer())
    const decoded = coding === 'gzip' ? gunzipSync(bytes) : coding === 'zstd' ? zstdDecompressSync(bytes) : bytes
    const lines = decoded.toString().trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0]).toMatchObject({ type: 'syncMeta', seq: 7 })
    expect(lines.at(-1)).toMatchObject({ type: 'syncComplete', seq: 7 })
  })
  it('supersedes the older job, preserves the newer reservation, and propagates abort', async () => {
    const f = fixture()
    const first = f.request()
    const one = await started(f); one.acknowledge()
    const oldResponse = await first
    const controller = new AbortController()
    const second = f.request(controller.signal)
    const two = await started(f, 2)
    expect(one.signal?.aborted).toBe(true)
    await expect(oldResponse.text()).rejects.toMatchObject({ reason: 'cancelled' })
    two.acknowledge()
    const response = await second
    const third = f.request()
    const three = await started(f, 3)
    expect(two.signal?.aborted).toBe(true)
    await expect(response.text()).rejects.toMatchObject({ reason: 'cancelled' })
    three.acknowledge()
    await (await third).body!.cancel()
    const fourth = f.request(controller.signal)
    const four = await started(f, 4); four.acknowledge()
    const last = await fourth
    controller.abort()
    expect(four.signal?.aborted).toBe(true)
    await expect(last.text()).rejects.toMatchObject({ reason: 'cancelled' })
  })
  it('does not start an older job when identity resolves after a replacement', async () => {
    const f = fixture()
    const identity = deferred<{ feedId: string; epoch: string }>()
    f.deps.serving.identity = vi.fn().mockReturnValueOnce(identity.promise).mockResolvedValue({ feedId: 'f', epoch: 'e' })
    const first = f.request()
    await vi.waitFor(() => expect(f.deps.serving.identity).toHaveBeenCalledTimes(1))
    const second = f.request()
    const transfer = await started(f); transfer.acknowledge()
    identity.resolve({ feedId: 'old', epoch: 'old' })
    expect((await first).status).toBe(503)
    expect(f.bootstrap).toHaveBeenCalledTimes(1)
    await (await second).body!.cancel()
  })
})
