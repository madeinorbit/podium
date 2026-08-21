import { lazy, StrictMode, Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginGate } from '@/features/setup/LoginGate'
import { SetupGate } from '@/features/setup/SetupGate'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { startWebLogging } from '@/lib/logging'
import { AppStarted } from './AppStarted'
import { AppShell } from './AppShell'
import { BootScreen } from './BootScreen'
import '@/index.css'
import '@/styles.css'
import { IterationModeFrame } from './IterationModeFrame'
import { redirectPhoneToMobileApp } from './mobile-entry-redirect'
import { ThemeProvider } from './theme'
import { WireSkewBanner } from './WireSkewBanner'

const MotionDemo = lazy(() =>
  import('@/lib/motion/MotionDemo').then((module) => ({
    default: module.MotionDemo,
  })),
)

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

// FIRST, before anything can throw: the global handlers and the flight recorder
// are what turn a crash during boot into a report on the user's own server
// [spec: 2026-08-11-logging-strategy-design, "Crash capture (end-to-end)"].
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

// A phone reaching the desktop shell means a cached service worker beat the
// server's redirect to it (POD-359) — send it on before mounting anything.
if (!redirectPhoneToMobileApp()) {
  createRoot(root).render(
    <StrictMode>
      <AppStarted />
      <ThemeProvider>
        {payloadUnavailable ? (
          <PayloadUnavailablePage reason={payloadStartupError} />
        ) : (
          <>
            {/* OUTSIDE every gate (POD-1610). The boot check raises its notice before
            login or setup resolve, and a build that cannot read the server is
            worth saying on any screen — a banner mounted deeper renders only on
            the screens the skew has not already broken. */}
            <WireSkewBanner />
            {/* OUTSIDE every gate for the same reason, and for one more: the login
            and setup screens are exactly where an iterate tab is most easily
            mistaken for the installed app. Renders nothing in a built bundle. */}
            <IterationModeFrame />
            {showMotionDemo ? (
              <Suspense fallback={<div className="app-loading" aria-hidden="true" />}>
                <MotionDemo />
              </Suspense>
            ) : (
              <LoginGate>
                <SetupGate>
                  <AppShell />
                </SetupGate>
              </LoginGate>
            )}
          </>
        )}
      </ThemeProvider>
    </StrictMode>,
  )
}
