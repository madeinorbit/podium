import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { parseSyncDeltaQuery, principalRoutingId, WIRE_VERSION, wireSchemaDigest, type Principal, type SyncRecord, type SyncBootstrapRequiredReason } from '@podium/protocol'
import { ChangeRangeBootstrapRequired, type AuthorityPort } from '@podium/sync'
import type { Hono } from 'hono'
import { toFeedChange } from '../gateway/feed-serving'
import { NdjsonEncoder, RowTooLarge } from './ndjson-encoder'
import { pipeSyncBody } from './pipe-sync-body'
import { negotiateContentCoding, syncResponseHeaders, syncRefusal, observeSyncTransfer, type SyncTransferMetrics, type SyncDeltaPorts } from './route-support'

export interface SyncRouteDeps extends SyncDeltaPorts {
  principal(request: Request): Promise<Principal | undefined>
  pageRows?: number
}

/**
 * Shared HTTP sync registration. Bootstrap adds its handler here in POD-3938;
 * there is deliberately no placeholder endpoint. The composition root mounts
 * CORS, readiness and clientAuthGuard BEFORE calling this function.
 *
 * Authority retains TWO bounded source pages (including its final-page
 * lookahead). We pass 500 rows per page: half the legacy funnel's 1,000-row
 * page, bounding each main-thread scoping/serialization turn more tightly.
 * Payload bytes vary; 1,000 source rows is not a fixed byte/RSS limit.
 * Separately, encoding stages one record (16 MiB line limit) and the pipe
 * slices into 64 KiB chunks with bounded codec/queue state. No range collection.
 */
export function registerSyncRoutes(app: Hono, deps: SyncRouteDeps): void {
  let active = 0
  app.get('/sync/delta', async (c) => {
    const principal = await deps.principal(c.req.raw)
    if (!principal) return syncRefusal('noFeedPrincipal', 'authenticated feed principal required')
    const query = parseSyncDeltaQuery(new URL(c.req.url).searchParams)
    if (!query.success) return c.json({ error: 'invalid delta range' }, 400)
    const coding = negotiateContentCoding(c.req.raw.headers.get('accept-encoding'))
    if (coding === 'not-acceptable') return c.body(null, 406)
    if (active >= 4) return syncRefusal('admissionFull', 'delta capacity exhausted')
    const startedAt = performance.now()
    active++
    let released = false
    const release = () => { if (!released) { released = true; active-- } }
    const refuse = (reason: SyncBootstrapRequiredReason) => {
      release()
      return syncRefusal('bootstrapRequired', reason)
    }
    const signal = c.req.raw.signal
    let iterator: ReturnType<AuthorityPort['changesRange']> extends AsyncIterable<infer T> ? AsyncIterator<T> : never
    try {
      const { feedId, epoch } = await deps.serving.identity()
      const { from, to } = query.data
      if (query.data.feedId !== feedId || query.data.epoch !== epoch) return refuse('feed-identity-mismatch')
      const head = await deps.authority.captureHead()
      if (from > head || (to !== undefined && to > head)) return refuse('future-cursor')
      const target = to ?? head
      const floor = await deps.serving.retentionFloor()
      if (floor > from + 1) return refuse('compacted-or-unknown')
      iterator = deps.authority.changesRange(principal, from, target, deps.pageRows ?? 500)[Symbol.asyncIterator]()
      // Prime before returning HTTP 200: bounded-read refusals retain their reason.
      let next = await iterator.next()
      if (!next.done && next.value.kind === 'rescope') {
        await iterator.return?.()
        return refuse('rescope')
      }
      const transferId = randomUUID()
      const metrics: SyncTransferMetrics = {
        transferId, principal: String(principalRoutingId(principal)), coding, startedAt,
        captureMs: performance.now() - startedAt, bytesIn: 0, bytesOut: 0,
        rows: 0, records: 0, outcome: 'running',
      }
      const encoder = new NdjsonEncoder()
      const encode = (record: SyncRecord) => {
        const bytes = encoder.push(record) ?? encoder.flush()!
        metrics.bytesIn += bytes.byteLength
        return bytes
      }
      let stopped = false
      const abort = () => {
        stopped = true
        release()
        signal.removeEventListener('abort', abort)
        void Promise.resolve(iterator.return?.()).catch(() => {})
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const source = {
        abort,
        async *[Symbol.asyncIterator]() {
          let records = 0
          let rows = 0
          let previous = from
          try {
            if (stopped) return
            yield encode({ type: 'syncMeta', formatVersion: 1, mode: 'delta', transferId,
              feedId, epoch, seq: target, fromSeq: from, minAvailableSeq: floor,
              wireVersion: WIRE_VERSION, wireSchemaDigest: wireSchemaDigest() })
            while (!next.done && !stopped) {
              const delivery = next.value
              if (delivery.kind === 'rescope') {
                metrics.outcome = 'authorization-changed'
                yield encode({ type: 'syncError', transferId, reason: 'authorization-changed' })
                return
              }
              const bytes = encode({ type: 'feedDelta', feedId, epoch, fromSeq: previous,
                seq: delivery.throughSeq, minAvailableSeq: await deps.serving.retentionFloor(),
                changes: delivery.changes.map(toFeedChange) })
              previous = delivery.throughSeq
              records++
              rows += delivery.changes.length
              metrics.records = records
              metrics.rows = rows
              yield bytes
              await setImmediate()
              if (stopped) return
              next = await iterator.next()
            }
            if (!stopped) {
              metrics.outcome = 'complete'
              yield encode({ type: 'syncComplete', transferId, seq: target, records, rows })
            }
          } catch (error) {
            metrics.err = error
            metrics.outcome = error instanceof RowTooLarge ? 'row-too-large' : 'read-failed'
            if (!stopped) yield encode({ type: 'syncError', transferId,
              reason: error instanceof RowTooLarge ? 'row-too-large' : 'read-failed' })
          } finally {
            abort()
          }
        },
      }
      const headers = syncResponseHeaders(coding)
      headers.set('Podium-Transfer-Id', transferId)
      return new Response(observeSyncTransfer(pipeSyncBody(source, coding, signal), metrics), { headers })
    } catch (error) {
      release()
      if (error instanceof ChangeRangeBootstrapRequired) return refuse(error.reason)
      throw error
    }
  })
}
