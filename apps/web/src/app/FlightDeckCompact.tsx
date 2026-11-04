import { relativeTime } from '@podium/client-core/focus'
import { agentLabel } from '@podium/client-core/values'
import type { CompactDeck, CompactDeckSession } from '@podium/client-graph/mission-compact-deck'
import { observer } from '@podium/client-graph/react'
import { SESSION_WORD_LABEL } from '@podium/model/browser'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAgeNow } from '@/lib/clock-hooks'
import { WorkingMark } from '@/lib/motion'
import { useHarnessDescriptors } from '@/lib/use-harness-descriptors'

export const CompactProgress = observer(function CompactProgress({ deck }: { deck: CompactDeck }) {
  const share = deck.totalCount ? deck.doneCount / deck.totalCount : 0
  return (
    <svg
      className="flight-compact-progress"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      role="img"
      aria-label={`${deck.doneCount} of ${deck.totalCount} sessions done`}
      data-complete={share === 1}
    >
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <circle
        cx="6"
        cy="6"
        r="3.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        pathLength="1"
        strokeDasharray={`${share} 1`}
        transform="rotate(-90 6 6)"
      />
    </svg>
  )
})

/** Only these small labels subscribe to the shared, visibility-aware clock. */
export function CompactElapsed({
  since,
  until = 0,
  className,
}: {
  since: number
  until?: number
  className?: string
}) {
  const now = useAgeNow(since, 0, since > 0 && !until)
  if (!since) return null
  const minutes = Math.max(0, Math.floor(((until || now) - since) / 60_000))
  const label =
    minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes}m`
        : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  return (
    <span className={className} title={`Elapsed since ${new Date(since).toLocaleString()}`}>
      {label}
    </span>
  )
}

export const CompactIssueElapsed = observer(function CompactIssueElapsed({
  deck,
}: {
  deck: CompactDeck
}) {
  return (
    <CompactElapsed
      since={deck.startedAt}
      until={deck.finishedAt}
      className="flight-compact-issue-time"
    />
  )
})

export const CompactSessionIdentity = observer(function CompactSessionIdentity({
  row,
  icon,
}: {
  row: CompactDeckSession
  icon: ReactNode
}) {
  const { served } = useHarnessDescriptors(row.session.machineId)
  const done = row.session.word === 'done'
  return (
    <>
      <span className="flight-compact-agent" data-kind={row.session.agentKind}>
        {done ? (
          <span className="flight-compact-done-check">
            <Check size={10} strokeWidth={3} aria-hidden />
          </span>
        ) : (
          icon
        )}
      </span>
      <span className="flight-compact-identity">
        <span className="flight-compact-title" data-pending={row.pendingTitle}>
          {row.title}
        </span>
        {!done && (
          <span className="flight-compact-meta">
            <span>{agentLabel(row.session.agentKind, served)}</span>
            {row.coordinator && <span className="flight-compact-role"> · coordinator</span>}
            <span className="flight-compact-time">
              {' '}
              · <CompactElapsed since={row.startedAt} />
            </span>
          </span>
        )}
      </span>
    </>
  )
})

function CompletionAge({ since }: { since: number }) {
  const now = useAgeNow(since, 0, since > 0)
  return <>{since > 0 ? ` ${relativeTime(new Date(since).toISOString(), now)}` : ''}</>
}

export const CompactSessionState = observer(function CompactSessionState({
  row,
}: {
  row: CompactDeckSession
}) {
  const word = row.session.word
  return (
    <span className="flight-compact-state" data-word={word}>
      {word !== 'done' && (
        <span className="flight-compact-state-icon" aria-hidden>
          {word === 'working' ? (
            <WorkingMark size={12} />
          ) : word === 'idle' ? (
            <span className="flight-compact-idle-icon" />
          ) : (
            <span className="flight-compact-attention-icon">{word === 'error' ? '×' : '!'}</span>
          )}
        </span>
      )}
      <span className="flight-compact-state-word">{SESSION_WORD_LABEL[word]}</span>
      {word === 'done' && <CompletionAge since={row.completedAt} />}
    </span>
  )
})
