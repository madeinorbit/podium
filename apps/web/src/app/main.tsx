import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginGate } from '@/features/setup/LoginGate'
import { startWebLogging } from '@/lib/logging'
import { startupPodiumHref, startupPodiumRouteHref } from '@/lib/podium-link'
import { AppStarted } from './AppStarted'
import { AppShell } from './AppShell'
import '@/index.css'
import '@/styles.css'
import { redirectPhoneToMobileApp } from './mobile-entry-redirect'
import { installVitePreloadErrorRecovery } from './preload-error-recovery'
import { ThemeProvider } from './theme'
import { WireSkewBanner } from './WireSkewBanner'

const MotionDemo = lazy(() =>
  import('@/lib/motion/MotionDemo').then((module) => ({ default: module.MotionDemo })),
)

// FIRST, before anything can throw: the global handlers and the flight recorder
// are what turn a crash during boot into a report on the user's own server
// [spec: 2026-08-11-logging-strategy-design, "Crash capture (end-to-end)"].
installVitePreloadErrorRecovery()
startWebLogging()

const root = document.getElementById('root')
if (!root) throw new Error('Podium web root was not found')
const params = new URLSearchParams(window.location.search)
const showMotionDemo = params.get('e2e') === '1' && params.get('motion-demo') === '1'

// A phone reaching the desktop shell means a cached service worker beat the
// server's redirect to it (POD-359) — send it on before mounting anything.
if (!redirectPhoneToMobileApp()) {
  const initialPodiumHref = startupPodiumHref(window.location)
  if (initialPodiumHref) {
    window.history.replaceState(null, '', startupPodiumRouteHref(window.location))
  }
  createRoot(root).render(
    <StrictMode>
      <AppStarted />
      <ThemeProvider>
        {/* OUTSIDE every gate (POD-1610). The boot check raises its notice before
            login or setup resolve, and a build that cannot read the server is
            worth saying on any screen — a banner mounted deeper renders only on
            the screens the skew has not already broken. */}
        <WireSkewBanner />
        {showMotionDemo ? (
          <Suspense fallback={<div className="app-loading" aria-hidden="true" />}>
            <MotionDemo />
          </Suspense>
        ) : (
          <LoginGate>
            {(auth) => <AppShell auth={auth} initialPodiumHref={initialPodiumHref} />}
          </LoginGate>
        )}
      </ThemeProvider>
    </StrictMode>,
  )
}
