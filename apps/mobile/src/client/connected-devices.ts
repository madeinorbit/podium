import type { DeviceSignInView } from '@podium/protocol'
import { useFocusEffect } from 'expo-router'
import { useCallback } from 'react'
import { useSettingsOpening } from '../screens/settings-opening'
import { readConnectedDevices } from './connected-devices-api'
import { DEMO_MOBILE_SESSIONS, demoEnabled } from './demoData'
import { useMobilePoolProjection } from './mobile-pool'
import { useServerProfile } from './ServerProfileGate'
import { followPhoneRequest } from './visible-request'

export interface ConnectedDevicesFeed {
  sessions: DeviceSignInView[] | null
  loading: boolean
  failed: boolean
  reload: () => void
}
/** The active principal owns the pool. Profile changes create a new request
 * opening, fence its predecessor, and cannot show another server's devices. */
export function useConnectedDevices(): ConnectedDevicesFeed {
  const { profile, bearer } = useServerProfile()
  const request = useSettingsOpening()?.devices
  const demo = demoEnabled()
  const reload = useCallback(() => {
    if (request && !demo)
      void request.refresh(() => readConnectedDevices(profile.httpOrigin, bearer))
  }, [request, demo, profile.httpOrigin, bearer])
  useFocusEffect(
    useCallback(() => {
      let initial = true
      return followPhoneRequest(() => {
        if (!request || demo) return
        if (initial) {
          initial = false
          void request.ensure(() => readConnectedDevices(profile.httpOrigin, bearer), 15_000)
        } else reload()
      })
    }, [reload, request, demo, profile.httpOrigin, bearer]),
  )
  const read = useCallback(
    () => ({
      sessions: request?.answer === undefined ? null : request.orderedModels,
      loading: request?.loading ?? true,
      failed: Boolean(request?.error),
      reload,
    }),
    [request, reload],
  )
  const result = useMobilePoolProjection(read, {
    sessions: null,
    loading: true,
    failed: false,
    reload,
  })
  return demo ? { sessions: DEMO_MOBILE_SESSIONS, loading: false, failed: false, reload } : result
}
