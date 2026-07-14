import type { IssueWire } from '@podium/protocol'
import { ChevronLeft, Sparkles } from 'lucide-react'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { RIGHT_PANELS } from './RightDock'
import type { RightPanelTab, SuperagentMode } from './shell-state'

export function RightRail({
  issue,
  rightPanel,
  lastPanel,
  superMode,
  onPanelChange,
  onSuperModeChange,
}: {
  issue?: IssueWire
  rightPanel: RightPanelTab | null
  lastPanel: RightPanelTab
  superMode: SuperagentMode
  onPanelChange: (panel: RightPanelTab | null) => void
  onSuperModeChange: (mode: SuperagentMode) => void
}): JSX.Element {
  return (
    <nav
      aria-label="Panels"
      className="right-rail issue-base-card issue-fade"
      data-testid="right-rail"
    >
      <button
        type="button"
        aria-label="Open last panel"
        title={`Open ${lastPanel} panel`}
        onClick={() => onPanelChange(lastPanel)}
        className="right-rail-cell h-4 text-[var(--text-dim)]"
      >
        <ChevronLeft size={12} aria-hidden="true" />
      </button>
      {superMode === 'closed' && (
        <button
          type="button"
          aria-label="Open superagent"
          title="Open superagent"
          onClick={() => onSuperModeChange('open')}
          className="right-rail-cell"
        >
          <Sparkles size={15} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        aria-label="Issue"
        aria-pressed={rightPanel === 'issue'}
        title={issue ? `Issue #${issue.seq} · ${issue.title}` : 'Issue'}
        onClick={() => onPanelChange(rightPanel === 'issue' ? null : 'issue')}
        className={cn(
          'right-rail-cell font-mono text-[8px] font-semibold',
          rightPanel === 'issue' && 'bg-secondary text-primary',
        )}
      >
        {issue ? `#${issue.seq}` : '#—'}
      </button>
      {RIGHT_PANELS.filter((panel) => panel.id !== 'issue').map((panel) => (
        <button
          key={panel.id}
          type="button"
          aria-label={panel.label}
          aria-pressed={rightPanel === panel.id}
          title={panel.label}
          onClick={() => onPanelChange(rightPanel === panel.id ? null : panel.id)}
          className={cn('right-rail-cell', rightPanel === panel.id && 'bg-secondary text-primary')}
        >
          <panel.icon size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      ))}
    </nav>
  )
}
