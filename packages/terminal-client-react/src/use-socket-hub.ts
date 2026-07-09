// Import from the barrel (which re-exports ./connection) rather than the /connection
// subpath: the web vite build aliases '@podium/terminal-client' to src/index.ts, so a
// subpath specifier resolves to `src/index.ts/connection` and fails the production build.
import { SocketHub, type SocketHubOptions } from '@podium/terminal-client'
import { useEffect, useMemo, useState } from 'react'

export interface UseSocketHubResult {
  hub: SocketHub
  connected: boolean
}

/**
 * Own a {@link SocketHub}'s connect/dispose lifecycle: constructs one hub for
 * `opts.url` (rebuilt if the URL changes), connects it on mount, disposes it on
 * unmount, and polls `hub.connected` (the hub exposes no change event) so a
 * caller can gate mounting a terminal on it. One React binding for the "a panel
 * owns its own hub" shape (embedded/standalone terminals); a panel sharing an
 * app-wide hub from the store should just use that hub directly with
 * {@link useTerminalSession} instead of this hook.
 */
export function useSocketHub(opts: SocketHubOptions): UseSocketHubResult {
  // Only opts.url is treated as reactive — viewport/makeSocket are read once at
  // construction (mirroring the SocketHub instance itself: they're not meant to
  // change independently of the URL for a given caller).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the URL should rebuild the hub
  const hub = useMemo(() => new SocketHub(opts), [opts.url])
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    hub.connect()
    const tick = () => setConnected(hub.connected)
    tick()
    const timer = setInterval(tick, 100)
    return () => {
      clearInterval(timer)
      hub.dispose()
    }
  }, [hub])

  return { hub, connected }
}
