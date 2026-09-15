import { setImmediate } from 'node:timers/promises'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { validateSyncDeltaChain, type SyncRecord } from '@podium/protocol'
import { Authority, type AuthorityDeps, DeviceGradeNoAnchors, DeviceGradeUnscopedPolicy, ChangeRangeBootstrapRequired, DEVICE_GRADE_PRINCIPAL, type AuthorityPort } from '@podium/sync'
import { registerSyncRoutes, type SyncRouteDeps } from './routes'

function fixture() {
  const changesRange = vi.fn<AuthorityPort['changesRange']>(async function* (_principal, from, through, size) {
    do {
      const seq = Math.min(from + size, through)
      yield { kind: 'batch', fromSeq: from, throughSeq: seq, changes: [] }
      from = seq
    } while (from < through)
  })
  const deps: SyncRouteDeps = {
    principal: vi.fn(async () => DEVICE_GRADE_PRINCIPAL),
    authority: { captureHead: vi.fn(async () => 8), changesRange },
    serving: { identity: vi.fn(async () => ({ feedId: 'f', epoch: 'e' })), retentionFloor: vi.fn(async () => 1) },
    pageRows: 3,
  }
  const app = new Hono()
  registerSyncRoutes(app, deps)
  const request = (query = 'feedId=f&epoch=e&from=0', coding = 'identity', signal?: AbortSignal) =>
    app.request(`/sync/delta?${query}`, { headers: { 'accept-encoding': coding }, signal })
  return { deps, changesRange, request }
}
async function records(response: Response): Promise<SyncRecord[]> {
  let bytes = Buffer.from(await response.arrayBuffer())
  if (response.headers.get('content-encoding') === 'gzip') bytes = gunzipSync(bytes)
  if (response.headers.get('content-encoding') === 'zstd') bytes = zstdDecompressSync(bytes)
  return bytes.toString().trim().split('\n').map((line) => JSON.parse(line))
}

describe('delta refusals before streaming', () => {
  it.each([
    ['feedId=wrong&epoch=e&from=0', 409, 'feed-identity-mismatch'],
    ['feedId=f&epoch=wrong&from=0', 409, 'feed-identity-mismatch'],
    ['feedId=f&epoch=e&from=9', 409, 'future-cursor'],
    ['feedId=f&epoch=e&from=0&to=9', 409, 'future-cursor'],
    ['feedId=f&epoch=e&from=3&to=2', 400, undefined],
    ['feedId=f&epoch=e', 400, undefined],
    ['feedId=f&epoch=e&from=-1', 400, undefined],
    ['feedId=f&epoch=e&from=0&from=1', 400, undefined],
  ])('%s', async (query, status, reason) => {
    const f = fixture()
    const response = await f.request(query)
    expect(response.status).toBe(status)
    if (reason) expect(await response.json()).toEqual({ kind: 'bootstrap-required', reason })
    expect(f.changesRange).not.toHaveBeenCalled()
  })
  it('refuses a compacted cursor', async () => {
    const f = fixture()
    f.deps.serving.retentionFloor = async () => 2
    const response = await f.request()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ kind: 'bootstrap-required', reason: 'compacted-or-unknown' })
    expect(f.changesRange).not.toHaveBeenCalled()
  })
  it.each(['compacted-or-unknown', 'corrupt-payload'] as const)('preserves %s from the bounded reader', async (reason) => {
    const f = fixture()
    f.changesRange.mockImplementation(async function* () { throw new ChangeRangeBootstrapRequired(reason) })
    const response = await f.request()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ kind: 'bootstrap-required', reason })
  })
  it('refuses an unavailable principal and unsupported encoding', async () => {
    const f = fixture()
    expect((await f.request(undefined, 'identity;q=0,*;q=0')).status).toBe(406)
    f.deps.principal = async () => undefined
    expect((await f.request()).status).toBe(403)
    expect(f.changesRange).not.toHaveBeenCalled()
  })
})

it.each(['identity', 'gzip', 'zstd'])('streams chaining certificates with %s', async (coding) => {
  const f = fixture()
  const response = await f.request(undefined, coding)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/x-ndjson')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const lines = await records(response)
  expect(validateSyncDeltaChain(lines)).toEqual([])
  expect(lines.filter((r) => r.type === 'feedDelta').map((r) => [r.fromSeq, r.seq])).toEqual([[0, 3], [3, 6], [6, 8]])
  expect(f.changesRange).toHaveBeenCalledWith(DEVICE_GRADE_PRINCIPAL, 0, 8, 3)
  expect(f.deps.authority.captureHead).toHaveBeenCalledTimes(1)
})

it('pins an empty range to one empty certificate', async () => {
  const f = fixture()
  const lines = await records(await f.request('feedId=f&epoch=e&from=8'))
  expect(lines.map((r) => r.type)).toEqual(['syncMeta', 'feedDelta', 'syncComplete'])
  expect(lines[1]).toMatchObject({ fromSeq: 8, seq: 8, changes: [] })
  expect(validateSyncDeltaChain(lines)).toEqual([])
})

it('never chases the head and honors an explicit target', async () => {
  const f = fixture()
  f.changesRange.mockImplementation(async function* (_principal, from, through) {
    yield { kind: 'batch', fromSeq: from, throughSeq: 3, changes: [] }
    f.deps.authority.captureHead = async () => 100
    yield { kind: 'batch', fromSeq: 3, throughSeq: through, changes: [] }
  })
  const lines = await records(await f.request('feedId=f&epoch=e&from=0&to=6'))
  expect(lines[0]).toMatchObject({ seq: 6 })
  expect(lines.at(-1)).toMatchObject({ seq: 6 })
  expect(validateSyncDeltaChain(lines)).toEqual([])
})

it('terminates rescope after headers with authorization-changed, never complete', async () => {
  const f = fixture()
  f.changesRange.mockImplementation(async function* () {
    yield { kind: 'batch', fromSeq: 0, throughSeq: 3, changes: [] }
    yield { kind: 'rescope', fromSeq: 3, throughSeq: 8, reason: 'test' }
  })
  const lines = await records(await f.request())
  expect(lines.at(-1)).toMatchObject({ type: 'syncError', reason: 'authorization-changed' })
  expect(lines.some((r) => r.type === 'syncComplete')).toBe(false)
})

it('bounds read-ahead and admits only four stalled streams; cancellation releases capacity', async () => {
  const f = fixture()
  let produced = 0
  let closed = 0
  f.changesRange.mockImplementation(async function* (_principal, from, through) {
    try {
      for (let seq = from + 1; seq <= through; seq++) {
        produced++
        yield { kind: 'batch', fromSeq: seq - 1, throughSeq: seq, changes: [] }
      }
    } finally { closed++ }
  })
  f.deps.authority.captureHead = async () => 100000
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.request()))
  try {
    await setImmediate()
    const held = produced
    for (let i = 0; i < 10; i++) await setImmediate()
    expect(produced).toBe(held)
    expect(produced).toBeLessThanOrEqual(8)
    const refused = await f.request()
    expect(refused.status).toBe(503)
    expect(refused.headers.get('retry-after')).toBe('5')
  } finally {
    await Promise.all(responses.map((r) => r.body!.cancel()))
  }
  await setImmediate()
  expect(closed).toBe(4)
  const recovered = await f.request()
  expect(recovered.status).toBe(200)
  await recovered.body!.cancel()
})

// Exercise the shipped reader, including its lookahead and policy filtering.
it.each([false, true])('real bounded range includes late rows only within H; invisible=%s', async (invisible) => {
  const f = fixture()
  const row = (seq: number) => ({ seq, entity: 'issue', entityId: `i${seq}`, op: 'delete' as const, payload: null })
  const rows = [1, 2, 3, 4, 5, 7, 8].map(row)
  let reads = 0
  const store: AuthorityDeps['store'] = {
    appendChanges: async () => { throw new Error('unused') },
    maxChangeSeq: async () => 8,
    minChangeSeq: async () => 1,
    latestChangeStates: async () => [],
    changesSince: async () => { throw new Error('legacy read forbidden') },
    changesInRange: async (from, through, limit) => {
      const page = rows.filter((r) => r.seq > from && r.seq <= through).sort((a, b) => a.seq - b.seq).slice(0, limit)
      if (++reads === 1) rows.push(row(6), row(9))
      return page
    },
    planChangePrune: async () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: async () => 0,
  }
  f.deps.authority = new Authority({ store, now: () => 0, transact: (fn) => fn(),
    visibility: invisible ? { grade: 'per-principal', decide: () => ({ visible: false, reason: 'unclassified' }) } : new DeviceGradeUnscopedPolicy(),
    anchors: new DeviceGradeNoAnchors(),
  })
  const lines = await records(await f.request())
  expect(validateSyncDeltaChain(lines)).toEqual([])
  const deltas = lines.filter((line) => line.type === 'feedDelta')
  expect(deltas.at(-1)?.seq).toBe(8)
  expect(deltas.flatMap((line) => line.changes.map((change) => change.seq))).toEqual(invisible ? [] : [1, 2, 3, 4, 5, 6, 7, 8])
})
