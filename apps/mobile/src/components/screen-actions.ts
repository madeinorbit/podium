import type { AppIcon } from './icons'

/** One entry of a header pull-down menu. */
export interface ScreenMenuItem {
  label: string
  icon?: AppIcon
  /** Draws the checkmark for the current choice. */
  selected?: boolean
  destructive?: boolean
  onPress: () => void
}

/**
 * A trailing header action. On iOS it becomes a native bar button item (system
 * glass on iOS 26); with `items` it opens a native pull-down menu instead of
 * calling `onPress`.
 */
export interface ScreenAction {
  label: string
  icon: AppIcon
  onPress?: () => void
  items?: readonly ScreenMenuItem[]
}
