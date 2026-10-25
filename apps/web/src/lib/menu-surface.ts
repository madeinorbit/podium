/** Shared overlay surfaces, spacing, headings and row styles. */

/** Shared shell: surface, seam, radius and the one lifted shadow tier. */
const PANEL =
  'rounded-tray border border-border-strong bg-chip text-popover-foreground shadow-popover'

/** A menu panel — padding tuned for rows. */
export const MENU_PANEL = `${PANEL} p-[6px]`


/** A READ-ONLY overlay on the same shell: the collapsed rail's hover card
 *  (POD-1178). It is not a menu — nothing in it is clickable — but it opens
 *  from the same gesture, one pixel off the same column, so it has to be the
 *  same object. Its own padding, because the card holds two stacked lines of
 *  text rather than a grid or a list of rows. */
export const MENU_HOVER_CARD = `${PANEL} px-[11px] py-[8px]`

/** Menu heading with an optional trailing task reference. */
export const MENU_HEADER =
  'mb-[9px] flex items-center gap-1.5 font-mono shell-type-micro tracking-[.12em] text-label'
export const MENU_HEADER_REF = 'ml-auto tracking-normal text-text-faint'

/** The type a section heading is set in: machine voice, per DESIGN.md's Machine
 *  Voice Rule. Split out from `MENU_SECTION` because a heading that already has
 *  a divider above it (a `DropdownMenuSeparator`, say) wants the words without a
 *  second rule. */
export const MENU_SECTION_LABEL = 'px-[5px] font-mono shell-type-micro tracking-[.12em] text-label'

/** A section rule that names itself. The menu's regions were anonymous <hr>s;
 *  named headings distinguish their regions. */
export const MENU_SECTION = `mt-[6px] mb-[3px] border-t border-hairline-soft pt-[7px] ${MENU_SECTION_LABEL}`

/** An unlabelled divider, for groups whose heading would be noise. */
export const MENU_RULE = 'my-[5px] h-px border-0 bg-hairline-soft'

/** A menu row. Hover lifts ink to `--text-strong` over the same
 *  `--hairline-soft` wash used by the dividers. */
export const MENU_ITEM =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-[5px] py-[4.5px] text-left text-[11.5px] outline-none hover:bg-hairline-soft hover:text-text-strong focus-visible:bg-hairline-soft focus-visible:text-text-strong'

export const MENU_ITEM_DISABLED =
  'flex w-full items-center gap-2 rounded-md px-[5px] py-[4.5px] text-left text-[11.5px] text-text-dim'

/** Destructive stays a tint plus red ink — never a solid red slab (DESIGN.md). */
export const MENU_ITEM_DESTRUCTIVE = `${MENU_ITEM} text-destructive hover:bg-destructive/10 hover:text-destructive`

/** Trailing machine voice on a row (a handoff rejection, a duplicate's ref). */
export const MENU_HINT = 'ml-auto pl-2 font-mono shell-type-micro text-text-faint'

/** A row's second line — the disabled-with-a-reason shape. */
export const MENU_SUBTEXT = 'pl-[22px] text-[10.5px] text-text-dim'

/** Non-interactive filler inside a submenu ("No sibling issues"). */
export const MENU_EMPTY = 'block px-[5px] py-[4.5px] text-[11.5px] text-text-dim'

/* ---------------------------------------------------------------------------
 * Base UI menus (POD-1084 bridged, POD-1099 rebased)
 * ---------------------------------------------------------------------------
 *
 * The overlays above are hand-rolled portals, so they wear the preset directly.
 * `components/ui/dropdown-menu` is a Base UI menu, and it used to ship the stock
 * shadcn popover tokens — `bg-popover`, `shadow-md`, a `ring-foreground/10`
 * hairline, `rounded-lg`, 14px rows — which is exactly the look this file was
 * written to retire. POD-1084 bridged one such menu with a pair of opt-in
 * constants; POD-1099 rebased the primitive itself onto `MENU_PANEL` /
 * `MENU_ITEM`, so those two are gone and every dropdown in the app is in the
 * house vocabulary by default. Nothing has to opt in, and nothing new can
 * accidentally opt out.
 */
