/**
 * The overlay-menu surface vocabulary (POD-380).
 *
 * Derived from the IdSquare colour picker, which the operator already reads as
 * the house look: the raised `--chip` surface over a `--border-strong` seam,
 * the popover lift, mono micro-caps for machine voice, `--hairline-soft` rules
 * between regions. The two context menus used stock shadcn popover tokens
 * (`bg-popover` + `shadow-md` + a `ring-foreground/10` hairline, 13px rows), so
 * right-clicking a row and clicking its square opened two different-looking
 * panels one pixel apart.
 *
 * Everything here is a token class, never a literal — the picker's original
 * hexes were podium-dark values hardcoded, which is why it never followed the
 * theme. All three overlays now derive from the preset together.
 */

/** Shared shell: surface, seam, radius and the one lifted shadow tier. */
const PANEL =
  'rounded-tray border border-border-strong bg-chip text-popover-foreground shadow-popover'

/** A menu panel — padding tuned for rows. */
export const MENU_PANEL = `${PANEL} p-[6px]`

/** The colour-picker panel: same shell, but the picker's own 196px/11px
 *  geometry so the swatch grid keeps identical cell sizes wherever it opens. */
export const MENU_PICKER_PANEL = `${PANEL} w-[196px] px-[11px] py-[10px]`

/** The picker's header line — a mono micro-caps label with the issue ref
 *  pushed to the right edge. `MENU_HEADER_REF` goes on that trailing span.
 *  Carries no horizontal padding: the picker sits flush with its swatch grid,
 *  the menu insets it to the row text column. */
export const MENU_HEADER =
  'mb-[9px] flex items-center gap-1.5 font-mono text-[8px] tracking-[.12em] text-label'
export const MENU_HEADER_REF = 'ml-auto tracking-normal text-text-faint'

/** A section rule that names itself. The menu's regions were anonymous <hr>s;
 *  the picker labels its regions, so they do too. */
export const MENU_SECTION =
  'mt-[6px] mb-[3px] border-t border-hairline-soft px-[5px] pt-[7px] font-mono text-[8px] tracking-[.12em] text-label'

/** An unlabelled divider, for groups whose heading would be noise. */
export const MENU_RULE = 'my-[5px] h-px border-0 bg-hairline-soft'

/** A menu row. Hover lifts ink to `--text-strong` over the same
 *  `--hairline-soft` wash the picker uses for its own divider tone. */
export const MENU_ITEM =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-[5px] py-[4.5px] text-left text-[11.5px] outline-none hover:bg-hairline-soft hover:text-text-strong focus-visible:bg-hairline-soft focus-visible:text-text-strong'

export const MENU_ITEM_DISABLED =
  'flex w-full items-center gap-2 rounded-md px-[5px] py-[4.5px] text-left text-[11.5px] text-text-dim'

/** Destructive stays a tint plus red ink — never a solid red slab (DESIGN.md). */
export const MENU_ITEM_DESTRUCTIVE = `${MENU_ITEM} text-destructive hover:bg-destructive/10 hover:text-destructive`

/** Trailing machine voice on a row (a handoff rejection, a duplicate's ref). */
export const MENU_HINT = 'ml-auto pl-2 font-mono text-[9px] text-text-faint'

/** A row's second line — the disabled-with-a-reason shape. */
export const MENU_SUBTEXT = 'pl-[22px] text-[10.5px] text-text-dim'

/** Non-interactive filler inside a submenu ("No sibling issues"). */
export const MENU_EMPTY = 'block px-[5px] py-[4.5px] text-[11.5px] text-text-dim'
