import type { AgentKind } from '@podium/model/browser'
import type { CSSProperties, JSX } from 'react'
import { cn } from '@/lib/utils'

/**
 * THE HARNESS MARKS THE OMARCHY DESIGN SUPPLIES [POD-1531].
 *
 * Six files in `./omarchy`, three outlines, and each file is one outline at one
 * fill. That is the design's own grammar: a mark is not tinted by whatever ink
 * surrounds it, it is one of a small closed set of STATES — Claude in its clay,
 * a harness sitting quietly in a list, a harness named in a header, a harness on
 * a row that is asking something of you.
 *
 * WHY A BACKGROUND IMAGE AND NOT AN `<svg>`. The state is a fact about the ROW,
 * and the row already says it — `data-phase`, `data-selected`, the surface it is
 * drawn on. Threading a tone prop from each of those down through `KindIcon`,
 * `IssueFleetSummary`, the deck's agent rows and the tab strip would be four
 * copies of one rule, each free to drift. A background-image is swapped by the
 * same selector that already knows the state (see `omarchy.css`), so the rule
 * lives once, next to the rest of the profile's chrome — and because it is a
 * background rather than a mask, every swap paints the supplied file's OWN fill.
 * Nothing here chooses a colour.
 *
 * Only the three harnesses the design draws have marks. Cursor, OpenCode and
 * the shell fall through to the inline set in `AgentIcons.tsx` and take their
 * tone from the profile's tokens: inventing a Tokyo Night recolour for a mark
 * the design never supplied would be exactly the substitution this file avoids.
 */
const OMARCHY_MARK_KINDS = new Set<string>(['claude-code', 'codex', 'grok'])

export function hasOmarchyMark(kind: string): boolean {
  return OMARCHY_MARK_KINDS.has(kind)
}

/**
 * One supplied mark.
 *
 * `data-om-mark` is the whole API: `omarchy.css` keys the file off it, and the
 * context selectors above it key the tone off the row. The element is a span
 * with a background rather than an `<img>` so that swap is a stylesheet's job.
 *
 * The size arrives as `--om-mark-size` rather than as `width`/`height`, so the
 * design's per-surface sizes (12px in a work row, 18 and 20 in the deck) can be
 * set where the rest of that surface's metrics are set. An inline width would
 * outrank the stylesheet and force every one of those back into a prop.
 */
export function OmarchyMark({
  kind,
  size = 12,
  label,
  className,
}: {
  kind: AgentKind | (string & {})
  /** Fallback edge in px. The profile's own stylesheet overrides it per surface. */
  size?: number
  /** The harness's display name — the mark is the only thing naming it. */
  label?: string
  className?: string
}): JSX.Element {
  return (
    <span
      data-om-mark={kind}
      role="img"
      aria-label={label}
      title={label}
      className={cn('om-mark', className)}
      style={{ '--om-mark-size': `${size}px` } as CSSProperties}
    />
  )
}
