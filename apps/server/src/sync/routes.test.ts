import { WIRE_VERSION } from '@podium/protocol'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { SyncWorkerError, type SyncWorkerClient } from '../sync-worker/worker-client'
import { registerSyncRoutes, type SyncRouteDeps } from './routes'

function fixture() {
  const bytes = new TextEncoder().encode('opaque worker bytes\n')
  const delta = vi.fn<SyncWorkerClient['delta']>(() => ({
    meta: Promise.resolve({ type: 'syncMeta', formatVersion: 1, mode: 'delta', transferId: 't',
      feedId: 'f', epoch: 'e', fromSeq: 0, seq: 8, minAvailableSeq: 1, wireVersion: WIRE_VERSION, wireSchemaDigest: '0000000000000000' }),
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
    completed: Promise.resolve({}),
  }))
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('main-thread data read') })
  const deps: SyncRouteDeps = {
    principal: vi.fn(async () => DEVICE_GRADE_PRINCIPAL),
    authority: { captureHead: forbidden, changesRange: forbidden },
    serving: { identity: async () => ({ feedId: 'f', epoch: 'e' }), retentionFloor: forbidden },
    worker: () => ({ bootstrap: () => { throw new Error('wrong producer') }, delta }),
    pageRows: 3,
  }
  const app = new Hono()
  registerSyncRoutes(app, deps)
  const request = (query = 'feedId=f&epoch=e&from=0', coding = 'identity') =>
    app.request(`/sync/delta?${query}`, { headers: { 'accept-encoding': coding } })
  return { deps, delta, forbidden, request }
}

describe('worker delta route', () => {
  it.each([
    ['feedId=wrong&epoch=e&from=0', 409], ['feedId=f&epoch=wrong&from=0', 409],
    ['feedId=f&epoch=e&from=3&to=2', 400], ['feedId=f&epoch=e', 400],
    ['feedId=f&epoch=e&from=-1', 400], ['feedId=f&epoch=e&from=0&from=1', 400],
  ])('refuses %s before worker admission', async (query, status) => {
    const f = fixture()
    expect((await f.request(query)).status).toBe(status)
    expect(f.delta).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
  })
  it.each(['identity', 'gzip', 'zstd'])('relays opaque %s bytes and forwards range and principal', async coding => {
    const f = fixture()
    const response = await f.request('feedId=f&epoch=e&from=2&to=6', coding)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBe(coding)
    expect(response.headers.get('podium-transfer-id')).toBeTruthy()
    expect(await response.text()).toBe('opaque worker bytes\n')
    expect(f.delta).toHaveBeenCalledWith(expect.objectContaining({ mode: 'delta', from: 2, to: 6,
      encoding: coding, principal: DEVICE_GRADE_PRINCIPAL, pageRows: 3 }), expect.any(AbortSignal))
    expect(f.forbidden).not.toHaveBeenCalled()
  })
  it.each(['future-cursor', 'compacted-or-unknown', 'corrupt-payload', 'rescope'] as const)('preserves worker refusal %s', async reason => {
    const f = fixture()
    f.delta.mockImplementation(() => { throw new SyncWorkerError(reason) })
    const response = await f.request()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ kind: 'bootstrap-required', reason })
  })
  it('refuses unavailable worker, principal and encoding', async () => {
    const f = fixture()
    f.deps.worker = () => undefined
    expect((await f.request()).status).toBe(503)
    expect((await f.request(undefined, 'identity;q=0,*;q=0')).status).toBe(406)
    f.deps.principal = async () => undefined
    expect((await f.request()).status).toBe(403)
  })
})
