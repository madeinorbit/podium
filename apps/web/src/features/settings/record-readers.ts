import { useSettingsOpening } from './opening-context'
import { useOpeningView } from '@podium/client-graph/react'
import { RecordRequest, ingestSettings, SETTINGS_RECORD_ID } from '@podium/client-graph/requested-records'
import { here } from '@podium/client-graph/lookup'
import type { MobxPool, PoolRows } from '@podium/client-graph/pool'
import type { RequestedEntity } from '@podium/client-graph/requested-records'
import type { PodiumSettings } from '@podium/runtime'
import { useCallback, useEffect, useMemo } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'

export function useSettingsRecords<E extends Exclude<RequestedEntity, 'podiumSettings'>>(
  entity: E, read: () => Promise<readonly PoolRows[E][]>, key: (row: PoolRows[E]) => string,
) {
  const pool = useWorklistPool()
  const create = useMemo(() => (pool: MobxPool) => new RecordRequest(pool, entity, key), [entity, key])
  const inherited = useSettingsOpening()
  const own = useOpeningView(pool, create, entity !== 'account' || !inherited)
  const request = (entity === 'account' ? inherited?.accounts ?? own : own) as RecordRequest<E> | null
  const reload = useCallback(() => request?.read(read), [request, read])
  useEffect(() => { if (request?.answer === undefined && !request.loading) void reload() }, [reload, request])
  // Public directories have no push contract yet. Refresh only while this
  // opening/document is visible; all readers see the same ingested identities.
  useEffect(() => {
    if (!request) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void reload()
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [request, reload])
  const projection = useCallback(() => request, [request])
  return { request: useWorklistPoolProjection(projection, null), reload }
}

export function useSettingsRecord(read: () => Promise<PodiumSettings>) {
  const pool = useWorklistPool()
  useEffect(() => {
    if (!pool) return
    let closed = false
    void read().then(settings => { if (!closed) ingestSettings(pool, settings) }).catch(error => pool.diagnostics.report('settings.get', error))
    return () => { closed = true }
  }, [pool, read])
  const project = useCallback((pool: MobxPool) => here(pool.model('podiumSettings', SETTINGS_RECORD_ID)), [])
  return useWorklistPoolProjection(project, undefined)
}
export const accountKey = (row: PoolRows['account']) => row.id
export const memberKey = (row: PoolRows['member']) => row.id
export const deviceKey = (row: PoolRows['device']) => row.sessionId
