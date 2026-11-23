import type { Trpc } from '@/app/trpc'
import { useCommands } from '@podium/client-core/react'
import type { SessionIssueOutcome } from '@podium/client-core/values'
import { Archive, ArrowDownToLine, Check, Minus } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

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
          {outcome.issueId && (
            <IssueOutcomeActions
              issueId={outcome.issueId}
              tuckable={outcome.tuckable === true}
              tucked={outcome.tucked === true}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * FILING THE ENDED ISSUE AWAY FROM WHERE ITS ENDING IS READ (POD-2251). The
 * card is the last thing the operator looks at for this work, so the two ways
 * of putting it away sit on it rather than a sidebar menu away. Both writes
 * are the outboxed ones the sidebar uses; the issue is already finished, so
 * the tuck needs no close first (compare `useMissionEndings`).
 */
function IssueOutcomeActions({
  issueId,
  tuckable,
  tucked,
}: {
  issueId: string
  /** Only a row the sidebar folds can be tucked away (POD-2293). */
  tuckable: boolean
  /** Read from the issue, optimistic tuck included: a refused tuck clears it. */
  tucked: boolean
}): JSX.Element {
  const { setIssueTucked, updateIssue } = {
    setIssueTucked: useCommands<Trpc>().issues.setTucked,
    updateIssue: useCommands<Trpc>().issues.update,
  }
  const fail = (error: unknown): void => {
    toast.error(error instanceof Error ? error.message : String(error))
  }
  // Held from the click until the write settles, so a fast second click
  // cannot send a second tuck before the optimistic Tucked paints.
  const [tucking, setTucking] = useState(false)
  const tuck = (): void => {
    setTucking(true)
    void setIssueTucked(issueId, true)
      .catch(fail)
      .finally(() => setTucking(false))
  }
  // The toggle `issues.update`, not the one-way `issues.archive`, so Undo can
  // put it back. Its sessions are already stopped: nothing else to warn about.
  const archive = (): void => {
    void updateIssue(issueId, { archived: true })
      .then(() =>
        toast('Task archived', {
          action: {
            label: 'Undo',
            onClick: () => void updateIssue(issueId, { archived: false }).catch(fail),
          },
        }),
      )
      .catch(fail)
  }
  return (
    <span className="issue-outcome-actions">
      {(tuckable || tucked) && (
        <Button variant="ghost" size="xs" onClick={tuck} disabled={tucked || tucking}>
          {tucked ? <Check aria-hidden="true" /> : <ArrowDownToLine aria-hidden="true" />}
          {tucked ? 'Tucked' : 'Tuck'}
        </Button>
      )}
      <Button variant="ghost" size="xs" onClick={archive}>
        <Archive aria-hidden="true" />
        Archive
      </Button>
    </span>
  )
}
