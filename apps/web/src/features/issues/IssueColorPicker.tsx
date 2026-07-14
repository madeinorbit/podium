import { ISSUE_COLOR_HEX, ISSUE_COLOR_SLOTS, type IssueColorSlot } from '@podium/domain'
import type { IssueWire } from '@podium/protocol'
import type { CSSProperties, JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'

const PANEL_WIDTH = 196
const PANEL_GUTTER = 8

function colorName(slot: IssueColorSlot): string {
  return slot.charAt(0).toUpperCase() + slot.slice(1)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/**
 * The issue ID square's colour assignment control [spec:SP-b4d1].
 *
 * #39 will generalise the square language across every shell surface. This
 * component owns #38's durable interaction boundary: the current issue ID,
 * canonical ten-slot picker, optimistic feedback, clear-to-neutral action, and
 * accessible dismissal behaviour.
 */
export function IssueColorPickerButton({
  issue,
  active,
  queued = false,
  onChange,
}: {
  issue: IssueWire
  active: boolean
  queued?: boolean
  onChange: (color: IssueColorSlot | null) => unknown
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const requestRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [displayColor, setDisplayColor] = useState<IssueColorSlot | undefined>(issue.color)
  const [position, setPosition] = useState({ left: 8, top: 8 })

  // Server broadcasts are the durable truth. Between click and broadcast the
  // local value keeps the square optimistic, as required by the picker design.
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
    const right = anchor.right + PANEL_GUTTER
    const left =
      right + PANEL_WIDTH <= window.innerWidth - PANEL_GUTTER
        ? right
        : Math.max(PANEL_GUTTER, anchor.left - PANEL_WIDTH - PANEL_GUTTER)
    setPosition({
      left,
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
    window.addEventListener('mousedown', dismissOutside, true)
    window.addEventListener('keydown', dismissKey, true)
    window.addEventListener('scroll', dismissLayoutChange, true)
    window.addEventListener('resize', dismissLayoutChange)
    return () => {
      window.removeEventListener('mousedown', dismissOutside, true)
      window.removeEventListener('keydown', dismissKey, true)
      window.removeEventListener('scroll', dismissLayoutChange, true)
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
      .then(() => onChange(next))
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
  const border = hex
    ? '1px solid transparent'
    : active
      ? '1px solid #c8d2e0'
      : queued
        ? '1px dashed #6c6c78'
        : '1px solid #8d8d9a'
  const squareStyle: CSSProperties = {
    width: 26,
    height: 26,
    borderRadius: 7,
    border,
    background: hex ?? '#25252f',
    color: hex ? `color-mix(in srgb, ${hex} 30%, #000)` : active ? '#e8edf5' : '#c5c5d0',
    boxShadow: open
      ? '0 0 0 2px #f3f3f8'
      : active
        ? `0 0 0 2px ${hex ? `color-mix(in srgb, ${hex} 35%, transparent)` : 'rgba(148,163,184,.3)'}`
        : undefined,
    opacity: queued && !active ? 0.65 : 1,
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="issue-id-square"
        data-color={displayColor ?? 'none'}
        className="flex flex-none cursor-pointer flex-col items-center justify-center font-mono text-[6.5px] leading-[1.3] font-semibold transition-[background,border-color,opacity,box-shadow] duration-400"
        style={squareStyle}
        aria-label={`Set colour for issue #${issue.seq}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={saving}
        title={`#${issue.seq} · ${issue.title} · ${displayColor ? colorName(displayColor) : 'No colour'}`}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <span>#</span>
        <span>{issue.seq}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={`Issue colour for #${issue.seq}`}
            className="fixed z-[70] w-[196px] rounded-[10px] border border-[#3a3a46] bg-[#1b1b22] px-[11px] py-[10px] text-[#d7d7e0] shadow-[0_14px_34px_rgba(0,0,0,.65),0_2px_8px_rgba(0,0,0,.5)]"
            style={position}
          >
            <span
              className="absolute top-[14px] left-[-5px] size-2 rotate-45 border-b border-l border-[#3a3a46] bg-[#1b1b22]"
              aria-hidden="true"
            />
            <div className="mb-[9px] flex items-center gap-1.5 font-mono text-[8px]">
              <span className="tracking-[.12em] text-[#8d8d9a]">ISSUE COLOUR</span>
              <span className="ml-auto text-[#5a5a66]">#{issue.seq}</span>
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
