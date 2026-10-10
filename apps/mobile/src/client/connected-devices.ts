import type { MobileClientSession } from '@podium/protocol'
import { RecordRequest } from '@podium/client-graph/requested-records'
import { followPhoneRequest } from './visible-request'
import { useFocusEffect } from 'expo-router'
import { useCallback, useMemo } from 'react'
import { useMobilePool, useMobilePoolProjection } from './mobile-pool'
import { readConnectedDevices } from './connected-devices-api'
import { DEMO_MOBILE_SESSIONS, demoEnabled } from './demoData'
import { useServerProfile } from './ServerProfileGate'
import { serverProfileRequestKey } from './server-profiles'

export interface ConnectedDevicesFeed {
  sessions: MobileClientSession[] | null
  loading: boolean
  failed: boolean
  reload: () => void
}
/** The active principal owns the pool. Profile changes create a new request
 * opening, fence its predecessor, and cannot show another server's devices. */
export function useConnectedDevices(): ConnectedDevicesFeed {
  const { profile, bearer } = useServerProfile()
  const pool = useMobilePool()
  const key = serverProfileRequestKey(profile)
  const demo = demoEnabled()
  const request = useMemo(() => pool ? new RecordRequest(pool, 'device', row => row.sessionId) : null, [pool, key])
  const reload = useCallback(() => {
    if (request && !demo) void request.read(() => readConnectedDevices(profile.httpOrigin, bearer))
  }, [request, demo, profile.httpOrigin, bearer])
  useFocusEffect(useCallback(() => {
    const stop = followPhoneRequest(() => { if (!request?.loading) reload() })
    return () => { stop(); request?.close() }
  }, [reload, request]))
  const read = useCallback(() => ({
    sessions: request?.answer === undefined ? null : request.models,
    loading: request?.loading ?? true,
    failed: Boolean(request?.error),
    reload,
  }), [request, reload])
  const result = useMobilePoolProjection(read, { sessions: null, loading: true, failed: false, reload })
  return demo ? { sessions: DEMO_MOBILE_SESSIONS, loading: false, failed: false, reload } : result
}
