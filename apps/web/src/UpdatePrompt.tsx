import { useRegisterSW } from 'virtual:pwa-register/react'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { forceReload } from './version-guard'

// Stable id so the prompt shows as a single toast (no stacking across
// re-renders) and can be dismissed when the user picks "Later".
const UPDATE_TOAST_ID = 'pwa-update-available'

// How often an open tab asks the service worker to look for a freshly
// deployed build. A redeploy restarts the web service, which serves a new
// content-hashed shell; this poll is how a long-lived tab notices.
const UPDATE_CHECK_MS = 60_000

export function UpdatePrompt(): JSX.Element | null {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      registrationRef.current = registration
      setInterval(() => void registration.update(), UPDATE_CHECK_MS)
    },
  })

  // The decisive check for an installed PWA: the moment it returns to the
  // foreground, ask the SW whether a new build shipped while it was hidden.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void registrationRef.current?.update()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Apply the update by evicting the service worker + all caches, then hard-reloading
  // (see version-guard's forceReload). We deliberately do NOT drive the workbox
  // skipWaiting/controllerchange dance: on a tab that loaded uncontrolled, and on
  // iOS-standalone PWAs where skipWaiting/controllerchange is unreliable, the new
  // worker never durably takes control — so the reloaded tab comes back on the stale
  // precached shell and re-detects the "new version", spinning the prompt on every
  // reload. Nuking the worker guarantees the next load is fetched fresh from the
  // current server (a single consistent build), which is what "update" must mean.
  const reload = () => void forceReload()

  // Surface the prompt through sonner (the shared <Toaster/> mounted in
  // AppShell) instead of a hand-rolled fixed-position toast. Sticky (no
  // auto-dismiss); "Reload" drives the SW takeover, "Later" hides it.
  useEffect(() => {
    if (!needRefresh) return
    toast('New version available', {
      id: UPDATE_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Reload', onClick: reload },
      cancel: { label: 'Later', onClick: () => setNeedRefresh(false) },
    })
    return () => {
      toast.dismiss(UPDATE_TOAST_ID)
    }
  }, [needRefresh, setNeedRefresh])

  return null
}
