import type { MobileClientSession } from '@podium/protocol'
import { useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
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

/**
 * Focus-owned and profile-owned. No module cache is used: a device inventory is
 * small, security-sensitive, and belongs to exactly the active server profile.
 * Switching profiles invalidates the render immediately, before the new request
 * resolves, so another server's device names never flash on screen.
 */
export function useConnectedDevices(): ConnectedDevicesFeed {
  const { profile, bearer } = useServerProfile()
  const key = serverProfileRequestKey(profile)
  const demo = demoEnabled()
  const [answer, setAnswer] = useState<{
    key: string
    sessions: MobileClientSession[] | null
    loading: boolean
    failed: boolean
  }>(() => ({ key, sessions: null, loading: !demo, failed: false }))
  const loadRef = useRef<() => void>(() => {})
  const reload = useCallback(() => loadRef.current(), [])

  useFocusEffect(
    useCallback(() => {
      if (demo) return
      let cancelled = false
      let generation = 0
      const load = (): void => {
        const request = ++generation
        setAnswer((current) => ({
          key,
          sessions: current.key === key ? current.sessions : null,
          loading: true,
          failed: false,
        }))
        void readConnectedDevices(profile.httpOrigin, bearer).then(
          (sessions) => {
            if (!cancelled && request === generation) {
              setAnswer({ key, sessions, loading: false, failed: false })
            }
          },
          () => {
            if (!cancelled && request === generation) {
              setAnswer((current) => ({
                key,
                sessions: current.key === key ? current.sessions : null,
                loading: false,
                failed: true,
              }))
            }
          },
        )
      }
      loadRef.current = load
      load()
      return () => {
        cancelled = true
        generation += 1
        loadRef.current = () => {}
      }
    }, [bearer, demo, key, profile.httpOrigin]),
  )

  if (demo) {
    return { sessions: DEMO_MOBILE_SESSIONS, loading: false, failed: false, reload }
  }
  if (answer.key !== key) {
    return { sessions: null, loading: true, failed: false, reload }
  }
  return { sessions: answer.sessions, loading: answer.loading, failed: answer.failed, reload }
}
