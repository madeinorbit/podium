import { ChevronRight, Sparkles } from 'lucide-react'
import type { JSX } from 'react'

/**
 * The folded engraved column (handoff 3d): a 44px vertical strip that keeps
 * the column's one "needs you" signal alive — the amber tray-count corner pill
 * on ▤. Clicking ▤/✦ expands the column landing on that half (the parent
 * pre-opens the section). The bar sits on the flat engraved surface: no issue
 * tint, no issue context readout.
 *
 * This is the column's terminal collapse state (#65): there is no close
 * control — the bar never disappears.
 */
export function FoldedSuperagentBar({
  trayCount = 0,
  onExpand,
}: {
  trayCount?: number
  onExpand: (target?: 'tray' | 'superagent') => void
}): JSX.Element {
  return (
    <aside
      className="folded-superagent"
      data-superagent-mode="folded"
      aria-label="Folded tray and superagent"
    >
      <button
        data-pressable
        type="button"
        className="folded-superagent-control"
        aria-label="Expand tray and superagent"
        title="Expand tray and superagent"
        onClick={() => onExpand()}
      >
        <ChevronRight size={12} aria-hidden="true" />
      </button>
      <button
        data-pressable
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
        data-pressable
        type="button"
        className="folded-superagent-cell"
        aria-label="Expand superagent"
        title="Expand superagent"
        onClick={() => onExpand('superagent')}
      >
        <Sparkles size={13} className="text-[var(--attention)]" aria-hidden="true" />
      </button>
      <span className="folded-superagent-label">TRAY · SUPER AGENT</span>
    </aside>
  )
}
