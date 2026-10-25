import type { IssueViewModel } from '@podium/client-core/replica'
import type { CSSProperties, JSX } from 'react'
import { StatusBadge, type StatusBadgeKind } from '@/lib/motion'

/** The square language's states: `working`/`waiting`/`done` wear the solid
 *  grey border (live work), `queued`/`idle` the dashed dimmed resting look. */
export type IdSquareState = 'working' | 'waiting' | 'done' | 'queued' | 'idle'

/** Corner status badge. `count` is required for the amber numbered pill. */
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
}: {
  issue: Pick<IssueViewModel, 'linearIdentifier' | 'seq' | 'title'>
  state: IdSquareState
  selected?: boolean
  /** Square edge in pixels. Type and corners scale with this size. */
  size?: number
  /** Corner status badge (waiting dot/count, working spinner, done check). */
  badge?: IdSquareBadge | null
  /** The background behind the square, used to outline its corner badge. */
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
  // Both marks share the same font size; prefixColor distinguishes the prefix.
  const numberSize = size >= 30 ? 10.5 : Math.round((size / 30) * 105) / 10
  const prefixSize = numberSize
  // Written as longhands, not a `border` shorthand: a `var()` inside a shorthand
  // is only resolved at computed-value time, so the shorthand can't be read back.
  const squareStyle: CSSProperties = {
    width: size,
    height: size,
    // Corners stay at 7px for sizes of 26px and above; smaller squares scale down.
    borderRadius: size >= 26 ? 7 : Math.round((size / 26) * 7),
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
      <span style={{ fontSize: prefixSize, lineHeight: 1, color: prefixColor }}>
        {label.prefix}
      </span>
      <span className="tracking-[.02em]">{label.number}</span>
      {badge && <StatusBadge kind={badge.kind} count={badge.count} ringColor={ringColor} />}
    </Mark>
  )
}
