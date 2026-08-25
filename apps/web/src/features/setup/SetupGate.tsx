import { isServerReadiness, type ServerReadiness } from '@podium/model'
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react'
import { LoadingScreen } from '@/app/LoadingScreen'
import { serverConfig } from '@/app/trpc'
import { throughRestarts } from '@/lib/chunk-recovery'
import { hasSyncedReplica } from '@/lib/replica-presence'
import { isTooOldForLocalData, localBuildStamp } from './local-build-guard'
import { restartPodiumShell } from './restart-shell'
import { SetupStaleBuild } from './SetupStaleBuild'
import { SetupUnreachable } from './SetupUnreachable'
import { checkServedAssets, checkServerVersion } from './version-guard'

const SetupView = lazy(() =>
  throughRestarts(() => import('./SetupView')).then((module) => ({ default: module.SetupView })),
)

type Phase =
  | 'loading'
  | 'setup'
  | 'local-setup'
  | 'remote-setup'
  | 'restart-required'
  | 'ready'
  /** Backoff exhausted and nothing on this device to render: the recovery console. */
  | 'unreachable'
  /** Backoff exhausted AND the UI that came up is older than the data on this device: the
   *  baked-fallback stale guard (spec §2.1 durability layer 3). Refuses rather than runs. */
  | 'stale-build'
  /** Backoff exhausted, but this device has synced before — render the cached app
   *  (see the fall-through below) and keep asking the backend in the background. */
  | 'degraded'

export interface SetupStatus extends Partial<ServerReadiness> {
  needsSetup?: unknown
}

// Bounded backoff for an unreachable backend before surfacing an error (vs. retrying forever).
const MAX_RETRIES = 5
const BASE_DELAY_MS = 250
const MAX_DELAY_MS = 4000
/** How often a gate that gave up re-asks. The browser's `online` event is the fast
 *  path, but it never fires for a server that came back behind a healthy network. */
const RECOVERY_POLL_MS = 15_000

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
): Exclude<Phase, 'loading' | 'unreachable' | 'stale-build'> {
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

async function probeSetup(
  httpOrigin: string,
): Promise<Exclude<Phase, 'loading' | 'unreachable' | 'stale-build'>> {
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

/** Remote desktop modes must not expose setup mutations, but they still need the server-owned
 * readiness boundary. Older servers predate the public CORS-enabled endpoint, so an absent,
 * invalid, or unreachable probe retains their historical pass-through behavior. */
async function probeRemoteReadiness(
  httpOrigin: string,
): Promise<Exclude<Phase, 'loading' | 'unreachable' | 'stale-build'>> {
  try {
    const response = await fetch(`${httpOrigin}/readiness`)
    if (!response.ok) return 'ready'
    const status: unknown = await response.json()
    if (!isServerReadiness(status)) {
      return status && typeof status === 'object' && 'state' in status ? 'remote-setup' : 'ready'
    }
    if (status.state === 'ready' || status.state === 'degraded') return 'ready'
    return status.state === 'activation_pending' ? 'restart-required' : 'remote-setup'
  } catch {
    return 'ready'
  }
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
    // Client/daemon desktop: never expose the remote's setup mutations. New servers publish a
    // CORS-enabled readiness fact so this client can fail closed with host-directed recovery;
    // older servers without that fact retain the pre-readiness pass-through behavior.
    if ((window as unknown as { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__) {
      let alive = true
      setPhase('loading')
      void probeRemoteReadiness(httpOrigin).then((next) => {
        if (alive) setPhase(next)
      })
      return () => {
        alive = false
      }
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
            // THE ONE CASE THAT MUST NOT FALL THROUGH (spec §2.1, durability layer 3).
            // The desktop shell fell back to the UI baked into the .app, and that copy
            // is older than the build that last wrote this device's data — so the rows
            // waiting for it may be shapes it has never seen. Refuse instead of running,
            // and say the one thing that fixes it. See ./local-build-guard.
            if (isTooOldForLocalData()) {
              setPhase('stale-build')
              return
            }
            // A machine that has synced before cannot need first-run setup, so an
            // unreachable backend is no reason to withhold the workspace it already
            // holds: fall through to the app and let it render from its replica
            // (POD-2057). Without that local slice there is nothing to fall through
            // TO, and the recovery console is the honest screen.
            setPhase(hasSyncedReplica() ? 'degraded' : 'unreachable')
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

    /**
     * AND THE OTHER HALF OF "IS THIS THE SAME APP" (POD-2721): the wire may
     * match perfectly while the served website has been swapped out from under
     * this page. Separate, deliberately unawaited, and it never reloads — it
     * only raises the banner — so it cannot delay or divert the gate above.
     *
     * Worth doing at boot as well as on reconnect, because a tab restored from
     * the browser's back-forward cache boots against whatever the server
     * happens to be serving now.
     */
    void checkServedAssets(httpOrigin)

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [httpOrigin, attempt])

  // AUTO-RECOVERY, for both ways the probe can end badly. Neither phase is a
  // resting place: 'degraded' still owes the user the answer it could not get,
  // and 'unreachable' has nothing to show until the backend speaks. So keep
  // asking — on the OS's own signal that the network returned, and on a timer
  // for the restarts it never announces — instead of waiting for a human to
  // press a button that may be on a screen nobody is looking at.
  //
  // A failed re-probe is deliberately silent: it leaves the phase alone, so a
  // degraded app is never yanked back to a loading screen and the recovery
  // console never flickers. Only an ANSWER moves the gate — including a
  // `needsSetup` one, which sends even a degraded app to the wizard: it is the
  // same answer a reload would get, and an unconfigured backend has no session
  // to sync with anyway.
  useEffect(() => {
    if (phase !== 'degraded' && phase !== 'unreachable') return
    let alive = true
    const reprobe = (): void => {
      probeSetup(httpOrigin)
        .then((next) => {
          if (alive) setPhase(next)
        })
        .catch(() => {})
    }
    const timer = setInterval(reprobe, RECOVERY_POLL_MS)
    window.addEventListener('online', reprobe)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('online', reprobe)
    }
  }, [phase, httpOrigin])

  // The splash, not nothing: this used to return null for the setup probe
  // round-trip. The reload-in-flight case stays on loading too, and a splash
  // beats a blank page there as well (POD-1249).
  if (phase === 'loading') return <LoadingScreen />
  if (phase === 'unreachable') {
    return <SetupUnreachable httpOrigin={httpOrigin} onRetry={() => setAttempt((n) => n + 1)} />
  }
  if (phase === 'stale-build') {
    // The stamp is what put us here, so it is present; the fall-back keeps the render total
    // rather than making a screen that refuses to run depend on a non-null assertion.
    const stamp = localBuildStamp()
    if (stamp) {
      return <SetupStaleBuild stamp={stamp} onRetry={() => setAttempt((n) => n + 1)} />
    }
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
        <SetupView httpOrigin={httpOrigin} onSaved={onSetupSaved} blockedState="restart-required" />
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
  return <>{children}</> // 'ready', and 'degraded' — the offline fall-through
}
