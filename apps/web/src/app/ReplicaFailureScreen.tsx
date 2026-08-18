import { type JSX, useEffect, useState } from 'react'
import { LoginView } from '@/features/setup/LoginGate'
import {
  describeReplicaFailure,
  endpointLabel,
  isSignedOut,
  type ReplicaFailure,
} from '@/lib/replica-failure'
import { type ReloadWindow, reloadApp } from './AppErrorPage'
import { BootScreen, type BootTrace } from './BootScreen'

/**
 * WHAT THE OPERATOR GETS WHEN THE BOOT GATE FAILS.
 *
 * The gate has one failure state and the operator has three different problems,
 * so this is where they part company [POD-1304]:
 *
 *   no session          → the sign-in screen, because that is what is missing
 *   server still coming up → a screen that says so and clears itself
 *   anything else       → the shared failure screen, named and diagnosable
 *
 * Before this, all three were one page whose entire explanation was the string
 * `authenticated account is unavailable` — which is true of a signed-out browser,
 * a half-started server, and a proxy answering the auth route, and useful for
 * none of them.
 */

/** The two ends of the link, per cause. The near end is whatever is still up. */
function traceOf(failure: ReplicaFailure): BootTrace {
  switch (failure.kind) {
    case 'replica-blocked':
      return { from: 'interface', to: 'browser store' }
    case 'offline-unknown':
    case 'offline-ambiguous':
      return { from: 'this browser', to: 'network' }
    default:
      return { from: 'this browser', to: 'server' }
  }
}

/**
 * Re-probe the account route until it stops reporting a blocked data plane, then
 * reload into a clean boot. Polling rather than reloading on a timer: a reload
 * loop on a server that takes a minute to come up is a strobing screen, and the
 * operator cannot read a sentence that keeps restarting.
 */
function useClearsItself(httpOrigin: string, active: boolean, win?: ReloadWindow): void {
  useEffect(() => {
    if (!active) return
    let alive = true
    const timer = window.setInterval(() => {
      void fetch(`${httpOrigin}/auth/status`, { credentials: 'include' })
        .then((res) => (res.ok ? res.json() : undefined))
        .then((body: { readiness?: { dataPlane?: string } } | undefined) => {
          if (!alive || !body) return
          if (body.readiness === undefined || body.readiness.dataPlane === 'available') {
            reloadApp(win)
          }
        })
        .catch(() => {
          // Still down. The next tick asks again; nothing to report in between.
        })
    }, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [httpOrigin, active, win])
}

export function ReplicaFailureScreen({
  cause,
  detail,
  httpOrigin,
  win,
}: {
  cause: ReplicaFailure
  /** The raw fault text, for the disclosure. */
  detail: string
  httpOrigin: string
  win?: ReloadWindow
}): JSX.Element {
  // Cheap and deliberate: the sign-in screen sets a session cookie and then the
  // boot has to run again from the top — the gate's replica, its socket and its
  // outbox are all bound to a principal it has not seen yet.
  const [signedIn, setSignedIn] = useState(false)
  const starting = cause.kind === 'server-starting'
  useClearsItself(httpOrigin, starting, win)
  useEffect(() => {
    if (signedIn) reloadApp(win)
  }, [signedIn, win])

  if (isSignedOut(cause)) {
    return <LoginView httpOrigin={httpOrigin} onLoggedIn={() => setSignedIn(true)} />
  }

  const copy = describeReplicaFailure(cause, { endpoint: endpointLabel(httpOrigin) })
  return (
    <BootScreen
      eyebrow={copy.eyebrow}
      headline={copy.headline}
      prose={copy.prose}
      fields={copy.fields}
      trace={traceOf(cause)}
      reassurance={copy.reassurance}
      pending={copy.selfClearing === true}
      detail={detail}
      primary={{
        label: starting ? 'Check again' : 'Reload interface',
        onClick: () => reloadApp(win),
      }}
    />
  )
}
