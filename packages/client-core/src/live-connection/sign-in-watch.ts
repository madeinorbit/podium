/**
 * A SIGN-IN THE SERVER ENDED IS NOT AN OUTAGE (POD-6910).
 *
 * When a member is removed, or one of their devices is signed out from the
 * device list, the server closes that device's sockets and refuses every new
 * one. A browser cannot read why a WebSocket upgrade was refused, so to the
 * hub that looks exactly like a server that went away: it showed the cached
 * workspace as "reconnecting" and dialled again every second or two, forever.
 *
 * `watchSignIn` tells the two apart by asking the server, never by timing.
 * Every lost link (a socket that closed on its own, or a dial that failed)
 * asks `GET /auth/status`:
 *
 *  - an answer that says this device is not signed in (or is signed in as
 *    someone else) → the sign-in is gone: `onSignedOut` fires once, and the
 *    host ends the runtime and erases that member's data through its ordinary
 *    sign-out path;
 *  - an answer that says the sign-in holds → the server is up and the socket
 *    will come back: nothing to do;
 *  - no answer (offline, DNS, a proxy page, a server still starting) → an
 *    outage: the hub keeps reconnecting and the cache stays.
 *
 * The server's close code ({@link SIGN_IN_ENDED_CLOSE}) only words the screen.
 * A close code alone never ends anything; the status answer does.
 */
import { SIGN_IN_ENDED_CLOSE } from '@podium/protocol'
import type { LiveAuthCheck } from '../accounts/auth'
import type { HubEvents, SocketCloseCause } from '../socket-transport/socket-hub'

/** Why this device's sign-in ended, as the sign-in screen words it. */
export type SignedOutReason = 'signed-out' | 'access-ended'

export const SIGNED_OUT_COPY: Readonly<Record<SignedOutReason, string>> = {
  'signed-out': 'You were signed out on this device.',
  'access-ended': 'You no longer have access to this server.',
}

/** The slice of the socket hub the watch needs; a fake in tests. */
export interface SignInWatchHub {
  on(kind: 'link', handler: (...payload: HubEvents['link']) => void): () => void
}

export interface SignInWatchOptions {
  /** Ask the server whether this device is still signed in: the auth client's `checkLiveAuth`. */
  check(): Promise<LiveAuthCheck>
  /**
   * The member this runtime was opened for. A server answer naming another
   * member (another tab signed in as someone else) means this one's sign-in
   * is gone too.
   */
  memberId?: string
  /** Fired at most once, when the server said this device's sign-in is gone. */
  onSignedOut(reason: SignedOutReason): void
  /** A status request that has not answered by then counts as no answer. Default 10 s. */
  timeoutMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

const DEFAULT_CHECK_TIMEOUT_MS = 10_000

/** The wording the server's close code asks for, if it sent one. */
export function signedOutReasonOfClose(cause: SocketCloseCause | undefined): SignedOutReason | undefined {
  if (cause?.cause !== 'close-event') return undefined
  if (cause.code === SIGN_IN_ENDED_CLOSE.accessEnded.code) return 'access-ended'
  if (cause.code === SIGN_IN_ENDED_CLOSE.signedOut.code) return 'signed-out'
  return undefined
}

/**
 * The verdict on one status answer: the reason the sign-in ended, or
 * undefined when it holds or the server did not answer.
 */
export function signedOutReasonOf(
  result: LiveAuthCheck,
  memberId: string | undefined,
  closeHint: SignedOutReason | undefined,
): SignedOutReason | undefined {
  if (result.kind === 'unreachable') return undefined
  const { status } = result
  if (result.kind === 'expired') {
    if (status.denied === 'not_workspace_member') return 'access-ended'
    return closeHint ?? 'signed-out'
  }
  // Valid, but as somebody else: the cookie jar now belongs to another member.
  const answered = status.memberId ?? status.userId ?? undefined
  if (memberId !== undefined && status.authed && answered && answered !== memberId)
    return 'signed-out'
  return undefined
}

/** Starts watching; returns the stop function. */
export function watchSignIn(hub: SignInWatchHub, options: SignInWatchOptions): () => void {
  const setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  let stopped = false
  let checking = false
  /** A loss arrived while a check was in flight: ask once more after it. */
  let again = false
  /** Bumped by every welcome: an answer to a question asked before it is stale. */
  let epoch = 0
  let closeHint: SignedOutReason | undefined

  const ask = (): Promise<LiveAuthCheck> =>
    new Promise((resolve) => {
      const timer = setTimer(
        () => resolve({ kind: 'unreachable', cause: new Error('auth status timed out') }),
        timeoutMs,
      )
      options.check().then(
        (result) => {
          clearTimer(timer)
          resolve(result)
        },
        (cause: unknown) => {
          clearTimer(timer)
          resolve({ kind: 'unreachable', cause })
        },
      )
    })

  const run = (): void => {
    checking = true
    again = false
    const asked = epoch
    void ask().then((result) => {
      checking = false
      if (stopped) return
      const reason = asked === epoch ? signedOutReasonOf(result, options.memberId, closeHint) : undefined
      if (reason !== undefined) {
        stop()
        options.onSignedOut(reason)
        return
      }
      if (again) run()
    })
  }

  const off = hub.on('link', (state, cause) => {
    if (stopped) return
    if (state === 'welcomed') {
      // The server just accepted this device's sign-in on a new socket.
      epoch++
      closeHint = undefined
      again = false
      return
    }
    closeHint = signedOutReasonOfClose(cause) ?? closeHint
    if (checking) {
      again = true
      return
    }
    run()
  })

  function stop(): void {
    stopped = true
    off()
  }
  return stop
}
