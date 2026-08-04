import { ISSUE_COLOR_HEX, ISSUE_COLOR_SLOTS, type IssueColorSlot } from '@podium/model'
import type { JSX } from 'react'

export function issueColorName(slot: IssueColorSlot): string {
  return slot.charAt(0).toUpperCase() + slot.slice(1)
}

/**
 * The 10-slot swatch grid plus its "No colour" clear row.
 *
 * Lifted out of IdSquare (POD-380) so the context menu's Colour submenu IS the
 * picker rather than a text list imitating it: one grid, one cell geometry, one
 * set of current/pressed affordances everywhere a colour gets chosen. Render it
 * inside `MENU_PICKER_PANEL` so the cells keep their size.
 */
export function IssueColorSwatches({
  value,
  onPick,
  caption = 'flows everywhere',
}: {
  /** The colour currently on the issue; `undefined` = the neutral slate flow. */
  value: IssueColorSlot | undefined
  onPick: (color: IssueColorSlot | null) => void
  /** Footer machine voice; the menu names the scope instead of the effect. */
  caption?: string
}): JSX.Element {
  return (
    <>
      <div className="grid grid-cols-5 gap-2">
        {ISSUE_COLOR_SLOTS.map((slot) => {
          const swatch = ISSUE_COLOR_HEX[slot]
          const current = value === slot
          return (
            <button
              data-pressable
              key={slot}
              type="button"
              data-testid={`issue-color-swatch-${slot}`}
              title={`${issueColorName(slot)}${current ? ' — current' : ''}`}
              aria-label={issueColorName(slot)}
              aria-pressed={current}
              className={`aspect-square cursor-pointer rounded-md text-[10px] font-bold outline-none ring-text-strong hover:ring-2 focus-visible:ring-2 ${
                current ? 'ring-2' : ''
              }`}
              style={{
                background: swatch,
                color: `color-mix(in srgb, ${swatch} 30%, #000)`,
              }}
              onClick={() => onPick(slot)}
            >
              {current ? '✓' : null}
            </button>
          )
        })}
      </div>
      <div className="mt-2.5 flex items-center border-t border-hairline-soft pt-2">
        <button
          data-pressable
          type="button"
          data-testid="issue-color-swatch-none"
          className="flex cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground outline-none ring-text-strong hover:text-foreground focus-visible:ring-2"
          aria-label="No colour"
          aria-pressed={value === undefined}
          onClick={() => onPick(null)}
        >
          <span className="flex size-4 items-center justify-center rounded-[5px] border border-dashed border-text-dim bg-hairline-soft text-[9px] text-label">
            ✕
          </span>
          <span className="text-[10.5px]">No colour</span>
        </button>
        <span className="ml-auto font-mono text-[8px] tracking-[.12em] text-text-faint">
          {caption}
        </span>
      </div>
    </>
  )
}
