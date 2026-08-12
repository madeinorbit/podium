import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react'
import { isServerReadiness, type ServerReadiness } from '@podium/model'
import { serverConfig } from '@/app/trpc'
import { SetupUnreachable } from './SetupUnreachable'
import { restartPodiumShell } from './restart-shell'
import { checkServerVersion } from './version-guard'

const SetupView = lazy(() => import('./SetupView').then((module) => ({ default: module.SetupView })))

type Phase =
  | 'loading'
  | 'setup'
  | 'local-setup'
  | 'remote-setup'
  | 'restart-required'
  | 'ready'
  | 'unreachable'

export interface SetupStatus extends Partial<ServerReadiness> {
  needsSetup?: unknown
}

// Bounded backoff for an unreachable backend before surfacing an error (vs. retrying forever).
const MAX_RETRIES = 5
const BASE_DELAY_MS = 250
const MAX_DELAY_MS = 4000

/** Desktop shell exposes a restart hook so a mode change re-runs the shell (re-reads config);
 *  a web reload alone would keep the same shell process. Browser → plain reload. */
function onSetupSaved(): void {
  void restartPodiumShell()
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
export function isTrustedLocalSetupOrigin(loc: Pick<Location, 'protocol' | 'hostname'>): boolean {
  if (loc.protocol === 'tauri:' || loc.hostname === 'tauri.localhost') return true
  return (
    loc.hostname === 'localhost' ||
    loc.hostname === '127.0.0.1' ||
    loc.hostname === '::1' ||
    loc.hostname === '[::1]'
  )
}

export function shouldApplyLocalSetupDefault(
  status: SetupStatus,
  loc: Pick<Location, 'protocol' | 'hostname'>,
  injectedRequest = (globalThis as { __PODIUM_LOCAL_SETUP__?: boolean }).__PODIUM_LOCAL_SETUP__ ===
    true,
  responseHint = false,
): boolean {
  return (
    status.needsSetup === true &&
    isTrustedLocalSetupOrigin(loc) &&
    (responseHint || injectedRequest)
  )
}

export function classifySetupStatus(
  status: SetupStatus,
  loc: Pick<Location, 'protocol' | 'hostname'>,
  injectedRequest?: boolean,
  responseHint = false,
): Exclude<Phase, 'loading' | 'unreachable'> {
  if (isServerReadiness(status)) {
    if (status.state === 'ready' || status.state === 'degraded') return 'ready'
    if (status.state === 'activation_pending') return 'restart-required'
    if (!isTrustedLocalSetupOrigin(loc)) return 'remote-setup'
    return shouldApplyLocalSetupDefault(status, loc, injectedRequest, responseHint)
      ? 'local-setup'
      : 'setup'
  }

  // A server claiming the readiness contract with an invalid combination must fail closed.
  // Older servers without readiness retain their boolean compatibility behavior.
  if ('state' in status || 'reason' in status || 'dataPlane' in status) return 'remote-setup'
  if (typeof status.needsSetup !== 'boolean' || !status.needsSetup) return 'ready'
  if (!isTrustedLocalSetupOrigin(loc)) return 'remote-setup'
  return shouldApplyLocalSetupDefault(status, loc, injectedRequest, responseHint)
    ? 'local-setup'
    : 'setup'
}

async function probeSetup(httpOrigin: string): Promise<Exclude<Phase, 'loading' | 'unreachable'>> {
  const res = await fetch(`${httpOrigin}/setup/config`) // rejects only when unreachable → caller retries
  if (res.status === 404) return 'ready' // backend without the route → don't block the app
  if (!res.ok) throw new Error(`setup probe failed: ${res.status}`)
  // A backend without the setup route serves the SPA's index.html for /setup/config (a 200 whose
  // body is HTML, not JSON) — e.g. a relay older than the route, or one out of sync with this
  // client after a partial update. That is the SAME case as a 404: it can't need setup, so proceed
  // rather than treating the unparseable body as "unreachable" and blocking the app.
  let data: SetupStatus
  try {
    data = (await res.json()) as SetupStatus
  } catch {
    return 'ready'
  }
  const localSetupHint = res.headers?.get('X-Podium-Local-Setup') === 'all-in-one'
  return classifySetupStatus(data, window.location, undefined, localSetupHint)
}

/** Shown after retries are exhausted: the backend never answered, so we cannot tell whether
 *  setup is needed. Better to say so than to silently render the app in an unknown state. */
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

    // Wire-version handshake first: a stale cached PWA shell talking to a bumped server must
    // hard-reload (evicting the SW cache) before we render anything. On a match / flaky
    // /version it resolves 'ok'; on a mismatch it triggers a reload and we stay on 'loading'
    // (the page is already reloading). 'blocked' (loop guard tripped) falls through to render.
    checkServerVersion(httpOrigin).then((result) => {
      if (alive && result !== 'reloaded') run(0)
    })

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [httpOrigin, attempt])

  if (phase === 'loading') return null
  if (phase === 'unreachable') {
    return <SetupUnreachable httpOrigin={httpOrigin} onRetry={() => setAttempt((n) => n + 1)} />
  }
  if (phase === 'local-setup') {
    return (
      <Suspense fallback={null}>
        <SetupView httpOrigin={httpOrigin} onSaved={onSetupSaved} localDefault />
      </Suspense>
    )
  }
  if (phase === 'remote-setup') {
    return (
      <Suspense fallback={null}>
        <SetupView httpOrigin={httpOrigin} onSaved={onSetupSaved} blockedState="remote-setup" />
      </Suspense>
    )
  }
  if (phase === 'restart-required') {
    return (
      <Suspense fallback={null}>
        <SetupView
          httpOrigin={httpOrigin}
          onSaved={onSetupSaved}
          blockedState="restart-required"
        />
      </Suspense>
    )
  }
  if (phase === 'setup') {
    return (
      <Suspense fallback={null}>
        <SetupView httpOrigin={httpOrigin} onSaved={onSetupSaved} />
      </Suspense>
    )
  }
  return <>{children}</>
}
