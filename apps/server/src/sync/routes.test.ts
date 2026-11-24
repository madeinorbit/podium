import {
  CLIENT_TYPE_HEADER,
  CLIENT_WIRE_VERSION,
  SYNC_RECOVERY_ID_HEADER,
  SYNC_RECOVERY_REASON_HEADER,
} from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type SyncWorkerClient, SyncWorkerError } from '../sync-worker/worker-client'
import { bindRequestsTo, boundWorkspaceForTests } from '../test-support/workspace-binding'
import { transferLog } from './route-support'
import { registerSyncRoutes, type SyncRouteDeps } from './routes'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const bytes = new TextEncoder().encode('opaque worker bytes\n')
  const transfer = (): ReturnType<SyncWorkerClient['delta']> => ({
    meta: Promise.resolve({
      type: 'syncMeta',
      kindTokens: {},
      formatVersion: 1,
      mode: 'delta',
      transferId: 't',
      feedId: 'f',
      epoch: 'e',
      fromSeq: 0,
      seq: 8,
      minAvailableSeq: 1,
      wireVersion: CLIENT_WIRE_VERSION,
      wireSchemaDigest: '0000000000000000',
    }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    completed: Promise.resolve({}),
  })
  const delta = vi.fn<SyncWorkerClient['delta']>(transfer)
  const bootstrap = vi.fn<SyncWorkerClient['bootstrap']>(transfer)
  const collections = vi.fn<SyncWorkerClient['collections']>(transfer)
  const forbidden = vi.fn((): never => {
    throw new Error('main-thread data read')
  })
  const accessMoved = vi.fn(async (_principal: unknown, _seq: number) => false)
  const deps: SyncRouteDeps = {
    principal: vi.fn(async () => DEVICE_GRADE_PRINCIPAL),
    authority: { captureHead: forbidden, changesRange: forbidden },
    serving: {
      identity: async () => ({ feedId: 'f', epoch: 'e' }),
      retentionFloor: forbidden,
      accessMovedAfter: accessMoved,
    },
    worker: () => ({ bootstrap, delta, collections }),
    pageRows: 3,
    workspaceOf: boundWorkspaceForTests,
  }
  const app = new Hono()
  bindRequestsTo(app)
  registerSyncRoutes(app, deps)
  const request = (query = 'feedId=f&epoch=e&from=0', coding = 'identity') =>
    app.request(`/sync/delta?${query}`, { headers: { 'accept-encoding': coding } })
  return { app, deps, delta, bootstrap, collections, forbidden, accessMoved, request }
}

describe('sync transfer diagnostic fields', () => {
  const recoveryId = '6e55ae1e-69b5-45cf-a7dc-7cd45aafda9e'
  it.each([
    ['/sync/bootstrap', 'bootstrap', 'retention'],
    ['/sync/delta?feedId=f&epoch=e&from=0', 'delta', 'resume'],
    ['/sync/collections', 'partial-reload', 'kind-shape'],
    ['/sync/collections', 'partial-reload', 'markers'],
  ])('identifies %s and its recovery cause', async (path, mode, reason) => {
    const f = fixture()
    const log = vi.spyOn(transferLog, 'info')
    const collection = mode === 'partial-reload'
    const response = await f.app.request(path, {
      method: collection ? 'POST' : 'GET',
      headers: {
        'accept-encoding': 'identity',
        'content-type': 'application/json',
        [SYNC_RECOVERY_ID_HEADER]: recoveryId,
        [SYNC_RECOVERY_REASON_HEADER]: reason,
      },
      ...(collection
        ? { body: JSON.stringify({ instances: [{ collection: 'session.live', part: 'main' }] }) }
        : {}),
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'sync transfer finished',
      expect.objectContaining({
        mode,
        recoveryReason: reason,
        clientRecoveryId: recoveryId,
        outcome: 'complete',
      }),
    )
  })

  it.each([
    [undefined, undefined],
    ['person@example.com', 'Bearer private-value'],
    ['not-a-random-id', 'retention-extra'],
  ])('ignores missing or unbounded diagnostic headers (%s)', async (key, reason) => {
    const f = fixture()
    const log = vi.spyOn(transferLog, 'info')
    const response = await f.app.request('/sync/delta?feedId=f&epoch=e&from=0', {
      headers: {
        'accept-encoding': 'identity',
        ...(key === undefined ? {} : { [SYNC_RECOVERY_ID_HEADER]: key }),
        ...(reason === undefined ? {} : { [SYNC_RECOVERY_REASON_HEADER]: reason }),
      },
    })
    await response.text()
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'sync transfer finished',
      expect.objectContaining({
        mode: 'delta',
        clientRecoveryId: null,
        recoveryReason: 'unknown',
      }),
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-value')
    expect(JSON.stringify(log.mock.calls)).not.toContain('person@example.com')
  })

  it('records an identity refusal before worker admission', async () => {
    const f = fixture()
    const log = vi.spyOn(transferLog, 'info')
    expect((await f.request('feedId=other&epoch=e&from=0')).status).toBe(409)
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'sync transfer finished',
      expect.objectContaining({
        mode: 'delta',
        recoveryReason: 'feed-identity',
        outcome: 'bootstrap-required',
      }),
    )
  })

  it.each([
    ['future-cursor', 'cursor-ahead'],
    ['compacted-or-unknown', 'retention'],
  ] as const)('records the worker refusal %s', async (reason, expected) => {
    const f = fixture()
    const log = vi.spyOn(transferLog, 'info')
    f.delta.mockImplementation(() => {
      throw new SyncWorkerError(reason)
    })
    expect((await f.request()).status).toBe(409)
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'sync transfer finished',
      expect.objectContaining({
        mode: 'delta',
        recoveryReason: expected,
        outcome: reason,
      }),
    )
  })
})

describe('worker delta route', () => {
  it.each([
    ['feedId=wrong&epoch=e&from=0', 409],
    ['feedId=f&epoch=wrong&from=0', 409],
    ['feedId=f&epoch=e&from=3&to=2', 400],
    ['feedId=f&epoch=e', 400],
    ['feedId=f&epoch=e&from=-1', 400],
    ['feedId=f&epoch=e&from=0&from=1', 400],
  ])('refuses %s before worker admission', async (query, status) => {
    const f = fixture()
    expect((await f.request(query)).status).toBe(status)
    expect(f.delta).not.toHaveBeenCalled()
    expect(f.forbidden).not.toHaveBeenCalled()
  })
  it.each([
    'identity',
    'gzip',
    'zstd',
  ])('relays opaque %s bytes and forwards range and principal', async (coding) => {
    const f = fixture()
    const response = await f.request('feedId=f&epoch=e&from=2&to=6', coding)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBe(coding === 'identity' ? null : coding)
    expect(response.headers.get('podium-transfer-id')).toBeTruthy()
    expect(await response.text()).toBe('opaque worker bytes\n')
    expect(f.delta).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'delta',
        from: 2,
        to: 6,
        encoding: coding,
        principal: DEVICE_GRADE_PRINCIPAL,
        pageRows: 3,
      }),
      expect.any(AbortSignal),
    )
    expect(f.forbidden).not.toHaveBeenCalled()
  })
  it.each([
    'future-cursor',
    'compacted-or-unknown',
    'corrupt-payload',
    'rescope',
  ] as const)('preserves worker refusal %s', async (reason) => {
    const f = fixture()
    f.delta.mockImplementation(() => {
      throw new SyncWorkerError(reason)
    })
    const response = await f.request()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ kind: 'bootstrap-required', reason })
  })
  // POD-7552: the rows that would show the access move are pruned; the access-move log is not.
  it("answers a compacted cursor as a rescope when the viewer's access moved after it", async () => {
    const f = fixture()
    f.delta.mockImplementation(() => {
      throw new SyncWorkerError('compacted-or-unknown')
    })
    f.accessMoved.mockImplementation(async (_principal, seq) => seq < 5)
    const moved = await f.request('feedId=f&epoch=e&from=4')
    expect(await moved.json()).toEqual({ kind: 'bootstrap-required', reason: 'rescope' })
    expect(f.accessMoved).toHaveBeenLastCalledWith(DEVICE_GRADE_PRINCIPAL, 4)
    const unmoved = await f.request('feedId=f&epoch=e&from=5')
    expect(await unmoved.json()).toEqual({
      kind: 'bootstrap-required',
      reason: 'compacted-or-unknown',
    })
  })
  it('asks the access-move log only for a compacted cursor', async () => {
    const f = fixture()
    f.delta.mockImplementation(() => {
      throw new SyncWorkerError('future-cursor')
    })
    f.accessMoved.mockImplementation(async () => true)
    expect(await (await f.request()).json()).toEqual({
      kind: 'bootstrap-required',
      reason: 'future-cursor',
    })
    expect((await f.request('feedId=f&epoch=e&from=2&to=6')).status).toBe(409)
    expect(f.accessMoved).not.toHaveBeenCalled()
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

describe('bootstrap since (POD-7552)', () => {
  const bootstrapAt = (f: ReturnType<typeof fixture>, query: string) =>
    f.app.request(`/sync/bootstrap${query}`, { headers: { 'accept-encoding': 'identity' } })

  it("says the viewer's access moved after the cursor the device held", async () => {
    const f = fixture()
    f.accessMoved.mockImplementation(async (_principal, seq) => seq < 7)
    const moved = await bootstrapAt(f, '?sinceFeedId=f&sinceEpoch=e&since=6')
    expect(moved.status).toBe(200)
    expect(moved.headers.get('podium-sync-access-moved')).toBe('1')
    expect(f.accessMoved).toHaveBeenLastCalledWith(DEVICE_GRADE_PRINCIPAL, 6)
    const unmoved = await bootstrapAt(f, '?sinceFeedId=f&sinceEpoch=e&since=7')
    expect(unmoved.status).toBe(200)
    expect(unmoved.headers.get('podium-sync-access-moved')).toBeNull()
  })

  it('asks nothing for a cold device, another feed or a malformed cursor', async () => {
    const f = fixture()
    f.accessMoved.mockImplementation(async () => true)
    for (const query of [
      '',
      '?sinceFeedId=other&sinceEpoch=e&since=6',
      '?sinceFeedId=f&sinceEpoch=other&since=6',
      '?sinceFeedId=f&sinceEpoch=e&since=-1',
      '?sinceFeedId=f&sinceEpoch=e',
    ]) {
      const response = await bootstrapAt(f, query)
      expect(response.status).toBe(200)
      expect(response.headers.get('podium-sync-access-moved')).toBeNull()
    }
    expect(f.accessMoved).not.toHaveBeenCalled()
    expect(f.bootstrap).toHaveBeenCalledTimes(5)
  })
})

describe('worker collection admission', () => {
  it('answers the published instances in a batch containing retired rules', async () => {
    const f = fixture()
    const current = { collection: 'session.live', part: 'main' }
    const response = await f.app.request('/sync/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_TYPE_HEADER]: 'phone' },
      body: JSON.stringify({
        instances: [
          { collection: 'session.retired', part: 'main' },
          {
            collection: 'session.ofIssue',
            via: 'issueProjection.retired',
            args: { issueId: 'A' },
            part: 'main',
          },
          current,
        ],
      }),
    })
    expect(response.status).toBe(200)
    expect(f.collections).toHaveBeenCalledWith(
      expect.objectContaining({
        clientType: 'phone',
        instances: [current],
      }),
      expect.any(AbortSignal),
    )
  })
})
