import type { AppIcon } from './icons'

/** One entry of a header pull-down menu. */
export interface ScreenMenuItem {
  label: string
  icon?: AppIcon
  /** A second line under the label (UIMenu's subtitle). */
  hint?: string
  /** Draws the checkmark for the current choice. */
  selected?: boolean
  /** Red, with UIKit's destructive attribute. */
  destructive?: boolean
  disabled?: boolean
  onPress: () => void
}

/**
 * A group of menu entries. Inline (the default) draws as a divided section of
 * the same menu, as Mail and Notes group their actions; `submenu` folds the
 * entries behind one row named `title` that opens them in place.
 */
export interface ScreenMenuSection {
  title?: string
  icon?: AppIcon
  submenu?: boolean
  items: readonly ScreenMenuEntry[]
}

export type ScreenMenuEntry = ScreenMenuItem | ScreenMenuSection

export function isMenuSection(entry: ScreenMenuEntry): entry is ScreenMenuSection {
  return 'items' in entry
}

/**
 * A trailing header action. On iOS it becomes a native bar button item (system
 * glass on iOS 26); with `items` it opens a native pull-down menu instead of
 * calling `onPress`. Android and web draw the same action as a header button,
 * and its `items` as the app's action sheet.
 */
export interface ScreenAction {
  label: string
  icon: AppIcon
  /** Visible text (a scope or range picker such as "All projects"); `label` stays the spoken name. */
  title?: string
  onPress?: () => void
  items?: readonly ScreenMenuEntry[]
  /** The heading Android and web give the menu's sheet (iOS menus carry none, as Mail's). */
  menuTitle?: string
  /** The sheet fallback's test id. */
  testID?: string
}
