import { useRegisterSW } from 'virtual:pwa-register/react'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'

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

  if (!needRefresh) return null
  return (
    <div className="update-toast" role="status">
      <span>New version available</span>
      <button type="button" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
      <button type="button" className="update-toast-dismiss" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  )
}
