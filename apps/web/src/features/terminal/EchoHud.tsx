import type { SocketHub } from '@podium/client-core/socket-transport'
import { debugFlagEnabled, ECHO_HUD_KEY, type UiState } from '@podium/client-core/ui-state'
import type { MountedSession } from '@podium/terminal-client'
import type { JSX, RefObject } from 'react'
import { useEffect, useState } from 'react'

/**
 * Hidden diagnostics readout for the remote-typing-latency work (#11):
 * input-event→paint percentiles (SessionConnection.echoLatency) next to the
 * pre-frame and browser-paint legs plus ping RTT. Off by default; enable via
 * `?echoHud=1` for a one-off run or the principal-scoped ui-state key
 * `ECHO_HUD_KEY` (`'1'`) until explicitly cleared.
 */
export function echoHudEnabled(ui: Pick<UiState, 'get'>): boolean {
  try {
    if (typeof location !== 'undefined') {
      const value = new URLSearchParams(location.search).get('echoHud')
      if (value === '1' || value === 'true') return true
      if (value === '0' || value === 'false') return false
    }
  } catch {
    // Fall through to the principal-scoped setting.
  }
  return debugFlagEnabled(ui, ECHO_HUD_KEY)
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
        stats?.enabled && stats.count > 0
          ? `echo ${Math.round(stats.p50 ?? 0)}/${Math.round(stats.p90 ?? 0)}ms (n=${stats.count}) · to-frame ${Math.round(stats.toFrame.p50 ?? 0)}ms · paint ${Math.round(stats.frameToPaint.p50 ?? 0)}ms · ping ${ping}`
          : stats?.enabled
            ? `echo measuring… · ping ${ping}`
            : `echo off · ping ${ping}`,
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
