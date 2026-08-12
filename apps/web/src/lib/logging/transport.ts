import type { LogsCrashInput, LogsForwardInput } from '@podium/commands'
import { makeTrpc, serverConfig, type Trpc } from '@/app/trpc'
import type { LogTransport } from './install'

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
  return trpcLogTransport(makeTrpc(serverConfig(window.location).httpOrigin))
}
