import type { JSX } from 'react'
import { lazy, StrictMode, Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginGate } from '@/features/setup/LoginGate'
import { restartPodiumShell } from '@/features/setup/restart-shell'
import { throughRestarts } from '@/lib/chunk-recovery'
import { startWebLogging } from '@/lib/logging'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { startupPodiumHref, startupPodiumRouteHref } from '@/lib/podium-link'
import { AppShell } from './AppShell'
import { AppStarted } from './AppStarted'
import { BootScreen } from './BootScreen'
import '@/index.css'
import '@/styles.css'
import { redirectPhoneToMobileApp } from './mobile-entry-redirect'
import { installVitePreloadErrorRecovery } from './preload-error-recovery'
import { ThemeProvider } from './theme'
import { WireSkewBanner } from './WireSkewBanner'
import { DaemonPairingBanner } from './DaemonPairingBanner'

const MotionDemo = lazy(() =>
  throughRestarts(() => import('@/lib/motion/MotionDemo')).then((module) => ({
    default: module.MotionDemo,
  })),
)

const IterationModeFrame = import.meta.env.PODIUM_ITERATION_MODE
  ? lazy(() =>
      throughRestarts(() => import('./IterationModeFrame')).then((module) => ({
        default: module.IterationModeFrame,
      })),
    )
  : null

// Deliberately EAGER, unlike the frame above: this is the screen shown when the
// payload could not start, so it must not depend on fetching another chunk from
// the very thing that is broken (POD-2508).
function PayloadUnavailablePage({ reason }: { reason?: string }): JSX.Element {
  const [status, setStatus] = useState<string | null>(null)
  const [repairing, setRepairing] = useState(false)

  const repair = (): void => {
    if (repairing) return
    const nativeRepair = nativeDesktopBridge()?.repairPayload
    if (!nativeRepair) {
      setStatus('This shell cannot restore its payload. Install the latest Podium app.')
      return
    }
    setRepairing(true)
    setStatus(null)
    void nativeRepair()
      .then(() => {
        setStatus('Signed recovery payload restored. Waiting for Podium to restart and catch up.')
      })
      .catch((error: unknown) => {
        setStatus(
          `Payload repair failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        setRepairing(false)
      })
  }

  return (
    <BootScreen
      eyebrow="Payload / unavailable"
      headline="Podium needs its payload repaired"
      prose="The app frame is intact, but the server, daemon, or web payload could not start. Restore the signed seed; the normal fleet updater will then bring this Mac to the current target."
      fields={[
        { label: 'Payload home', value: 'Application Support' },
        { label: 'Startup failure', value: reason ?? 'Payload did not answer the shell' },
        { label: 'Recovery', value: status ?? 'Ready to restore signed seed' },
      ]}
      trace={{ from: 'App frame', to: 'Fleet payload' }}
      pending={repairing}
      reassurance="The damaged payload is retained beside the replacement for diagnosis."
      primary={{
        label: repairing ? 'Repairing…' : 'Repair payload',
        onClick: repair,
      }}
      secondary={{
        label: 'Try again',
        onClick: () => window.location.reload(),
      }}
    />
  )
}

function ServerTransportBlockedPage({ reason }: { reason?: string }): JSX.Element {
  return (
    <BootScreen
      eyebrow="Server / blocked"
      headline="This server needs a secure connection"
      prose="Podium Desktop allows HTTP and WS only for localhost and loopback IP addresses. Change every other server URL to HTTPS or WSS."
      fields={[
        {
          label: 'Connection refusal',
          value: reason ?? 'The configured server uses an insecure transport',
          tone: 'fault',
        },
        { label: 'Blocked server access', value: 'Not granted' },
      ]}
      trace={{ from: 'Desktop app', to: 'Remote server' }}
      detail={reason}
      primary={{
        label: 'Restart Podium',
        onClick: () => void restartPodiumShell(),
      }}
      panelLabel="Connection policy"
    />
  )
}

// FIRST, before anything can throw: the global handlers and the flight recorder
// are what turn a crash during boot into a report on the user's own server
// [spec: 2026-08-11-logging-strategy-design, "Crash capture (end-to-end)"].
installVitePreloadErrorRecovery()
startWebLogging()

const root = document.getElementById('root')
if (!root) throw new Error('Podium web root was not found')
const params = new URLSearchParams(window.location.search)
const showMotionDemo = params.get('e2e') === '1' && params.get('motion-demo') === '1'
const payloadUnavailable =
  (globalThis as { __PODIUM_PAYLOAD_UNAVAILABLE__?: boolean }).__PODIUM_PAYLOAD_UNAVAILABLE__ ===
  true
const payloadStartupError = (globalThis as { __PODIUM_PAYLOAD_ERROR__?: string })
  .__PODIUM_PAYLOAD_ERROR__
const serverTransportBlocked =
  (globalThis as { __PODIUM_SERVER_TRANSPORT_BLOCKED__?: boolean })
    .__PODIUM_SERVER_TRANSPORT_BLOCKED__ === true
const serverTransportError = (globalThis as { __PODIUM_SERVER_TRANSPORT_ERROR__?: string })
  .__PODIUM_SERVER_TRANSPORT_ERROR__

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
        {serverTransportBlocked ? (
          <ServerTransportBlockedPage reason={serverTransportError} />
        ) : payloadUnavailable ? (
          <PayloadUnavailablePage reason={payloadStartupError} />
        ) : (
          <>
            {/* OUTSIDE every gate (POD-1610). The boot check raises its notice before
            login or setup resolve, and a build that cannot read the server is
            worth saying on any screen — a banner mounted deeper renders only on
            the screens the skew has not already broken. */}
            <WireSkewBanner />
            <DaemonPairingBanner />
            {/* OUTSIDE every gate for the same reason, and for one more: the login
            and setup screens are exactly where an iterate tab is most easily
            mistaken for the installed app. Renders nothing in a built bundle. */}
            {IterationModeFrame ? (
              <Suspense fallback={null}>
                <IterationModeFrame />
              </Suspense>
            ) : null}
            {showMotionDemo ? (
              <Suspense fallback={<div className="app-loading" aria-hidden="true" />}>
                <MotionDemo />
              </Suspense>
            ) : (
              <LoginGate>
                {(auth) => <AppShell auth={auth} initialPodiumHref={initialPodiumHref} />}
              </LoginGate>
            )}
          </>
        )}
      </ThemeProvider>
    </StrictMode>,
  )
}
