import type { ConnectionCondition } from '@podium/client-core/live'
import { Wifi, WifiOff } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { usePoolHeaderConnection } from '@/app/header-data'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClock } from '@/lib/clock-hooks'
import { cn } from '@/lib/utils'

const WAITING_CONNECTION: ConnectionCondition = { state: 'connecting', since: 0 }

/** The connection condition, from the LiveStore (POD-5798). */
export function useConnectionHealth(): ConnectionCondition {
  return usePoolHeaderConnection() ?? WAITING_CONNECTION
}

/**
 * How bad it looks, for colour and icon: the first dial and a live link both
 * read as fine (the fatal-error page owns a server that never answered).
 */
export type ConnectionSeverity = 'ok' | 'degraded' | 'down'
export function connectionSeverity(connection: ConnectionCondition): ConnectionSeverity {
  if (connection.state === 'offline') return 'down'
  return connection.state === 'degraded' ? 'degraded' : 'ok'
}

// Best practice for a flaky signal: hysteresis. A bad state must persist briefly
// before we show it (so a one-heartbeat blip doesn't flash a warning), and after
// recovery we hold a green "Connected" for a few seconds before hiding — so the
// indicator confirms the fix instead of just vanishing, and never strobes.
const ENTER_DELAY_MS = 1200
const RECOVER_HOLD_MS = 5000

export function useStableConnection(): { health: ConnectionCondition; visible: boolean } {
  const raw = useConnectionHealth()
  const severity = connectionSeverity(raw)
  const [visible, setVisible] = useState(severity !== 'ok')
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevStatus = useRef(severity)

  useEffect(() => {
    const status = severity
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
  }, [severity, visible])

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

export function describeHealth(health: ConnectionCondition, now: number): ConnectionDescription {
  const ping =
    health.pingMs !== undefined ? `${Math.max(1, Math.round(health.pingMs))} ms ping` : null
  switch (connectionSeverity(health)) {
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
  health: ConnectionCondition
  onOpen?: () => void
}): JSX.Element {
  const severity = connectionSeverity(health)
  const now = useClock(1_000, severity !== 'ok')
  const { headline, detail } = describeHealth(health, now)
  const Icon = severity === 'down' ? WifiOff : Wifi
  // A button so the tooltip is reachable by keyboard focus and by tap on touch
  // devices, where hover doesn't exist. Tapping opens the host info panel.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            data-pressable
            type="button"
            className={cn(
              'relative inline-flex flex-none cursor-pointer items-center self-center border-0 bg-transparent p-0',
              severity === 'ok' && 'text-success',
              severity === 'degraded' && 'text-warning',
              severity === 'down' && 'text-destructive',
            )}
            aria-label={`${headline}. ${detail}`}
            onClick={onOpen}
          >
            {/* Pulse the ICON only — not the whole control. */}
            <Icon
              size={14}
              aria-hidden="true"
              className={cn(severity === 'down' && 'animate-pulse')}
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
