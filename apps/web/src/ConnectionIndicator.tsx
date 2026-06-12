import type { ConnectionHealth } from '@podium/terminal-client'
import { Wifi, WifiOff } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from './store'

/**
 * Hook kept outside the store state on purpose: health can change every heartbeat
 * (~2.5s) and putting it in the store context would re-render every consumer.
 * Only the components that show the indicator subscribe.
 */
export function useConnectionHealth(): ConnectionHealth {
  const { hub } = useStore()
  const [health, setHealth] = useState<ConnectionHealth>(() => hub.connectionHealth())
  useEffect(() => hub.onConnectionHealth(setHealth), [hub])
  return health
}

/** "12s" / "3m" — durations for the tooltip, coarse on purpose. */
function formatFor(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  return `${Math.round(s / 60)}m`
}

export interface ConnectionDescription {
  /** One-line headline, e.g. "Connected". */
  headline: string
  /** The explanation with the number in it, e.g. "23 ms ping to the server". */
  detail: string
}

export function describeHealth(health: ConnectionHealth, now: number): ConnectionDescription {
  const ping = health.rttMs !== null ? `${Math.max(1, Math.round(health.rttMs))} ms ping` : null
  switch (health.status) {
    case 'ok':
      return {
        headline: 'Connected',
        detail: ping ? `${ping} to the server.` : 'Waiting for the first ping measurement.',
      }
    case 'degraded':
      return {
        headline: 'Slow connection',
        detail: ping
          ? `${ping} — typing into agents will feel laggy.`
          : `No reply from the server for ${formatFor(now - health.since)} — typing into agents will feel laggy.`,
      }
    case 'down':
      return {
        headline: 'Connection lost',
        detail: `No contact for ${formatFor(now - health.since)} — reconnecting automatically. Input is not reaching agents.`,
      }
  }
}

/**
 * Connection-health icon with an explanatory hover tooltip. Rendered by
 * HostIndicators only while the link is degraded or down — yellow wifi when
 * typing would lag, pulsing red wifi-off when input is going nowhere.
 */
export function ConnectionIndicator({ health }: { health: ConnectionHealth }): JSX.Element {
  // Re-render each second while unhealthy so "no contact for Ns" ticks.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (health.status === 'ok') return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [health.status])

  const { headline, detail } = describeHealth(health, Date.now())
  const Icon = health.status === 'down' ? WifiOff : Wifi
  // A button so the tooltip is reachable by keyboard focus and by tap on touch
  // devices, where hover doesn't exist.
  return (
    <button
      type="button"
      className={`conn-indicator conn-${health.status}`}
      aria-label={`${headline}. ${detail}`}
    >
      <Icon size={14} aria-hidden="true" />
      <span className="conn-tooltip" role="tooltip">
        <strong>{headline}</strong>
        <span>{detail}</span>
      </span>
    </button>
  )
}
