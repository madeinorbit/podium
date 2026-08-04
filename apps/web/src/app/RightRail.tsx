import { aggregateMotionPhase, type MotionPhase, motionPhase } from '@podium/client-core/viewmodels'
import type { IssueColorSlot } from '@podium/model'
import type { JSX } from 'react'
import { IdSquare, type IdSquareBadge, idSquareLabel } from '@/components/IdSquare'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { RIGHT_PANELS } from './RightDock'
import type { RightPanelTab } from './shell-state'
import type { IssueViewModel } from './store'
import { useStoreSelector } from './store'

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
 * corner badge — toggling the Issue dock panel, then the Git/Files/Shell
 * panel cells. The Superagent column is NOT reachable from here (#65): it
 * folds in place and never fully closes.
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
  const gitPanelEnabled = useFeature('git-panel')
  const messagesPanelEnabled = useFeature('messages-panel')
  const panelAllowed = (panel: RightPanelTab): boolean =>
    panel !== 'git' && panel !== 'mail'
      ? true
      : panel === 'git'
        ? gitPanelEnabled
        : messagesPanelEnabled
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
              'right-rail-cell',
              rightPanel === panel.id && 'bg-secondary text-primary',
            )}
          >
            <panel.icon size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ),
      )}
    </nav>
  )
}
