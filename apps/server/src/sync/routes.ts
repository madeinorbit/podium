import { createLogger } from '@podium/logger'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { parseSyncDeltaQuery, WIRE_VERSION, wireSchemaDigest, type Principal, type SyncRecord, type SyncBootstrapRequiredReason } from '@podium/protocol'
import { ChangeRangeBootstrapRequired, type AuthorityPort } from '@podium/sync'
import type { Hono } from 'hono'
import { toFeedChange } from '../gateway/feed-serving'
import { NdjsonEncoder, RowTooLarge } from './ndjson-encoder'
import { pipeSyncBody } from './pipe-sync-body'
import { negotiateContentCoding, syncResponseHeaders } from './content-coding'

const log = createLogger('sync-delta')

import type { SyncDeltaPorts } from './route-support'

export interface SyncRouteDeps extends SyncDeltaPorts {
  principal(request: Request): Promise<Principal | undefined>
  pageRows?: number
}

/** Auth/readiness/CORS middleware is installed by the composition root. */
export function registerSyncRoutes(app: Hono, deps: SyncRouteDeps): void {
  let active = 0
  app.get('/sync/delta', async (c) => {
    const principal = await deps.principal(c.req.raw)
    if (!principal) return c.json({ error: 'authenticated feed principal required' }, 403)
    const query = parseSyncDeltaQuery(new URL(c.req.url).searchParams)
    if (!query.success) return c.json({ error: 'invalid delta range' }, 400)
    const coding = negotiateContentCoding(c.req.raw.headers.get('accept-encoding'))
    if (coding === 'not-acceptable') return c.body(null, 406)
    if (active >= 4) return c.json({ error: 'delta capacity exhausted' }, 503, { 'Retry-After': '5' })
    active++
    let released = false
    const release = () => { if (!released) { released = true; active-- } }
    const refuse = (reason: SyncBootstrapRequiredReason) => {
      release()
      return c.json({ kind: 'bootstrap-required' as const, reason }, 409)
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
      const encoder = new NdjsonEncoder()
      const encode = (record: SyncRecord) => encoder.push(record) ?? encoder.flush()!
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
                yield encode({ type: 'syncError', transferId, reason: 'authorization-changed' })
                return
              }
              const bytes = encode({ type: 'feedDelta', feedId, epoch, fromSeq: previous,
                seq: delivery.throughSeq, minAvailableSeq: await deps.serving.retentionFloor(),
                changes: delivery.changes.map(toFeedChange) })
              previous = delivery.throughSeq
              records++
              rows += delivery.changes.length
              yield bytes
              await setImmediate()
              if (stopped) return
              next = await iterator.next()
            }
            if (!stopped) yield encode({ type: 'syncComplete', transferId, seq: target, records, rows })
          } catch (error) {
            log.warn('delta stream failed', { transferId, err: error })
            if (!stopped) yield encode({ type: 'syncError', transferId,
              reason: error instanceof RowTooLarge ? 'row-too-large' : 'read-failed' })
          } finally {
            abort()
          }
        },
      }
      return new Response(pipeSyncBody(source, coding, signal), { headers: syncResponseHeaders(coding) })
    } catch (error) {
      release()
      if (error instanceof ChangeRangeBootstrapRequired) return refuse(error.reason)
      throw error
    }
  })
}
