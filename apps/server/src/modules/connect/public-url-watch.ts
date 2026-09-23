/**
 * PRODS THE PUBLISHER when the public URL changes underneath it (POD-4640).
 *
 * ConnectPublisher re-reads `publicUrl` only on its own tick, every five
 * minutes. That was fine while the URL changed only when an operator changed
 * it. A supervised quick tunnel (`podium tunnel run`, a separate process)
 * rewrites config.json the moment cloudflared restarts, and for the next five
 * minutes Connect would go on naming a URL that no longer answers — the exact
 * window in which every daemon that lost its link asks the locator where to go.
 *
 * So this polls the SAME reader the publisher uses, cheaply — a cached
 * `loadConfig()` is one `statSync` (POD-3840) — and calls the publisher's
 * existing `publicUrlChanged()` when the answer moves. It publishes nothing
 * itself: there is still exactly one publish path, and it is the publisher's.
 * A config watch rather than a signal from the tunnel process because the
 * config file is the one thing every writer (the tunnel, `podium setup`, a
 * hand edit) already goes through, and it needs no new endpoint, auth or pid
 * lookup between two processes.
 */

export const PUBLIC_URL_WATCH_MS = 2_000

export interface PublicUrlWatchDeps {
  read: () => string | undefined
  onChange: (url: string | undefined) => void
  intervalMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export function watchPublicUrl(deps: PublicUrlWatchDeps): { stop(): void } {
  const read = (): string | undefined => {
    try {
      return deps.read()
    } catch {
      // A config mid-write or briefly unreadable is not a change; ask again next time.
      return last
    }
  }
  let last: string | undefined
  last = read()
  const set = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clear = deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout))
  const handle = set(() => {
    const current = read()
    if (current === last) return
    last = current
    deps.onChange(current)
  }, deps.intervalMs ?? PUBLIC_URL_WATCH_MS)
  // Never the reason a shutting-down server stays alive.
  ;(handle as { unref?: () => void } | undefined)?.unref?.()
  return { stop: () => clear(handle) }
}
