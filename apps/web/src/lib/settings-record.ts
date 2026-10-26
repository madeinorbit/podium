import type { MobxPool } from '@podium/client-graph/pool'
import { useOpeningView } from '@podium/client-graph/react'
import { SettingsRecordRequest } from '@podium/client-graph/requested-records'
import { followVisibleRequest } from '@podium/client-graph/visible-request'
import type { PodiumSettings } from '@podium/runtime'
import { useEffect } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'

const createSettingsRecord = (pool: MobxPool) => new SettingsRecordRequest(pool)
export function useSettingsRecord(read: () => Promise<PodiumSettings>) {
  const request = useOpeningView(useWorklistPool(), createSettingsRecord)
  useEffect(() => {
    if (!request) return
    return followVisibleRequest(
      () => {
        if (!request.loading) void request.read(read)
      },
      {
        visible: () => document.visibilityState !== 'hidden',
        subscribe: (changed) => {
          document.addEventListener('visibilitychange', changed)
          return () => document.removeEventListener('visibilitychange', changed)
        },
      },
    )
  }, [request, read])
  return request
}
