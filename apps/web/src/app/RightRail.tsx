import { aggregateMotionPhase, type MotionPhase, motionPhase } from '@podium/client-core/viewmodels'
import type { IssueColorSlot } from '@podium/model'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { IdSquare, type IdSquareBadge, idSquareLabel } from '@/components/IdSquare'
import { portfolioActionableCount } from '@/lib/mission'
import { StatusBadge } from '@/lib/motion'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { RIGHT_PANELS } from './RightDock'
import { type RightPanelTab, rightPanelAllowed } from './shell-state'
import type { IssueViewModel } from './store'
import { useReplicaIssues, useStoreSelector } from './store'

/** The rail sits on the tinted --card gradient — corner badges punch out of it. */
const RAIL_SURFACE = 'var(--card)'

function railBadge(phase: MotionPhase, waitingCount: number): IdSquareBadge | null {
  if (waitingCount > 0) return { kind: 'count', count: waitingCount }
  if (phase === 'working') return { kind: 'spinner' }
  if (phase === 'done') return { kind: 'check' }
  return null
}

/**
 * The 44px right rail (handoff §2.5): the selected issue's ID square — the
 * designed bordered/filled square language, carrying the waiting/working
 * corner badge — toggling the Issue dock panel, then the Superagent/Git/Files/
 * Shell panel cells.
 *
 * The Superagent is a rail cell now that the Flight Deck owns the center
 * column it used to live in. Its cell carries the PORTFOLIO attention count —
 * how many tasks anywhere need a decision — so that number stays visible in
 * the chrome without the panel open, and matches what the copilot says when
 * you do open it ("N tasks across your portfolio need a decision").
 *
 * It used to come from `trayCount`; POD-516 removed the web Tray, so it comes
 * from `portfolioActionableCount` — the same module, and the same attention
 * predicate, the Flight Deck's "Needs you" filter runs on.
 */
export function RightRail({
  issue,
  rightPanel,
  onPanelChange,
  onColorChange,
}: {
  issue?: IssueViewModel
  rightPanel: RightPanelTab | null
  onPanelChange: (panel: RightPanelTab | null) => void
  onColorChange?: (color: IssueColorSlot | null) => unknown
}): JSX.Element {
  const sessions = useStoreSelector((store) => store.sessions)
  const allIssues = useReplicaIssues()
  // Walks every issue, so it is memoized: this rail re-renders on every issue
  // mutation. The selector lives in mission.ts so this badge and the Flight
  // Deck's "Needs you" filter can never disagree about what a decision is —
  // an inline version here resolved sessions through memberSessionIds only and
  // undercounted every agent attached by `session.issueId` alone.
  const pending = useMemo(
    () => portfolioActionableCount(allIssues, sessions),
    [allIssues, sessions],
  )
  const gitPanelEnabled = useFeature('git-panel')
  const messagesPanelEnabled = useFeature('messages-panel')
  const mergeQueueEnabled = useFeature('merge-queue')
  const panelAllowed = (panel: RightPanelTab): boolean =>
    rightPanelAllowed(panel, {
      git: gitPanelEnabled,
      messages: messagesPanelEnabled,
      mergeQueue: mergeQueueEnabled,
    })
  const memberIds = new Set(issue?.memberSessionIds ?? [])
  const memberSessions = sessions.filter((session) => memberIds.has(session.sessionId))
  const phase = issue ? aggregateMotionPhase(memberSessions) : 'queued'
  const waitingCount = issue
    ? memberSessions.filter((session) => motionPhase(session) === 'waiting').length
    : 0
  return (
    <nav
      aria-label="Panels"
      className="right-rail issue-base-card issue-fade"
      data-testid="right-rail"
    >
      {issue && onColorChange ? (
        <IdSquare
          issue={issue}
          state={phase}
          selected={rightPanel === 'issue'}
          badge={railBadge(phase, waitingCount)}
          ringColor={RAIL_SURFACE}
          titleHint={`${idSquareLabel(issue).full} · ${issue.title} — task panel`}
          onPrimary={() => onPanelChange(rightPanel === 'issue' ? null : 'issue')}
          primaryOnly
          onColorChange={onColorChange}
        />
      ) : (
        <button
          data-pressable
          type="button"
          aria-label="Task"
          aria-pressed={rightPanel === 'issue'}
          title="Task"
          onClick={() => onPanelChange(rightPanel === 'issue' ? null : 'issue')}
          className={cn(
            // No selected issue: the square language's resting (dashed) look.
            // Deliberately NOT .right-rail-cell — its unlayered border:0 would
            // beat the utility border.
            'flex size-[26px] flex-none cursor-pointer items-center justify-center rounded-[7px] border border-dashed border-text-dim bg-secondary font-mono text-[8px] font-semibold text-label opacity-65 hover:opacity-100',
            rightPanel === 'issue' && 'text-primary opacity-100',
          )}
        >
          #—
        </button>
      )}
      {RIGHT_PANELS.filter((panel) => panel.id !== 'issue' && panelAllowed(panel.id)).map(
        (panel) => (
          <button
            data-pressable
            key={panel.id}
            type="button"
            aria-label={panel.label}
            aria-pressed={rightPanel === panel.id}
            title={panel.label}
            onClick={() => onPanelChange(rightPanel === panel.id ? null : panel.id)}
            className={cn(
              // `.right-rail-cell` is unlayered and sets no `position`, so the
              // utility `relative` is safe here (unlike a border — see above).
              'right-rail-cell relative',
              rightPanel === panel.id && 'bg-secondary text-primary',
            )}
          >
            <panel.icon size={15} strokeWidth={1.8} aria-hidden="true" />
            {/* The same corner badge the ID square above renders, from the same
                component — one geometry, one colour, one morph, one phrasing
                for "N waiting on you" across the whole rail. */}
            {panel.id === 'superagent' && (
              <StatusBadge kind="count" count={pending} ringColor={RAIL_SURFACE} />
            )}
          </button>
        ),
      )}
    </nav>
  )
}
