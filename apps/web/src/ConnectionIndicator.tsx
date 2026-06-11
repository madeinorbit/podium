import type { ConnectionHealth } from '@podium/terminal-client'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from './store'

/**
 * Hook kept outside the store state on purpose: health can change every heartbeat
 * (~2.5s) and putting it in the store context would re-render every consumer.
 * Only the components that show the dot subscribe.
 */
export function useConnectionHealth(): ConnectionHealth {
  const { hub } = useStore()
  const [health, setHealth] = useState<ConnectionHealth>(() => hub.connectionHealth())
  useEffect(() => hub.onConnectionHealth(setHealth), [hub])
  return health
}

/**
 * Small round connection-health dot. Hidden entirely while the link to the server
 * is fast — the user only needs to hear about it when typing into an agent would
 * lag (yellow) or go nowhere (red). Matters most on mobile, where the network
 * degrades silently and a dead socket otherwise looks like a quiet agent.
 */
export function ConnectionIndicator({ health }: { health: ConnectionHealth }): JSX.Element | null {
  if (health.status === 'ok') return null
  const detail =
    health.status === 'down'
      ? 'Connection lost — reconnecting…'
      : health.rttMs !== null
        ? `Slow connection — ${Math.round(health.rttMs)}ms ping`
        : 'Slow connection — waiting for the server'
  return (
    <span
      className={`conn-dot conn-${health.status}`}
      role="status"
      title={detail}
      aria-label={detail}
    />
  )
}
