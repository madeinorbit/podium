import { SyncWorkerError, type SyncWorkerClient } from '../sync-worker/worker-client'
import { randomUUID } from 'node:crypto'
import {
  CLIENT_TYPE_HEADER,
  ClientType,
  CollectionFetchRequest,
  CollectionInstance,
  parseSyncBootstrapKinds,
  parseSyncDeltaQuery,
  principalRoutingId,
  SyncBootstrapRequiredReason,
  type Principal,
} from '@podium/protocol'
import { z } from 'zod'
import { CollectionRequestError, resolveInstance } from './collection-fetch'
import type { Hono } from 'hono'
import { negotiateContentCoding, syncResponseHeaders, syncRefusal, observeSyncTransfer, logSyncTransfer, transferLog, type SyncTransferMetrics, type SyncDeltaPorts } from './route-support'

export interface SyncRouteDeps extends SyncDeltaPorts {
  principal(request: Request): Promise<Principal | undefined>
  pageRows?: number
  worker?: () => Pick<SyncWorkerClient, 'bootstrap'> & Partial<Pick<SyncWorkerClient, 'delta' | 'collections'>> | undefined
}

/** The most instances a first download's visible view may name. */
const VIEW_MAX_INSTANCES = 50

/** The client type a request names, if any; an unknown one is refused. */
function clientTypeOf(request: Request): { ok: true; value?: ClientType } | { ok: false } {
  const named = request.headers.get(CLIENT_TYPE_HEADER)
  if (named === null) return { ok: true }
  const parsed = ClientType.safeParse(named)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}

/** Every instance must name a declared collection correctly before a job is admitted. */
function refusedInstance(instances: readonly CollectionInstance[]): string | undefined {
  for (const instance of instances) {
    try {
      resolveInstance(instance)
    } catch (error) {
      if (error instanceof CollectionRequestError) return error.message
      throw error
    }
  }
  return undefined
}

/** The first download's `view` parameter: the visible view's instances, as JSON. */
function parseView(url: URL): { ok: true; value: CollectionInstance[] } | { ok: false; error: string } {
  const values = url.searchParams.getAll('view')
  if (values.length === 0) return { ok: true, value: [] }
  if (values.length > 1) return { ok: false, error: 'view given twice' }
  let raw: unknown
  try {
    raw = JSON.parse(values[0]!)
  } catch {
    return { ok: false, error: 'view is not JSON' }
  }
  const parsed = z.array(CollectionInstance).max(VIEW_MAX_INSTANCES).safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'invalid view instances' }
  const refused = refusedInstance(parsed.data)
  return refused === undefined ? { ok: true, value: parsed.data } : { ok: false, error: refused }
}

/** HTTP admission and opaque byte relay; both producers run in the sync worker. */
export function registerSyncRoutes(app: Hono, deps: SyncRouteDeps): void {
  // The transfer id rides alongside the controller so a supersede can NAME both
  // sides of itself. Without it the cancelled transfer's INFO line says only that
  // it ended with zero bytes, and the request that killed it is unidentifiable
  // among every other bootstrap in the log (POD-4071).
  const bootstraps = new Map<string, { abort: AbortController; transferId: string }>()
  app.get('/sync/bootstrap', async (c) => {
    const principal = await deps.principal(c.req.raw)
    if (!principal) return syncRefusal('noFeedPrincipal', 'authenticated feed principal required')
    const kinds = parseSyncBootstrapKinds(new URL(c.req.url).searchParams)
    if (!kinds.success) return c.json({ error: 'invalid bootstrap kinds' }, 400)
    const clientType = clientTypeOf(c.req.raw)
    if (!clientType.ok) return c.json({ error: 'unknown client type' }, 400)
    const view = parseView(new URL(c.req.url))
    if (!view.ok) return c.json({ error: view.error }, 400)
    const coding = negotiateContentCoding(c.req.raw.headers.get('accept-encoding'))
    if (coding === 'not-acceptable') return c.body(null, 406)
    const routingId = String(principalRoutingId(principal))
    const transferId = randomUUID()
    // Supersede only within ONE client (its replica's id, kept across its own
    // retries). Keyed by user alone, every tab and device of a user cancelled the
    // others' bootstraps; when they all started cold together (after an update
    // added record kinds) none ever completed. A request without the id (older
    // clients, the CLI) supersedes nothing; its own disconnect still aborts it.
    const clientId = c.req.raw.headers.get('podium-sync-client')?.slice(0, 64) || undefined
    const reservationKey = clientId ? `${routingId} ${clientId}` : transferId
    const metrics: SyncTransferMetrics = {
      transferId, principal: routingId, coding, startedAt: performance.now(),
      captureMs: 0, bytesIn: 0, bytesOut: 0, rows: 0, records: 0, outcome: 'running',
    }
    const abort = new AbortController()
    // Reserve before awaiting identity, so concurrent retries cannot overtake
    // one another and resurrect an older snapshot after the new request starts.
    const superseded = bootstraps.get(reservationKey)
    if (superseded) {
      // DEBUG, not info: `logSyncTransfer` already reports the outcome at info.
      // This says only who did it, which is the one fact that line cannot carry.
      transferLog.debug('sync bootstrap superseded', {
        principal: routingId, supersededTransferId: superseded.transferId, transferId,
      })
      superseded.abort.abort(new SyncWorkerError('cancelled'))
    }
    bootstraps.set(reservationKey, { abort, transferId })
    const signal = AbortSignal.any([c.req.raw.signal, abort.signal])
    const release = () => {
      if (bootstraps.get(reservationKey)?.abort === abort) bootstraps.delete(reservationKey)
    }
    let completionOwnsLog = false
    try {
      const worker = deps.worker?.()
      if (!worker) throw new SyncWorkerError('unavailable')
      const { feedId, epoch } = await deps.serving.identity()
      if (signal.aborted) throw new SyncWorkerError('cancelled')
      const transfer = worker.bootstrap(
        {
          transferId,
          principal,
          feedId,
          epoch,
          encoding: coding,
          ...(kinds.data && { kinds: kinds.data }),
          ...(clientType.value && { clientType: clientType.value }),
          ...(view.value.length > 0 && { view: view.value }),
        },
        signal,
      )
      completionOwnsLog = true
      // Completion arrives independently of body demand, including queue refusal,
      // disconnected readers, shutdown, and a dead worker. Never parse relay bytes.
      void transfer.completed.then(({ metrics: captured, reason }) => {
        if (captured) {
          metrics.bytesIn = captured.bytesBefore
          metrics.rows = captured.rows
          metrics.records = captured.records
          metrics.captureMs = captured.phases.capture?.ms ?? metrics.captureMs
        }
        metrics.outcome = reason ?? captured?.outcome ?? 'complete'
        release()
        logSyncTransfer(metrics)
      })
      await transfer.meta // Worker acknowledgement precedes HTTP 200.
      const headers = syncResponseHeaders(coding)
      headers.set('Podium-Transfer-Id', transferId)
      return new Response(observeSyncTransfer(transfer.body, metrics, () => {}), { headers })
    } catch (error) {
      release()
      if (!completionOwnsLog) {
        metrics.outcome = error instanceof SyncWorkerError ? error.reason : 'admission-failed'
        metrics.err = error
        logSyncTransfer(metrics)
      }
      if (error instanceof SyncWorkerError) return syncRefusal('admissionFull', error.reason)
      throw error
    }
  })
  let active = 0
  app.get('/sync/delta', async (c) => {
    const principal = await deps.principal(c.req.raw)
    if (!principal) return syncRefusal('noFeedPrincipal', 'authenticated feed principal required')
    const query = parseSyncDeltaQuery(new URL(c.req.url).searchParams)
    if (!query.success) return c.json({ error: 'invalid delta range' }, 400)
    const coding = negotiateContentCoding(c.req.raw.headers.get('accept-encoding'))
    if (coding === 'not-acceptable') return c.body(null, 406)
    if (active >= 4) return syncRefusal('admissionFull', 'delta capacity exhausted')
    active++
    let released = false
    const release = () => { if (!released) { released = true; active-- } }
    const transferId = randomUUID()
    const metrics: SyncTransferMetrics = {
      transferId, principal: String(principalRoutingId(principal)), coding, startedAt: performance.now(),
      captureMs: 0, bytesIn: 0, bytesOut: 0, rows: 0, records: 0, outcome: 'running',
    }
    let completionOwnsLog = false
    try {
      const { feedId, epoch } = await deps.serving.identity()
      if (query.data.feedId !== feedId || query.data.epoch !== epoch) {
        release()
        return syncRefusal('bootstrapRequired', 'feed-identity-mismatch')
      }
      const worker = deps.worker?.()
      if (!worker?.delta) throw new SyncWorkerError('unavailable')
      const transfer = worker.delta(
        {
          mode: 'delta',
          transferId,
          principal,
          feedId,
          epoch,
          encoding: coding,
          from: query.data.from,
          to: query.data.to,
          pageRows: deps.pageRows ?? 500,
          ...(query.data.omitKinds && { omitKinds: query.data.omitKinds }),
        },
        c.req.raw.signal,
      )
      completionOwnsLog = true
      void transfer.completed.then(({ metrics: captured, reason }) => {
        if (captured) {
          metrics.bytesIn = captured.bytesBefore
          metrics.rows = captured.rows
          metrics.records = captured.records
          metrics.captureMs = captured.phases.capture?.ms ?? 0
        }
        metrics.outcome = reason ?? captured?.outcome ?? 'complete'
        release()
        logSyncTransfer(metrics)
      })
      await transfer.meta
      const headers = syncResponseHeaders(coding)
      headers.set('Podium-Transfer-Id', transferId)
      return new Response(observeSyncTransfer(transfer.body, metrics, () => {}), { headers })
    } catch (error) {
      release()
      if (!completionOwnsLog) {
        metrics.outcome = error instanceof SyncWorkerError ? error.reason : 'admission-failed'
        logSyncTransfer(metrics)
      }
      if (error instanceof SyncWorkerError) {
        const refusal = SyncBootstrapRequiredReason.safeParse(error.reason)
        return refusal.success ? syncRefusal('bootstrapRequired', refusal.data) : syncRefusal('admissionFull', error.reason)
      }
      throw error
    }
  })
  app.post('/sync/collections', async (c) => {
    const principal = await deps.principal(c.req.raw)
    if (!principal) return syncRefusal('noFeedPrincipal', 'authenticated feed principal required')
    const clientType = clientTypeOf(c.req.raw)
    if (!clientType.ok) return c.json({ error: 'unknown client type' }, 400)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body is not JSON' }, 400)
    }
    const request = CollectionFetchRequest.safeParse(body)
    if (!request.success) return c.json({ error: 'invalid collection request' }, 400)
    const refused = refusedInstance(request.data.instances)
    if (refused !== undefined) return c.json({ error: refused }, 400)
    const coding = negotiateContentCoding(c.req.raw.headers.get('accept-encoding'))
    if (coding === 'not-acceptable') return c.body(null, 406)
    const transferId = randomUUID()
    const metrics: SyncTransferMetrics = {
      transferId, principal: String(principalRoutingId(principal)), coding, startedAt: performance.now(),
      captureMs: 0, bytesIn: 0, bytesOut: 0, rows: 0, records: 0, outcome: 'running',
    }
    let completionOwnsLog = false
    try {
      const worker = deps.worker?.()
      if (!worker?.collections) throw new SyncWorkerError('unavailable')
      const { feedId, epoch } = await deps.serving.identity()
      const transfer = worker.collections(
        {
          mode: 'collections',
          transferId,
          principal,
          feedId,
          epoch,
          encoding: coding,
          instances: request.data.instances,
          ...(clientType.value && { clientType: clientType.value }),
        },
        c.req.raw.signal,
      )
      completionOwnsLog = true
      void transfer.completed.then(({ metrics: captured, reason }) => {
        if (captured) {
          metrics.bytesIn = captured.bytesBefore
          metrics.rows = captured.rows
          metrics.records = captured.records
          metrics.captureMs = captured.phases.capture?.ms ?? 0
        }
        metrics.outcome = reason ?? captured?.outcome ?? 'complete'
        logSyncTransfer(metrics)
      })
      await transfer.meta
      const headers = syncResponseHeaders(coding)
      headers.set('Podium-Transfer-Id', transferId)
      return new Response(observeSyncTransfer(transfer.body, metrics, () => {}), { headers })
    } catch (error) {
      if (!completionOwnsLog) {
        metrics.outcome = error instanceof SyncWorkerError ? error.reason : 'admission-failed'
        logSyncTransfer(metrics)
      }
      if (error instanceof SyncWorkerError) return syncRefusal('admissionFull', error.reason)
      throw error
    }
  })
}
