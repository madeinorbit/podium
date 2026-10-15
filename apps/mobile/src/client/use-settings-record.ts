import { SettingsRecordRequest } from '@podium/client-graph/requested-records'
import { useEffect, useMemo } from 'react'
import { useTrpc } from './hooks'
import { useMobilePool } from './mobile-pool'
import { followPhoneRequest } from './visible-request'

/** Settings stay in their shared pool model while this screen follows them. */
export function useSettingsRecord() {
  const pool = useMobilePool()
  const trpc = useTrpc()
  const request = useMemo(() => (pool ? new SettingsRecordRequest(pool) : null), [pool])
  useEffect(() => {
    const stop = followPhoneRequest(() => {
      if (request && !request.loading) void request.read(() => trpc.settings.get.query())
    })
    return () => {
      stop()
      request?.close()
    }
  }, [request, trpc])
  return request
}
