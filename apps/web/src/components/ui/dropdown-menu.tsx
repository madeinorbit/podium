/**
 * THE APP'S DROPDOWN, IN THE HOUSE VOCABULARY (POD-1099).
 *
 * Base UI's menu, skinned from `lib/menu-surface` (POD-380) rather than from the
 * stock shadcn popover tokens it shipped with. It used to open on `--popover`
 * behind a `ring-foreground/10` hairline, `shadow-md`, `rounded-lg` and 14px
 * rows — a second overlay look that appeared a pixel from the session menu, the
 * issue menu and the colour picker, all of which already wore the preset.
 *
 * POD-1084 bridged one menu with a pair of opt-in constants
 * (`MENU_DROPDOWN_PANEL` / `MENU_DROPDOWN_ITEM`). POD-1099 moved the preset in
 * here instead, which is where it belongs: opting in per call site meant the
 * next dropdown anyone added still opened in the retired look, and the opt-in
 * pair could only reach panels and rows — a checkbox item, a radio item, a group
 * label and a separator had no bridge at all and stayed stock.
 *
 * Three details are load-bearing and were each found the hard way:
 *
 *  - The seam is a BORDER, not the stock RING. A border cannot override a ring,
 *    so the ring is not overridden here — it is gone.
 *  - `focus:` is stated everywhere `hover:` is. Base UI moves real DOM focus to
 *    the highlighted row, so arrow-key navigation lights `focus:` while the
 *    pointer lights `hover:`; painting only one leaves keyboard and mouse
 *    showing the same row in two different colours.
 *  - An un-classed glyph is sized by CSS, not by its `size={n}` prop:
 *    `[&_svg:not([class*='size-'])]:size-3.5` beats the prop's width/height
 *    attributes. 14px is the house text column, so the default lands right; a
 *    glyph that must be smaller (a status dot, a lock) says so with a `size-`
 *    class, which is the one thing the rule yields to.
 */
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { CheckIcon, ChevronRightIcon } from 'lucide-react'
import type * as React from 'react'
import { MENU_HINT, MENU_ITEM, MENU_PANEL, MENU_RULE, MENU_SECTION_LABEL } from '@/lib/menu-surface'
import { cn } from '@/lib/utils'

/** Every row shape below — item, sub-trigger, checkbox, radio — is the house row
 *  plus what Base UI needs on top of it: its focus/disabled data attributes and
 *  the glyph rules. */
const ROW = `${MENU_ITEM} select-none focus:bg-hairline-soft focus:text-text-strong data-inset:pl-[27px] data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5`

/** A submenu trigger's held state — open, pointer gone, still the live row. */
const ROW_HELD =
  'data-popup-open:bg-hairline-soft data-popup-open:text-text-strong data-open:bg-hairline-soft data-open:text-text-strong'

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  align = 'start',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  anchor,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset' | 'anchor'
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        anchor={anchor}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            `z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto duration-100 outline-none ${MENU_PANEL}`,
            'data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      // A group heading is machine voice (DESIGN.md), so it is set in the mono
      // micro-caps the rest of the shell names its regions in — and uppercased
      // here rather than at every call site, since some headings are data.
      className={cn(
        `pt-[2px] pb-[3px] uppercase data-inset:pl-[27px] ${MENU_SECTION_LABEL}`,
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-pressable
      data-inset={inset}
      data-variant={variant}
      className={cn(
        // Destructive stays a tint plus red ink, never a solid red slab
        // (DESIGN.md) — and the ink has to survive both lit states, or the row
        // stops reading as destructive exactly when the pointer is on it.
        `group/dropdown-menu-item relative ${ROW} data-[variant=destructive]:text-destructive data-[variant=destructive]:hover:bg-destructive/10 data-[variant=destructive]:hover:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive`,
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-pressable
      data-inset={inset}
      className={cn(`${ROW} ${ROW_HELD}`, className)}
      {...props}
    >
      {children}
      {/* The "there is more this way" mark, not a glyph on the text column:
          smaller than 14px and in the faint ink, so it stays an affordance
          rather than competing with the row's own icon. */}
      <ChevronRightIcon className="ml-auto size-3 text-text-faint" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({
  align = 'start',
  alignOffset = -3,
  side = 'right',
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'w-auto min-w-[96px] duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
        className,
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-pressable
      data-inset={inset}
      className={cn(`relative ${ROW} pr-7`, className)}
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-[5px] flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-pressable
      data-inset={inset}
      className={cn(`relative ${ROW} pr-7`, className)}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-[5px] flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(MENU_RULE, className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      // A keystroke is machine voice, so it takes the same trailing-hint
      // treatment as a timestamp or a refusal reason rather than a widened Sans.
      className={cn(MENU_HINT, className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
}
