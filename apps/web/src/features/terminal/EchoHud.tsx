import type { MountedSession, SocketHub } from '@podium/terminal-client'
import type { JSX, RefObject } from 'react'
import { useEffect, useState } from 'react'

/**
 * Hidden diagnostics readout for the remote-typing-latency work (#11):
 * keystroke→echo percentiles (SessionConnection.echoLatency) next to the hub's
 * ping RTT, so the network share vs the server/agent share of typing lag is
 * readable at a glance from any client — no devtools needed. Off by default;
 * enable with `localStorage.setItem('podium.echoHud', '1')` and reload.
 */
export function echoHudEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem('podium.echoHud') === '1'
  } catch {
    return false
  }
}

export function EchoHud({
  hub,
  mountedRef,
}: {
  hub: SocketHub
  mountedRef: RefObject<MountedSession | null>
}): JSX.Element {
  const [line, setLine] = useState('echo —')
  useEffect(() => {
    const tick = (): void => {
      const rtt = hub.connectionHealth().rttMs
      const ping = rtt !== null ? `${Math.max(1, Math.round(rtt))}ms` : '—'
      const stats = mountedRef.current?.connection.echoLatency()
      setLine(
        stats && stats.count > 0
          ? `echo ${Math.round(stats.p50 ?? 0)}/${Math.round(stats.p90 ?? 0)}ms (n=${stats.count}) · ping ${ping}`
          : `echo — · ping ${ping}`,
      )
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [hub, mountedRef])
  return (
    <div
      className="pointer-events-none absolute top-2 right-2 z-[4] rounded bg-black/60 px-2 py-0.5 font-mono text-[10px] leading-4 text-zinc-300"
      aria-hidden="true"
    >
      {line}
    </div>
  )
}
