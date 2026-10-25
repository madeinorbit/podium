import type { IssueViewModel } from '@podium/client-core/replica'
import type { CSSProperties, JSX } from 'react'
import { StatusBadge, type StatusBadgeKind } from '@/lib/motion'

/** The square language's states: `working`/`waiting`/`done` wear the solid
 *  grey border (live work), `queued`/`idle` the dashed dimmed resting look. */
export type IdSquareState = 'working' | 'waiting' | 'done' | 'queued' | 'idle'

/** Corner badge composed onto the square (rail + selected rows): the motion
 *  grammar's StatusBadge. `count` is required for the amber numbered pill. */
export interface IdSquareBadge {
  kind: StatusBadgeKind
  count?: number
}

export type IdSquareLabel = {
  prefix: string
  number: string
  full: string
}

/** Split the current display identifier into the square's two fixed lines.
 *  The server-derived `displayRef` ("POD-78") replaces the bare `#seq`
 *  fallback (POD-85): the square is the row's ONE identity mark, so it must
 *  carry the prefix humans actually cite. */
export function idSquareLabel(
  issue: Pick<IssueViewModel, 'linearIdentifier' | 'seq'> & { displayRef?: string },
): IdSquareLabel {
  const identifier = issue.linearIdentifier?.trim() || issue.displayRef?.trim()
  const match = identifier?.match(/^(.+?)[-_\s]+(\d+)$/)
  if (identifier && match?.[1] && match[2]) {
    return { prefix: match[1].toUpperCase(), number: match[2], full: identifier }
  }
  return { prefix: '#', number: String(issue.seq), full: `#${issue.seq}` }
}

/** Shared task identity mark, with an optional navigation action. */
export function IdSquare({
  issue,
  state,
  selected = false,
  badge = null,
  ringColor = 'var(--card)',
  titleHint,
  onPrimary,
  size = 26,
  width,
  radius,
  numberOnly = false,
}: {
  issue: Pick<IssueViewModel, 'linearIdentifier' | 'seq' | 'title'>
  state: IdSquareState
  selected?: boolean
  /** Square edge in px. Desktop rows run 30 for a readable prefix/number
   *  (POD-293); the rail and mobile header pass their own smaller size. */
  size?: number
  /** THE MARK IS NOT ALWAYS A SQUARE (POD-1178, the collapsed rail's 3b
   *  design). A 58px column has width to spend and no height to spare, so the
   *  rail draws the identity mark as a 36×32 TILE. `size` stays the height —
   *  every ratio below (type, radius floor, badge ring) is derived from it —
   *  and this widens the box. Defaults to `size`, i.e. a square. */
  width?: number
  /** Corner radius override. The square's own ramp holds 7px from 26px up
   *  (see below); the rail's wider tile takes the design's 9px, which reads as
   *  the same corner once the box is no longer square. */
  radius?: number
  /** Drop the prefix line and set the number alone (POD-1178). A 32px-tall
   *  tile has one line of room, and the rail is a column of ONE project's
   *  worth of work where the prefix is the same on every mark — so it is the
   *  half that can go. `aria-label` and the tooltip still carry the full ref. */
  numberOnly?: boolean
  /** Corner status badge (waiting dot/count, working spinner, done check). */
  badge?: IdSquareBadge | null
  /** The surface the corner badge punches out of (sidebar vs rail background). */
  ringColor?: string
  /** Tooltip override. `null` suppresses the native tooltip entirely, for a
   *  host that draws its own hover card over the same mark (POD-1178): two
   *  tooltips for one gesture is one too many, and the OS one always wins the
   *  race by arriving a second late and covering the card. */
  titleHint?: string | null
  /** When supplied, the identity mark opens its task or panel. */
  onPrimary?: () => void
}): JSX.Element {
  const label = idSquareLabel(issue)
  const Mark = onPrimary ? 'button' : 'span'
  const resting = state === 'queued' || state === 'idle'
  // The number is what you cite, so it sets the square's type size. The prefix
  // recedes by INK, not by size (POD-783): a 30px desktop square used to set it
  // at two thirds of the number — 6.5px — which is below anything the shell can
  // legibly render and well under the 8.1px POD-446 already called unreadable.
  // Both marks now sit on the shell's 10.5px micro floor and the prefix is told
  // apart by prefixColor alone. Smaller rail/mobile squares stay proportional.
  // A number-only mark spends the prefix's line on the number instead: 11.5px
  // is the row-title size from the mocks, and it is what makes three digits
  // read as this tile's whole identity rather than as a shrunken square.
  const numberSize = numberOnly ? 11.5 : size >= 30 ? 10.5 : Math.round((size / 30) * 105) / 10
  const prefixSize = numberSize
  // Written as longhands, not a `border` shorthand: a `var()` inside a shorthand
  // is only resolved at computed-value time, so the shorthand can't be read back.
  const squareStyle: CSSProperties = {
    width: width ?? size,
    height: size,
    // 7px is a constant from 26px up — the design draws the same corner on the
    // 26px rail square and the 30px row square, and a proportional radius made
    // the bigger one read as an 8px pill. Smaller (mobile) squares scale down.
    borderRadius: radius ?? (size >= 26 ? 7 : Math.round((size / 26) * 7)),
    fontSize: numberSize,
    borderWidth: 1,
    borderStyle: resting ? 'dashed' : 'solid',
    borderColor: 'var(--border-strong)',
    background: selected ? 'var(--accent)' : 'var(--muted)',
    color: selected ? 'var(--text-strong)' : 'var(--muted-foreground)',
    opacity: resting && !selected ? 0.65 : 1,
  }
  const prefixColor = 'var(--text-faint)'

  return (
    <Mark
      data-pressable={onPrimary ? true : undefined}
      type={onPrimary ? 'button' : undefined}
      data-testid="issue-id-square"
      data-state={state}
      data-selected={selected ? 'true' : 'false'}
      data-badge={badge?.kind ?? 'none'}
      data-prefix={label.prefix}
      data-number={label.number}
      className={`phase-surface relative flex flex-none flex-col items-center justify-center rounded-[7px] font-mono leading-[1.15] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-text-strong ${
        onPrimary ? 'cursor-pointer' : ''
      }`}
      style={squareStyle}
      aria-label={onPrimary ? `Open task ${label.full}` : `Task ${label.full}`}
      title={titleHint === null ? undefined : (titleHint ?? `${label.full} · ${issue.title}`)}
      onClick={
        onPrimary
          ? (event) => {
              event.stopPropagation()
              onPrimary()
            }
          : undefined
      }
    >
      {!numberOnly && (
        <span style={{ fontSize: prefixSize, lineHeight: 1, color: prefixColor }}>
          {label.prefix}
        </span>
      )}
      <span className="tracking-[.02em]">{label.number}</span>
      {badge && <StatusBadge kind={badge.kind} count={badge.count} ringColor={ringColor} />}
    </Mark>
  )
}
