/**
 * Settings → Privacy → DIAGNOSTIC DETAIL (POD-1920 chunk 7, extended by
 * POD-1946; [spec:2026-08-11-logging-strategy-design]).
 *
 * The support flow this exists for: "turn this on, do the thing that fails, tell
 * me when you have." An operator with a shell raises the client from the server
 * (`logs.setLevel`); this is the same act performed by the person sitting at the
 * client, for the cases where nobody has a shell — a hosted install, a phone, a
 * user on a call.
 *
 * IT DRIVES THE SAME KNOB. Both paths end at the one `setLogLevel` in
 * `@podium/client-core/logging`, so the console and the forwarded stream move
 * together and this control cannot disagree with what the operator sees. It is
 * NOT a second setting: nothing is persisted, and picking the default here is
 * the same `level: null` the TTL applies by itself when it runs out. There is
 * deliberately no separate threshold for forwarding — the forwarding sink pins
 * no `minLevel`, which is what makes "raise a client to debug and debug forwards
 * too" true; a second control would break that silently.
 *
 * IT SHOWS WHAT IS IN FORCE. The row is read before it is used: which level this
 * client is running at right now, whether that is its boot default or a
 * temporary raise (from here or from an operator), and when a raise lifts. A
 * control that can be moved from the other end has to say where it is, or the
 * reader cannot tell "nothing to report" from "never turned up".
 *
 * ON THE PRIVACY TAB, and the placement is a claim worth being careful about.
 * That tab promises Podium sends nothing off the install unless you say so, and
 * that promise is about the VENDOR hop. Forwarding to your own server is a
 * different hop and is unconditional (the design spec's "Client → server
 * forwarding": the client's server IS the user's server). So the copy here says
 * where the detail goes, in the section hint, rather than leaving the reader to
 * assume this control is governed by the switches above it.
 */

import { applyServerLogLevel, logLevelStatus } from '@podium/client-core/logging'
import { LEVELS, type LogLevel } from '@podium/logger'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Row, Subsection } from './shared'

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

/** What each level means to somebody who does not write log lines for a living.
 *  The level's own name stays in the label — it is what an operator will ask for
 *  on a call ("put it on debug"), so the picker has to speak both languages. */
const LEVEL_HINT: Record<LogLevel, string> = {
  error: 'failures only',
  warn: 'failures and warnings',
  info: 'ordinary activity',
  // Kept short on purpose: the open list is as wide as the trigger, and it
  // CLIPS rather than wraps — a hint that does not fit is a hint cut mid-word.
  debug: 'detailed diagnostics',
  trace: 'every message in and out',
}

function remainingLabel(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return ''
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000))
  return minutes <= 1 ? 'less than a minute left' : `${minutes} minutes left`
}

export function DiagnosticLoggingSubsection(): JSX.Element | null {
  const [status, setStatus] = useState(() => logLevelStatus())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => {
      setStatus(logLevelStatus())
      setNow(Date.now())
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [])

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
    setNow(Date.now())
  }

  /** The trigger says only what is in force — the settings control column is one
   *  fixed width, and a hint appended here is a hint the reader sees cut off.
   *  The meaning belongs where there is room for it: the row's description, and
   *  the options in the open list. */
  const triggerLabel = (level: LogLevel): string =>
    `${level}${level === status.boot ? ' (default)' : ''}`
  const optionLabel = (level: LogLevel): string => `${triggerLabel(level)} — ${LEVEL_HINT[level]}`

  return (
    <Subsection
      title="Diagnostic detail"
      hint="How much this client records about what it is doing. Detail goes to your own server, alongside the logs it keeps for itself — it never leaves your installation."
    >
      <Row
        label="Detail level"
        description={
          raised
            ? // NOT "turned up": a level can be picked BELOW the boot default too,
              // and a row that calls that a raise is describing a different act
              // than the one the reader just performed.
              `Running at ${status.level} (${LEVEL_HINT[status.level]}) — a temporary change from its usual ${status.boot}.`
            : `Running at ${status.level} (${LEVEL_HINT[status.level]}), this client's default. Turn it up before reproducing a problem; it comes back down by itself.`
        }
      >
        <Select
          value={status.level}
          onValueChange={(value) => apply((value ?? status.boot) as LogLevel)}
        >
          <SelectTrigger className="w-full flex-1" data-testid="log-level-select">
            <SelectValue>{triggerLabel(status.level)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {optionLabel(level)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      {raised && (
        <Row
          label="Temporary change"
          description={`Back to ${status.boot} by itself — ${remainingLabel(status.expiresAt, now)}. Nothing is saved, so reloading this page returns to ${status.boot} too.`}
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="log-level-reset"
            onClick={() => apply(null)}
          >
            Back to normal
          </Button>
        </Row>
      )}
    </Subsection>
  )
}
