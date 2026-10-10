import { useSettingsOpening } from './opening-context'
import { useOpeningView } from '@podium/client-graph/react'
import { RecordRequest, SettingsRecordRequest } from '@podium/client-graph/requested-records'
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
  return { request, reload }
}

const createSettingsRecord = (pool: MobxPool) => new SettingsRecordRequest(pool)
export function useSettingsRecord(read: () => Promise<PodiumSettings>) {
  const request = useOpeningView(useWorklistPool(), createSettingsRecord)
  useEffect(() => { void request?.read(read) }, [request, read])
  return request
}
export const accountKey = (row: PoolRows['account']) => row.id
export const memberKey = (row: PoolRows['member']) => row.id
export const deviceKey = (row: PoolRows['device']) => row.sessionId
