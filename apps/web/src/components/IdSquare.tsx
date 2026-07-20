import { ISSUE_COLOR_HEX, ISSUE_COLOR_SLOTS, type IssueColorSlot } from '@podium/domain'
import type { IssueWire } from '@podium/protocol'
import type { CSSProperties, JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { StatusBadge, type StatusBadgeKind } from '@/lib/motion'

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

function colorName(slot: IssueColorSlot): string {
  return slot.charAt(0).toUpperCase() + slot.slice(1)
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
  ringColor = '#16161c',
  titleHint,
  onPrimary,
  primaryOnly = false,
  onColorChange,
}: {
  issue: IssueWire
  state: IdSquareState
  selected?: boolean
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
  const border = hex
    ? '1px solid transparent'
    : selected
      ? '1px solid #c8d2e0'
      : resting
        ? '1px dashed #6c6c78'
        : '1px solid #8d8d9a'
  const squareStyle: CSSProperties = {
    width: 26,
    height: 26,
    borderRadius: 7,
    border,
    background: hex ?? '#25252f',
    color: hex
      ? `color-mix(in srgb, ${hex} 30%, #000)`
      : selected
        ? '#e8edf5'
        : resting
          ? '#8d8d9a'
          : '#c5c5d0',
    boxShadow: open
      ? '0 0 0 2px #f3f3f8'
      : selected
        ? `0 0 0 2px ${hex ? `color-mix(in srgb, ${hex} 35%, transparent)` : 'rgba(148,163,184,.3)'}`
        : undefined,
    opacity: resting && !selected ? 0.65 : 1,
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="issue-id-square"
        data-color={displayColor ?? 'none'}
        data-state={state}
        data-selected={selected ? 'true' : 'false'}
        data-badge={badge?.kind ?? 'none'}
        data-prefix={label.prefix}
        data-number={label.number}
        className="phase-surface relative flex flex-none cursor-pointer flex-col items-center justify-center rounded-[7px] font-mono text-[6.5px] leading-[1.3] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[#f3f3f8]"
        style={squareStyle}
        aria-label={
          onPrimary && (primaryOnly || !selected)
            ? `Open task ${label.full}`
            : `Set colour for task ${label.full}`
        }
        aria-haspopup={primaryOnly ? undefined : 'dialog'}
        aria-expanded={primaryOnly ? undefined : open}
        aria-busy={saving}
        title={
          titleHint ??
          `${label.full} · ${issue.title} · ${displayColor ? colorName(displayColor) : 'No colour'}`
        }
        onClick={(event) => {
          event.stopPropagation()
          if (onPrimary && (primaryOnly || !selected)) {
            onPrimary()
            return
          }
          setOpen((value) => !value)
        }}
      >
        <span>{label.prefix}</span>
        <span>{label.number}</span>
        {badge && <StatusBadge kind={badge.kind} count={badge.count} ringColor={ringColor} />}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={`Task colour for ${label.full}`}
            className="fixed z-[70] w-[196px] rounded-[10px] border border-[#3a3a46] bg-[#1b1b22] px-[11px] py-[10px] text-[#d7d7e0] shadow-[0_14px_34px_rgba(0,0,0,.65),0_2px_8px_rgba(0,0,0,.5)]"
            style={position}
          >
            <span
              className={
                panelSide === 'right'
                  ? 'absolute top-[14px] left-[-5px] size-2 rotate-45 border-b border-l border-[#3a3a46] bg-[#1b1b22]'
                  : 'absolute top-[14px] right-[-5px] size-2 rotate-45 border-t border-r border-[#3a3a46] bg-[#1b1b22]'
              }
              aria-hidden="true"
            />
            <div className="mb-[9px] flex items-center gap-1.5 font-mono text-[8px]">
              <span className="tracking-[.12em] text-[#8d8d9a]">ISSUE COLOUR</span>
              <span className="ml-auto text-[#5a5a66]">{label.full}</span>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {ISSUE_COLOR_SLOTS.map((slot) => {
                const swatch = ISSUE_COLOR_HEX[slot]
                const current = displayColor === slot
                return (
                  <button
                    key={slot}
                    type="button"
                    title={`${colorName(slot)}${current ? ' — current' : ''}`}
                    aria-label={colorName(slot)}
                    aria-pressed={current}
                    className="aspect-square cursor-pointer rounded-md text-[10px] font-bold outline-none hover:ring-2 hover:ring-[#f3f3f8] focus-visible:ring-2 focus-visible:ring-[#f3f3f8]"
                    style={{
                      background: swatch,
                      color: `color-mix(in srgb, ${swatch} 30%, #000)`,
                      boxShadow: current ? '0 0 0 2px #f3f3f8' : undefined,
                    }}
                    onClick={() => choose(slot)}
                  >
                    {current ? '✓' : null}
                  </button>
                )
              })}
            </div>
            <div className="mt-2.5 flex items-center border-t border-[#25252f] pt-2">
              <button
                type="button"
                className="flex cursor-pointer items-center gap-1.5 rounded-sm outline-none hover:text-[#d7d7e0] focus-visible:ring-2 focus-visible:ring-[#f3f3f8]"
                aria-label="No colour"
                aria-pressed={displayColor === undefined}
                onClick={() => choose(null)}
              >
                <span className="flex size-4 items-center justify-center rounded-[5px] border border-dashed border-[#6c6c78] bg-[#25252f] text-[9px] text-[#8d8d9a]">
                  ✕
                </span>
                <span className="text-[10.5px] text-[#9a9aa8]">No colour</span>
              </button>
              <span className="ml-auto font-mono text-[8px] text-[#5a5a66]">flows everywhere</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
