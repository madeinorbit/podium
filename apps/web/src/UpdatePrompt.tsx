import { useRegisterSW } from 'virtual:pwa-register/react'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

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
    updateServiceWorker,
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

  // Reload robustly in BOTH installed-PWA and normal-browser tabs. The library's
  // updateServiceWorker(true) only reloads when workbox flags the activation as
  // an update (event.isUpdate), which is false for a tab that loaded uncontrolled
  // (common in a normal browser) — so on desktop Chrome the button did nothing.
  // Drive it ourselves: reload the instant the new SW takes control, with a short
  // fallback for a tab the freshly-activated SW never claims (it still serves the
  // new build, since skipWaiting has made it the active worker by then).
  const reload = () => {
    navigator.serviceWorker?.addEventListener('controllerchange', () => window.location.reload(), {
      once: true,
    })
    void updateServiceWorker(true)
    window.setTimeout(() => window.location.reload(), 2000)
  }

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
