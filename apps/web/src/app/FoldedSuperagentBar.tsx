import type { IssueWire } from '@podium/protocol'
import { ChevronLeft, ChevronRight, Sparkles, X } from 'lucide-react'
import type { JSX } from 'react'

export function FoldedSuperagentBar({
  issue,
  onExpand,
  onClose,
}: {
  issue?: IssueWire
  onExpand: (target?: 'tray' | 'superagent') => void
  onClose: () => void
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
        aria-label="Expand tray"
        title="Expand tray"
        onClick={() => onExpand('tray')}
      >
        <span className="text-[12px] text-[var(--attention)]" aria-hidden="true">
          ▤
        </span>
      </button>
      <button
        type="button"
        className="folded-superagent-cell"
        aria-label="Expand superagent"
        title="Expand superagent"
        onClick={() => onExpand('superagent')}
      >
        <Sparkles size={13} className="text-[var(--attention)]" aria-hidden="true" />
      </button>
      <span className="folded-superagent-label">TRAY · SUPER AGENT</span>
      <span className="font-mono text-[7px] text-muted-foreground" title={issue?.title}>
        {issue ? `#${issue.seq}` : 'CTX'}
      </span>
      <button
        type="button"
        className="folded-superagent-control"
        aria-label="Close tray and superagent"
        title="Close tray and superagent"
        onClick={onClose}
      >
        <ChevronLeft size={11} aria-hidden="true" />
        <X size={9} aria-hidden="true" />
      </button>
    </aside>
  )
}
