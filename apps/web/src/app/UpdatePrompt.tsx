import { useRegisterSW } from './pwa-register'
import type { JSX } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { UpdateDialog } from '@/features/updates/UpdateDialog'
import { useUpdateState } from '@/features/updates/use-update-state'
import { serverConfig } from './trpc'

const UPDATE_CHECK_MS = 60_000

export interface UpdatePromptProps {
  httpOrigin?: string
}

export function UpdatePrompt({ httpOrigin }: UpdatePromptProps): JSX.Element {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const intervalRef = useRef<number | null>(null)
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      registrationRef.current = registration
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current)
      intervalRef.current = window.setInterval(() => void registration.update(), UPDATE_CHECK_MS)
    },
  })

  useEffect(
    () => () => {
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current)
    },
    [],
  )

  // The decisive check for an installed PWA: the moment it returns to the
  // foreground, ask the service worker whether a new build shipped while hidden.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void registrationRef.current?.update()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Take over the new worker, then reload on controllerchange. The fallback is
  // still needed for a normal browser tab the new worker never claims.
  const reload = useCallback(() => {
    navigator.serviceWorker?.addEventListener('controllerchange', () => window.location.reload(), {
      once: true,
    })
    void updateServiceWorker(true)
    window.setTimeout(() => window.location.reload(), 2000)
  }, [updateServiceWorker])

  const resolvedOrigin = httpOrigin ?? serverConfig(window.location).httpOrigin
  const { view, actions } = useUpdateState({
    httpOrigin: resolvedOrigin,
    needRefresh,
    reload,
  })
  return <UpdateDialog view={view} actions={actions} />
}
