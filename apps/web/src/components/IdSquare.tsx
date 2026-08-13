import { ISSUE_COLOR_HEX, type IssueColorSlot, type IssueWire } from '@podium/model/browser'
import type { CSSProperties, JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { FLOW_CSS } from '@/lib/issueColors'
import { MENU_HEADER, MENU_HEADER_REF, MENU_PICKER_PANEL } from '@/lib/menu-surface'
import { StatusBadge, type StatusBadgeKind } from '@/lib/motion'
import { IssueColorSwatches, issueColorName } from './IssueColorSwatches'

const PANEL_WIDTH = 196
const PANEL_GUTTER = 8

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/** Split the current display identifier into the square's two fixed lines.
 *  The server-derived `displayRef` ("POD-78") replaces the bare `#seq`
 *  fallback (POD-85): the square is the row's ONE identity mark, so it must
 *  carry the prefix humans actually cite. */
export function idSquareLabel(
  issue: Pick<IssueWire, 'linearIdentifier' | 'seq'> & { displayRef?: string },
): IdSquareLabel {
  const identifier = issue.linearIdentifier?.trim() || issue.displayRef?.trim()
  const match = identifier?.match(/^(.+?)[-_\s]+(\d+)$/)
  if (identifier && match?.[1] && match[2]) {
    return { prefix: match[1].toUpperCase(), number: match[2], full: identifier }
  }
  return { prefix: '#', number: String(issue.seq), full: `#${issue.seq}` }
}

/**
 * The issue identity square shared by every shell surface.
 *
 * Geometry and type are deliberately fixed: all desktop locations render this
 * exact 26px component. It also owns the #38 colour-picker interaction so a new
 * location cannot accidentally copy either the square language or the picker.
 */
export function IdSquare({
  issue,
  state,
  selected = false,
  badge = null,
  ringColor = 'var(--card)',
  titleHint,
  onPrimary,
  primaryOnly = false,
  onColorChange,
  size = 26,
}: {
  issue: Pick<IssueWire, 'linearIdentifier' | 'seq' | 'color' | 'title' | 'parentId'>
  state: IdSquareState
  selected?: boolean
  /** Square edge in px. Desktop rows run 30 for a readable prefix/number
   *  (POD-293); the rail and mobile header pass their own smaller size. */
  size?: number
  /** Corner status badge (waiting dot/count, working spinner, done check). */
  badge?: IdSquareBadge | null
  /** The surface the corner badge punches out of (sidebar vs rail background). */
  ringColor?: string
  /** Tooltip override — the rail packs the row's lost text in here. */
  titleHint?: string
  /** Rail semantics (#41): when set, clicking an UNSELECTED square calls this
   *  (select the issue) and only a click on the already-selected square opens
   *  the colour picker. Without it every click opens the picker (wide rows). */
  onPrimary?: () => void
  /** Panel-toggle semantics (#65, right rail): EVERY click calls onPrimary —
   *  this location is never a colour-picker anchor, `selected` is purely the
   *  pressed treatment. Requires onPrimary. */
  primaryOnly?: boolean
  onColorChange: (color: IssueColorSlot | null) => unknown
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const requestRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [displayColor, setDisplayColor] = useState<IssueColorSlot | undefined>(issue.color)
  const [position, setPosition] = useState({ left: PANEL_GUTTER, top: PANEL_GUTTER })
  const [panelSide, setPanelSide] = useState<'left' | 'right'>('right')
  const label = idSquareLabel(issue)
  // COLOUR IS A TOP-LEVEL PROPERTY [spec:SP-b4d1]. A sub-issue already runs
  // under its mission's colour — `effectiveIssueColorHex` tints the shell from
  // the nearest coloured ancestor — so a slot of its own could only compete with
  // the one thing the colour is for: telling missions apart in the sidebar. The
  // server refuses the write; here the affordance simply is not offered, and the
  // square goes back to being pure identity.
  const colorable = issue.parentId == null
  // Which of the two things a click on this square does. `primaryOnly` (right
  // rail) and an unselected rail square defer to the host's action; so does a
  // sub-issue's square, which has no picker to open.
  const actsPrimary = onPrimary !== undefined && (primaryOnly || !selected || !colorable)
  const opensPicker = !actsPrimary && colorable

  // Server broadcasts are the durable truth. Between click and broadcast the
  // local value keeps every appearance of the square optimistic.
  useEffect(() => {
    setDisplayColor(issue.color)
  }, [issue.color])

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return
    const anchor = trigger.getBoundingClientRect()
    const panelHeight = panel.getBoundingClientRect().height
    const fitsRight = anchor.right + PANEL_GUTTER + PANEL_WIDTH <= window.innerWidth - PANEL_GUTTER
    setPanelSide(fitsRight ? 'right' : 'left')
    setPosition({
      left: fitsRight
        ? anchor.right + PANEL_GUTTER
        : Math.max(PANEL_GUTTER, anchor.left - PANEL_WIDTH - PANEL_GUTTER),
      top: clamp(anchor.top - 8, PANEL_GUTTER, window.innerHeight - panelHeight - PANEL_GUTTER),
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const dismissOutside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    const dismissKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const dismissLayoutChange = (): void => setOpen(false)
    // Only a scroll that can MOVE the anchor square dismisses — a scrolling
    // terminal or list elsewhere must not blink the popover away (#41).
    const dismissAnchorScroll = (event: Event): void => {
      const target = event.target
      const trigger = triggerRef.current
      if (!trigger) return
      if (target === document || (target instanceof Node && target.contains(trigger))) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', dismissOutside, true)
    window.addEventListener('keydown', dismissKey, true)
    window.addEventListener('scroll', dismissAnchorScroll, true)
    window.addEventListener('resize', dismissLayoutChange)
    return () => {
      window.removeEventListener('mousedown', dismissOutside, true)
      window.removeEventListener('keydown', dismissKey, true)
      window.removeEventListener('scroll', dismissAnchorScroll, true)
      window.removeEventListener('resize', dismissLayoutChange)
    }
  }, [open])

  const choose = (next: IssueColorSlot | null): void => {
    const previous = displayColor
    const request = ++requestRef.current
    setDisplayColor(next ?? undefined)
    setSaving(true)
    setOpen(false)
    void Promise.resolve()
      .then(() => onColorChange(next))
      .then(() => {
        if (request === requestRef.current) setSaving(false)
      })
      .catch((error) => {
        if (request === requestRef.current) {
          setDisplayColor(previous)
          setSaving(false)
        }
        toast.error(error instanceof Error ? error.message : String(error))
      })
  }

  const hex = displayColor ? ISSUE_COLOR_HEX[displayColor] : undefined
  const resting = state === 'queued' || state === 'idle'
  // THE SQUARE IS A TINT, NOT A FILL (POD-725, the Paper shell).
  //
  // It used to be a saturated slab of the issue colour with near-black type. On
  // deep navy that read as one bright chip per row; on warm paper it read as ten
  // stickers, and it made the identity mark — a thing you scan past — the single
  // loudest object in the column. The Paper design keeps the square recessed
  // (`--muted`) and spends the colour as a low tint plus a 1px rim, which is the
  // same `--issue` grammar every other tinted surface in the shell already uses.
  // The ink carries the hue instead of the ground, so the ref stays readable and
  // the colour still names the issue at a glance.
  //
  // The mix percentages ride --issue-tint-scale / --issue-line-scale (index.css)
  // so paper takes half of what navy needs, exactly as the issue-mix-* utilities
  // do. They are written out rather than applied as those utilities because this
  // is one inline style object that must also carry geometry and state.
  const accent = hex ?? FLOW_CSS
  // An uncoloured square only borrows the flow accent while it is the selected
  // one — the mock's selected row tints its square and rims it in `--issue`.
  const tinted = hex !== undefined || selected
  // The number is what you cite, so it sets the square's type size. The prefix
  // recedes by INK, not by size (POD-783): a 30px desktop square used to set it
  // at two thirds of the number — 6.5px — which is below anything the shell can
  // legibly render and well under the 8.1px POD-446 already called unreadable.
  // Both marks now sit on the shell's 10.5px micro floor and the prefix is told
  // apart by prefixColor alone. Smaller rail/mobile squares stay proportional.
  const numberSize = size >= 30 ? 10.5 : Math.round((size / 30) * 105) / 10
  const prefixSize = numberSize
  // Written as longhands, not a `border` shorthand: a `var()` inside a shorthand
  // is only resolved at computed-value time, so the shorthand can't be read back.
  const squareStyle: CSSProperties = {
    width: size,
    height: size,
    // 7px is a constant from 26px up — the design draws the same corner on the
    // 26px rail square and the 30px row square, and a proportional radius made
    // the bigger one read as an 8px pill. Smaller (mobile) squares scale down.
    borderRadius: size >= 26 ? 7 : Math.round((size / 26) * 7),
    fontSize: numberSize,
    borderWidth: 1,
    borderStyle: !hex && resting ? 'dashed' : 'solid',
    borderColor: tinted
      ? `color-mix(in srgb, ${accent} calc(35 * var(--issue-line-scale, 1%)), transparent)`
      : 'var(--border-strong)',
    background: tinted
      ? `color-mix(in srgb, ${accent} calc(24 * var(--issue-tint-scale, 1%)), var(--muted))`
      : 'var(--muted)',
    color: hex
      ? `color-mix(in srgb, ${hex} 72%, var(--text-strong))`
      : selected
        ? 'var(--text-strong)'
        : 'var(--muted-foreground)',
    // Only the OPEN picker keeps an outer ring. Selection is now said by the
    // row's own band and 3px spine, so a second halo here was the same fact
    // twice — and it was the one thing that made a selected square grow.
    boxShadow: open ? '0 0 0 2px var(--text-strong)' : undefined,
    opacity: resting && !selected ? 0.65 : 1,
  }
  const prefixColor = hex
    ? `color-mix(in srgb, ${hex} 45%, var(--text-dim))`
    : 'var(--text-faint)'

  return (
    <>
      <button
        data-pressable
        ref={triggerRef}
        type="button"
        data-testid="issue-id-square"
        data-color={displayColor ?? 'none'}
        data-state={state}
        data-selected={selected ? 'true' : 'false'}
        data-badge={badge?.kind ?? 'none'}
        data-prefix={label.prefix}
        data-number={label.number}
        className={`phase-surface relative flex flex-none flex-col items-center justify-center rounded-[7px] font-mono leading-[1.15] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-text-strong ${
          actsPrimary || opensPicker ? 'cursor-pointer' : 'cursor-default'
        }`}
        style={squareStyle}
        aria-label={
          actsPrimary
            ? `Open task ${label.full}`
            : opensPicker
              ? `Set colour for task ${label.full}`
              : `Task ${label.full}`
        }
        aria-haspopup={opensPicker ? 'dialog' : undefined}
        aria-expanded={opensPicker ? open : undefined}
        aria-busy={saving}
        title={
          titleHint ??
          (colorable
            ? `${label.full} · ${issue.title} · ${displayColor ? issueColorName(displayColor) : 'No colour'}`
            : `${label.full} · ${issue.title}`)
        }
        onClick={(event) => {
          event.stopPropagation()
          if (actsPrimary) {
            onPrimary?.()
            return
          }
          if (!opensPicker) return
          setOpen((value) => !value)
        }}
      >
        {/* The prefix recedes so the number — the part you cite — reads first.
            It recedes by INK rather than a blanket opacity: on a tinted ground an
            opacity fade greys the hue out, and the design wants a MUTED tint of
            the colour over the number's strong one. */}
        <span style={{ fontSize: prefixSize, lineHeight: 1, color: prefixColor }}>
          {label.prefix}
        </span>
        <span className="tracking-[.02em]">{label.number}</span>
        {badge && <StatusBadge kind={badge.kind} count={badge.count} ringColor={ringColor} />}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={`Task colour for ${label.full}`}
            className={`fixed z-[70] ${MENU_PICKER_PANEL}`}
            style={position}
          >
            <span
              className={
                panelSide === 'right'
                  ? 'absolute top-[14px] left-[-5px] size-2 rotate-45 border-b border-l border-border-strong bg-chip'
                  : 'absolute top-[14px] right-[-5px] size-2 rotate-45 border-t border-r border-border-strong bg-chip'
              }
              aria-hidden="true"
            />
            <div className={MENU_HEADER}>
              <span>ISSUE COLOUR</span>
              <span className={MENU_HEADER_REF}>{label.full}</span>
            </div>
            <IssueColorSwatches value={displayColor} onPick={choose} />
          </div>,
          document.body,
        )}
    </>
  )
}
