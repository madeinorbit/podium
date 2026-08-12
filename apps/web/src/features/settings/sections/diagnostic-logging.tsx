/**
 * Settings → Privacy → DIAGNOSTIC DETAIL (POD-1920, chunk 7 of
 * [spec:2026-08-11-logging-strategy-design]).
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
 * NOT a second setting: nothing is persisted, and the button below is the same
 * one the TTL presses by itself when it runs out.
 *
 * ON THE PRIVACY TAB, and the placement is a claim worth being careful about.
 * That tab promises Podium sends nothing off the install unless you say so, and
 * that promise is about the VENDOR hop. Forwarding to your own server is a
 * different hop and is unconditional (the design spec's "Client → server
 * forwarding": the client's server IS the user's server). So the copy here says
 * where the detail goes, in the row, rather than leaving the reader to assume
 * this control is governed by the switches above it.
 */

import { applyServerLogLevel, logLevelStatus } from '@podium/client-core/logging'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Row, Subsection } from './shared'

/** How long the affordance raises for. The same half hour the server-pushed
 *  command defaults to — a user pressing this and an operator issuing it should
 *  not produce clients that behave differently. */
export const AFFORDANCE_TTL_MS = 30 * 60 * 1000

/** Re-read often enough that the row stops claiming "raised" within a few
 *  seconds of the TTL lifting. A subscription would be a listener list in a
 *  module every client imports; a poll on a settings pane nobody is staring at
 *  costs nothing and cannot leak. */
const POLL_MS = 5000

function remainingLabel(expiresAt: number | null, now: number): string | null {
  if (expiresAt === null) return null
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
  // is not is the honest answer — a button that would raise nothing is worse
  // than an absent one.
  if (!status) return null

  const raised = status.expiresAt !== null
  const apply = (level: 'debug' | null): void => {
    applyServerLogLevel(level === null ? { level: null } : { level, ttlMs: AFFORDANCE_TTL_MS })
    setStatus(logLevelStatus())
    setNow(Date.now())
  }

  return (
    <Subsection
      title="Diagnostic detail"
      hint="How much this client records about what it is doing. Detail goes to your own server, alongside the logs it keeps for itself — it never leaves your installation."
    >
      <Row
        label="Detailed logging"
        description={
          raised
            ? `On, at ${status.level} — ${remainingLabel(status.expiresAt, now)}. It turns itself back down, so you can leave it.`
            : `Normally ${status.boot} and above. Turn it up before reproducing a problem, and it goes back to ${status.boot} by itself after half an hour.`
        }
      >
        {raised ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="log-level-reset"
            onClick={() => apply(null)}
          >
            Back to normal
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="log-level-raise"
            onClick={() => apply('debug')}
          >
            Turn up for 30 minutes
          </Button>
        )}
      </Row>
    </Subsection>
  )
}
