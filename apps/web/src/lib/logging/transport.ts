import type { LogsCrashInput, LogsForwardInput } from '@podium/commands'
import { makeTrpc, serverConfig, type Trpc } from '@/app/trpc'
import type { LogTransport, UnloadLogTransport } from './install'

/**
 * `logs.forward` / `logs.crash` over the app's own tRPC client.
 *
 * Its OWN client, not the one `store.tsx` builds, and deliberately: logging is
 * installed before React mounts, so that it can catch a crash during boot —
 * which is the crash a user cannot work around by reloading. A logging path
 * that waited for the app's client would be dark for exactly that window.
 *
 * `/trpc` is gated by the login session cookie, so an unauthenticated page
 * forwards nothing. That is correct rather than a gap: before login there is no
 * session to attribute records to, and the crash reporter's own bounded retry
 * gives up rather than looping on the refusal.
 */
export function trpcLogTransport(trpc: Trpc): LogTransport {
  return {
    forward: async (input: LogsForwardInput) => {
      await trpc.logs.forward.mutate(input)
    },
    crash: async (input: LogsCrashInput) => {
      await trpc.logs.crash.mutate(input)
    },
  }
}

/** The transport for the page's own server, resolved from `window.location`. */
export function pageLogTransport(): LogTransport {
  // `report: false`: every OTHER client logs its failed calls at `warn`
  // (POD-1935), and this one must not — a failed `logs.forward` that produced a
  // warn record would hand that record to the sink whose send just failed, and
  // mint another on every retry.
  return trpcLogTransport(makeTrpc(serverConfig(window.location).httpOrigin, { report: false }))
}

/**
 * THE TRANSPORT FOR A PAGE THAT IS ABOUT TO STOP EXISTING (POD-3224 follow-up).
 *
 * An ordinary `fetch` is cancelled when its document is torn down, so the
 * five-second flush the sink schedules is worth nothing at `pagehide` — which is
 * exactly when the records worth having were written. On the two traced Reload
 * clicks the click, the handshake outcome and the navigation were all emitted
 * within ~200 ms of the navigation that cut them, and none of the three arrived.
 *
 * `keepalive` IS THE ANSWER, AND `sendBeacon` IS NOT — a deliberate departure
 * from what the follow-up asked for. Both survive the document, but `sendBeacon`
 * takes a URL and a body, so using it would mean hand-rolling the tRPC batch
 * envelope here: a second encoder for `logs.forward`, drifting silently the
 * first time the router changes shape, on the one path nobody can see fail. A
 * `keepalive` fetch goes through the SAME client, the same link, the same
 * encoder as every other call, and the browser gives it the same
 * outlives-the-page guarantee. The cost is the 64 KB body cap, which the sink
 * already budgets for.
 *
 * `restartRecoveryLink` sits above the batch link and would ordinarily park and
 * replay a failed call. During unload there is nothing to replay INTO, so a
 * refusal here is simply the end — which is why the sink counts what it hands
 * over rather than waiting to be told it arrived.
 */
export function unloadLogTransport(): UnloadLogTransport {
  // BUILT ON FIRST USE, not at install. Logging is installed before React and
  // before anything has agreed what the origin is; resolving it eagerly would
  // read `window.location` in every runtime that merely INSTALLS logging,
  // including the tests that supply their own transport.
  let trpc: Trpc | undefined
  return {
    forward: (input: LogsForwardInput): boolean => {
      try {
        trpc ??= makeTrpc(serverConfig(window.location).httpOrigin, {
          report: false,
          fetch: (url, init) => fetch(url, { ...init, keepalive: true }),
        })
        // Fire and forget BY CONTRACT: the caller is inside `pagehide` and there
        // is no turn after this one. The rejection is swallowed here rather than
        // left floating, because an unhandled rejection during unload is the one
        // kind nothing can report.
        void trpc.logs.forward.mutate(input).catch(() => {})
        return true
      } catch {
        return false
      }
    },
  }
}
