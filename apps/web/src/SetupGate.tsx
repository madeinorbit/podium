import { type ReactNode, useEffect, useState } from 'react'
import { AppErrorPage } from './AppErrorPage'
import { SetupView } from './SetupView'
import { serverConfig } from './trpc'

type Phase = 'loading' | 'setup' | 'ready' | 'unreachable'

// Bounded backoff for an unreachable backend before surfacing an error (vs. retrying forever).
const MAX_RETRIES = 5
const BASE_DELAY_MS = 250
const MAX_DELAY_MS = 4000

/** Desktop shell exposes a restart hook so a mode change re-runs the shell (re-reads config);
 *  a web reload alone would keep the same shell process. Browser → plain reload. */
function onSetupSaved(): void {
  const restart = (window as unknown as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__
  if (restart) restart()
  else window.location.reload()
}

/**
 * Probe /setup/config. Returns the next phase, or throws when the backend is unreachable
 * (network/CORS failure) so the caller retries instead of silently proceeding.
 *
 * The distinction matters: a `fetch` rejection means we never reached the server (e.g. the
 * desktop webview blocked a cross-origin request before CORS was added) — proceeding as
 * "ready" there hides onboarding outright. A 404 is the opposite: we DID reach a backend, it
 * just predates the setup route, so it can't need setup and must not block the app.
 */
async function probeSetup(httpOrigin: string): Promise<'setup' | 'ready'> {
  const res = await fetch(`${httpOrigin}/setup/config`) // rejects only when unreachable → caller retries
  if (res.status === 404) return 'ready' // backend without the route → don't block the app
  if (!res.ok) throw new Error(`setup probe failed: ${res.status}`)
  // A backend without the setup route serves the SPA's index.html for /setup/config (a 200 whose
  // body is HTML, not JSON) — e.g. a relay older than the route, or one out of sync with this
  // client after a partial update. That is the SAME case as a 404: it can't need setup, so proceed
  // rather than treating the unparseable body as "unreachable" and blocking the app.
  let data: { needsSetup?: unknown }
  try {
    data = (await res.json()) as { needsSetup?: unknown }
  } catch {
    return 'ready'
  }
  if (typeof data.needsSetup !== 'boolean') return 'ready' // unexpected shape → proceed, don't block
  return data.needsSetup ? 'setup' : 'ready'
}

/** Shown after retries are exhausted: the backend never answered, so we cannot tell whether
 *  setup is needed. Better to say so than to silently render the app in an unknown state. */
function SetupUnreachable({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <AppErrorPage
      title="Can’t reach the Podium backend"
      message="The app couldn’t load its setup status. Check that the server is running, then retry."
      onRetry={onRetry}
    />
  )
}

/** Gates the app on setup: shows SetupView until a deployment mode is configured. */
export function SetupGate({ children }: { children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading')
  const [attempt, setAttempt] = useState(0)
  const httpOrigin = serverConfig(window.location).httpOrigin

  // `attempt` is a manual retry trigger: bumping it re-runs the probe from scratch after the
  // unreachable error. It isn't read in the body, so biome flags it as an extra dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt only re-triggers the probe on retry
  useEffect(() => {
    // Client/daemon desktop: the shell already chose this install's mode and pointed us at a
    // remote server. The remote's setup state is not this client's to read (cross-origin, often
    // no CORS) or to change (SetupView would POST to the remote), so skip the probe entirely.
    if ((window as unknown as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__) {
      setPhase('ready')
      return
    }

    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setPhase('loading')

    const run = (tries: number): void => {
      probeSetup(httpOrigin)
        .then((next) => {
          if (alive) setPhase(next)
        })
        .catch(() => {
          if (!alive) return
          // Unreachable backend: retry with bounded exponential backoff, then surface the error
          // rather than masking a setup-endpoint regression as a normal app launch.
          if (tries < MAX_RETRIES) {
            const delay = Math.min(BASE_DELAY_MS * 2 ** tries, MAX_DELAY_MS)
            timer = setTimeout(() => {
              if (alive) run(tries + 1)
            }, delay)
          } else {
            setPhase('unreachable')
          }
        })
    }
    run(0)

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [httpOrigin, attempt])

  if (phase === 'loading') return null
  if (phase === 'unreachable') return <SetupUnreachable onRetry={() => setAttempt((n) => n + 1)} />
  if (phase === 'setup') return <SetupView httpOrigin={httpOrigin} onSaved={onSetupSaved} />
  return <>{children}</>
}
