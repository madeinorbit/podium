import type { SessionIssueOutcome } from '@podium/client-core/values'
import { Check, Minus } from 'lucide-react'
import type { JSX } from 'react'

/**
 * WHERE A SESSION ENDED BY ITS ISSUE CLOSING ENDS (POD-2151). The landing
 * stops the agent mid-turn, so the transcript otherwise ends on whatever tool
 * call it was running and reads as a crash. This card is the transcript's last
 * row, derived from the issue and the session, never from agent text.
 */
export function IssueOutcomeCard({ outcome }: { outcome: SessionIssueOutcome }): JSX.Element {
  const landed = outcome.kind === 'landed'
  const Mark = landed ? Check : Minus
  const title = landed
    ? `Landed${outcome.branch ? ` on ${outcome.branch}` : ''}`
    : `Closed as ${outcome.reason}`
  return (
    <div className="transcript-row" data-testid="issue-outcome-card">
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body">
        <div className="issue-outcome-card" data-outcome={outcome.kind} role="status">
          <span className="issue-outcome-mark" aria-hidden="true">
            <Mark size={14} strokeWidth={2} />
          </span>
          <span className="issue-outcome-title">{title}</span>
          {outcome.at && (
            <time className="issue-outcome-time" dateTime={outcome.at}>
              {new Date(outcome.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          )}
          {landed && (
            <span className="issue-outcome-sub">
              {outcome.sha && <code>{outcome.sha}</code>}
              {outcome.sha && ' · '}issue closed as done
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
