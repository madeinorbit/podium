/** A temporary, device-local log detail control for Updates → Troubleshooting. */
import { applyServerLogLevel, logLevelStatus } from '@podium/client-core/logging'
import type { LogLevel } from '@podium/logger'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { usePanelVisible } from '@/app/panel-visible'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCountdown } from '@/lib/clock-hooks'
import { Row } from './shared'

/** How long a raise made from here lasts. The same half hour the server-pushed
 *  command defaults to — a user picking a level and an operator issuing one
 *  should not produce clients that behave differently. The server clamps its own
 *  copy of this bound (24 h max), and expiry itself lives in the controller;
 *  this pane surfaces it rather than keeping a deadline of its own. */
export const AFFORDANCE_TTL_MS = 30 * 60 * 1000

/** Re-read often enough that the row stops claiming "raised" within a few
 *  seconds of the TTL lifting. A subscription would be a listener list in a
 *  module every client imports; a poll on a settings pane nobody is staring at
 *  costs nothing and cannot leak. */
const POLL_MS = 5000

const LEVEL_NAMES: Record<LogLevel, string> = {
  error: 'Normal',
  warn: 'Normal',
  info: 'More',
  debug: 'Debug',
  trace: 'Everything',
}
const LEVEL_OPTIONS = [
  { level: 'warn', label: 'Normal', hint: 'Warnings and errors' },
  { level: 'info', label: 'More', hint: 'Plus what Podium is doing' },
  { level: 'debug', label: 'Debug', hint: 'Detailed diagnostics' },
  { level: 'trace', label: 'Everything', hint: 'Very noisy' },
] as const

function remainingLabel(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60_000)
  return minutes <= 1 ? 'less than a minute left' : `${minutes} minutes left`
}

export function DiagnosticLoggingSubsection(): JSX.Element | null {
  const [status, setStatus] = useState(() => logLevelStatus())
  const visible = usePanelVisible()

  useEffect(() => {
    if (!visible) return
    setStatus(logLevelStatus())
    const timer = setInterval(() => {
      setStatus(logLevelStatus())
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [visible])

  // Logging is installed at boot on every real client. Rendering nothing when it
  // is not is the honest answer — a control that would raise nothing is worse
  // than an absent one.
  if (!status) return null

  const raised = status.expiresAt !== null
  const apply = (level: LogLevel | null): void => {
    // Choosing the boot default is a RESET, not a raise held at the default
    // level: `level: null` is the one path that clears the deadline, and a raise
    // pinned to the boot level would leave the row claiming a temporary state
    // that changes nothing.
    applyServerLogLevel(
      level === null || level === status.boot
        ? { level: null }
        : { level, ttlMs: AFFORDANCE_TTL_MS },
    )
    setStatus(logLevelStatus())
  }

  return (
    <>
      <Row
        label="Log detail for this window"
        device
        description="Raise it before you reproduce a problem. Goes back to normal after 30 minutes."
      >
        <Select
          value={status.level === 'error' ? 'warn' : status.level}
          onValueChange={(value) => apply((value ?? status.boot) as LogLevel)}
        >
          <SelectTrigger className="w-full flex-1" data-testid="log-level-select">
            <SelectValue>{LEVEL_NAMES[status.level]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LEVEL_OPTIONS.map(({ level, label, hint }) => (
              <SelectItem key={level} value={level}>
                {label} — {hint}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      {raised && (
        <TemporaryLogLevel
          expiresAt={status.expiresAt}
          boot={status.boot}
          onReset={() => apply(null)}
        />
      )}
    </>
  )
}

function TemporaryLogLevel({
  expiresAt,
  boot,
  onReset,
}: {
  expiresAt: number | null
  boot: LogLevel
  onReset: () => void
}): JSX.Element {
  const remaining = useCountdown(expiresAt ?? undefined, POLL_MS)
  return (
    <Row
      label="Temporary change"
      description={`Back to ${LEVEL_NAMES[boot]} by itself — ${remainingLabel(remaining)}. Nothing is saved, so reloading this page returns to ${LEVEL_NAMES[boot]} too.`}
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="log-level-reset"
        onClick={onReset}
      >
        Back to normal
      </Button>
    </Row>
  )
}
