import { SyncWorkerError, type SyncWorkerClient } from '../sync-worker/worker-client'
import { randomUUID } from 'node:crypto'
import { parseSyncDeltaQuery, principalRoutingId, SyncBootstrapRequiredReason, type Principal } from '@podium/protocol'
import type { Hono } from 'hono'
import { negotiateContentCoding, syncResponseHeaders, syncRefusal, observeSyncTransfer, logSyncTransfer, type SyncTransferMetrics, type SyncDeltaPorts } from './route-support'

export interface SyncRouteDeps extends SyncDeltaPorts {
  principal(request: Request): Promise<Principal | undefined>
  pageRows?: number
  worker?: () => Pick<SyncWorkerClient, 'bootstrap'> & Partial<Pick<SyncWorkerClient, 'delta'>> | undefined
}

/** HTTP admission and opaque byte relay; both producers run in the sync worker. */
export function registerSyncRoutes(app: Hono, deps: SyncRouteDeps): void {
  const bootstraps = new Map<string, AbortController>()
  app.get('/sync/bootstrap', async (c) => {
    const principal = await deps.principal(c.req.raw)
    if (!principal) return syncRefusal('noFeedPrincipal', 'authenticated feed principal required')
    const coding = negotiateContentCoding(c.req.raw.headers.get('accept-encoding'))
    if (coding === 'not-acceptable') return c.body(null, 406)
    const routingId = String(principalRoutingId(principal))
    const transferId = randomUUID()
    const metrics: SyncTransferMetrics = {
      transferId, principal: routingId, coding, startedAt: performance.now(),
      captureMs: 0, bytesIn: 0, bytesOut: 0, rows: 0, records: 0, outcome: 'running',
    }
    const abort = new AbortController()
    // Reserve before awaiting identity, so concurrent retries cannot overtake
    // one another and resurrect an older snapshot after the new request starts.
    bootstraps.get(routingId)?.abort(new SyncWorkerError('cancelled'))
    bootstraps.set(routingId, abort)
    const signal = AbortSignal.any([c.req.raw.signal, abort.signal])
    const release = () => {
      if (bootstraps.get(routingId) === abort) bootstraps.delete(routingId)
    }
    let completionOwnsLog = false
    try {
      const worker = deps.worker?.()
      if (!worker) throw new SyncWorkerError('unavailable')
      const { feedId, epoch } = await deps.serving.identity()
      if (signal.aborted) throw new SyncWorkerError('cancelled')
      const transfer = worker.bootstrap({ transferId, principal, feedId, epoch, encoding: coding }, signal)
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
      const transfer = worker.delta({ mode: 'delta', transferId, principal, feedId, epoch,
        encoding: coding, from: query.data.from, to: query.data.to, pageRows: deps.pageRows ?? 500 }, c.req.raw.signal)
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
}
