import type { ConnectionHealth } from '@podium/terminal-client'
import { Wifi, WifiOff } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useStoreSelector } from './store'

/**
 * Hook kept outside the store state on purpose: health can change every heartbeat
 * (~2.5s) and putting it in the store context would re-render every consumer.
 * Only the components that show the indicator subscribe.
 */
export function useConnectionHealth(): ConnectionHealth {
  const hub = useStoreSelector((s) => s.hub)
  const [health, setHealth] = useState<ConnectionHealth>(() => hub.connectionHealth())
  useEffect(() => hub.onConnectionHealth(setHealth), [hub])
  return health
}

// Best practice for a flaky signal: hysteresis. A bad state must persist briefly
// before we show it (so a one-heartbeat blip doesn't flash a warning), and after
// recovery we hold a green "Connected" for a few seconds before hiding — so the
// indicator confirms the fix instead of just vanishing, and never strobes.
const ENTER_DELAY_MS = 1200
const RECOVER_HOLD_MS = 5000

export function useStableConnection(): { health: ConnectionHealth; visible: boolean } {
  const raw = useConnectionHealth()
  const [visible, setVisible] = useState(raw.status !== 'ok')
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevStatus = useRef(raw.status)

  useEffect(() => {
    const status = raw.status
    const prev = prevStatus.current
    prevStatus.current = status
    const clearEnter = () => {
      if (enterTimer.current) {
        clearTimeout(enterTimer.current)
        enterTimer.current = null
      }
    }
    const clearRecover = () => {
      if (recoverTimer.current) {
        clearTimeout(recoverTimer.current)
        recoverTimer.current = null
      }
    }
    if (status !== 'ok') {
      clearRecover()
      if (!visible && !enterTimer.current) {
        enterTimer.current = setTimeout(() => {
          enterTimer.current = null
          setVisible(true)
        }, ENTER_DELAY_MS)
      }
    } else {
      clearEnter()
      if (visible && prev !== 'ok' && !recoverTimer.current) {
        recoverTimer.current = setTimeout(() => {
          recoverTimer.current = null
          setVisible(false)
        }, RECOVER_HOLD_MS)
      }
    }
  }, [raw.status, visible])

  useEffect(
    () => () => {
      if (enterTimer.current) clearTimeout(enterTimer.current)
      if (recoverTimer.current) clearTimeout(recoverTimer.current)
    },
    [],
  )

  return { health: raw, visible }
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
export function ConnectionIndicator({
  health,
  onOpen,
}: {
  health: ConnectionHealth
  onOpen?: () => void
}): JSX.Element {
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
  // devices, where hover doesn't exist. Tapping opens the host info panel.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              'relative inline-flex flex-none cursor-pointer items-center self-center border-0 bg-transparent p-0',
              health.status === 'ok' && 'text-success',
              health.status === 'degraded' && 'text-warning',
              health.status === 'down' && 'text-destructive',
            )}
            aria-label={`${headline}. ${detail}`}
            onClick={onOpen}
          >
            {/* Pulse the ICON only — not the whole control. */}
            <Icon
              size={14}
              aria-hidden="true"
              className={cn(health.status === 'down' && 'animate-pulse')}
            />
          </button>
        }
      />
      <TooltipContent className="max-w-60 flex-col items-start gap-0.5">
        <strong>{headline}</strong>
        <span className="text-background/70">{detail}</span>
      </TooltipContent>
    </Tooltip>
  )
}
