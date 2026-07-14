import type { IssueColorSlot } from '@podium/domain'
import type { IssueWire } from '@podium/protocol'
import { ChevronRight, Sparkles } from 'lucide-react'
import type { JSX } from 'react'
import { IdSquare } from '@/components/IdSquare'

/**
 * The folded engraved column (handoff 3d): a 44px vertical strip that keeps
 * the column's "needs you" signals alive — the amber tray-count corner pill on
 * ▤ and the unread corner dot on ✦ — and the CTX ID square at the bottom so
 * the issue colour still bridges sidebar → bar → native pane. Clicking ▤/✦
 * expands the column landing on that half (the parent pre-opens the section).
 *
 * This is the column's terminal collapse state (#65): there is no close
 * control — the bar never disappears.
 */
export function FoldedSuperagentBar({
  issue,
  trayCount = 0,
  unread = false,
  onExpand,
  onColorChange,
}: {
  issue?: IssueWire
  trayCount?: number
  unread?: boolean
  onExpand: (target?: 'tray' | 'superagent') => void
  onColorChange?: (color: IssueColorSlot | null) => unknown
}): JSX.Element {
  return (
    <aside
      className="folded-superagent issue-fade-bar"
      data-superagent-mode="folded"
      aria-label="Folded tray and superagent"
    >
      <button
        type="button"
        className="folded-superagent-control"
        aria-label="Expand tray and superagent"
        title="Expand tray and superagent"
        onClick={() => onExpand()}
      >
        <ChevronRight size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="folded-superagent-cell"
        aria-label={trayCount > 0 ? `Expand tray (${trayCount} waiting)` : 'Expand tray'}
        title="Expand tray"
        onClick={() => onExpand('tray')}
      >
        <span className="text-[12px] text-[var(--attention)]" aria-hidden="true">
          ▤
        </span>
        {trayCount > 0 && (
          <span
            data-testid="folded-tray-count"
            className="absolute -top-[5px] -right-[5px] flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-engraved bg-attention px-[3px] font-mono text-[7.5px] font-bold text-attention-foreground"
          >
            {trayCount}
          </span>
        )}
      </button>
      <button
        type="button"
        className="folded-superagent-cell"
        aria-label={unread ? 'Expand superagent (unread activity)' : 'Expand superagent'}
        title="Expand superagent"
        onClick={() => onExpand('superagent')}
      >
        <Sparkles size={13} className="text-[var(--attention)]" aria-hidden="true" />
        {unread && (
          <span
            data-testid="folded-super-unread"
            className="absolute -top-[3px] -right-[3px] size-[9px] rounded-full border-2 border-engraved bg-attention"
            aria-hidden="true"
          />
        )}
      </button>
      <span className="folded-superagent-label">TRAY · SUPER AGENT</span>
      {issue && onColorChange ? (
        <IdSquare issue={issue} state="idle" onColorChange={onColorChange} />
      ) : (
        <span className="font-mono text-[7px] text-muted-foreground" title={issue?.title}>
          {issue ? `#${issue.seq}` : 'CTX'}
        </span>
      )}
    </aside>
  )
}
