import type { SheetAction } from './ActionSheet'

/**
 * The pure half of {@link ActionSheet}'s native path: which menus the UIKit
 * action sheet can express, and the exact `showActionSheetWithOptions`
 * arguments a menu maps to. Kept free of React and react-native imports so the
 * mapping is testable on any platform — the presentation glue in ActionSheet
 * stays a thin effect.
 */

/** The subset of `ActionSheetIOSOptions` this app derives from a menu. */
export interface NativeSheetSpec {
  title?: string
  message?: string
  /** Every action's label in order, then Cancel — UIKit wants it in the list. */
  options: string[]
  cancelButtonIndex: number
  destructiveButtonIndex?: number[]
  disabledButtonIndices?: number[]
}

/**
 * A UIKit action sheet row is a label and nothing else — plain, red, greyed, or
 * Cancel. A row that carries state or identity beyond its label has no UIKit
 * slot to land in: `selected` marks the current value (its absence is what says
 * "not a toggle", so `selected: false` still counts), `meta` a count or a
 * last-used stamp, `icon` a stage glyph or harness mark. Those menus keep the
 * JS sheet on every platform rather than silently shedding what the row was
 * saying. `hint` is the one thing the native path does drop: the label still
 * names the action, and the platform sheet simply has no subtitle line.
 */
export function nativeSheetEligible(actions: readonly SheetAction[]): boolean {
  return actions.every(
    (action) => action.selected == null && action.meta == null && action.icon == null,
  )
}

/** Actions map to options 1:1 with Cancel appended, so a callback index below
 *  `actions.length` IS the chosen action's index. */
export function nativeSheetSpec({
  title,
  subtitle,
  actions,
}: {
  title?: string | undefined
  subtitle?: string | undefined
  actions: readonly SheetAction[]
}): NativeSheetSpec {
  const destructive = actions.flatMap((action, index) => (action.destructive ? [index] : []))
  const disabled = actions.flatMap((action, index) => (action.disabled ? [index] : []))
  return {
    ...(title ? { title } : {}),
    ...(subtitle ? { message: subtitle } : {}),
    options: [...actions.map((action) => action.label), 'Cancel'],
    cancelButtonIndex: actions.length,
    ...(destructive.length > 0 ? { destructiveButtonIndex: destructive } : {}),
    ...(disabled.length > 0 ? { disabledButtonIndices: disabled } : {}),
  }
}

/** One pickable value; `group` is the connector heading the JS sheet shows. */
export interface NativePickerOption {
  value: string
  label: string
  /** Renders greyed and unpickable — the machine rows a principal lacks. */
  disabled?: boolean | undefined
}

/**
 * A PICKER is a menu of VALUES with one current choice — the model and effort
 * switchers. UIKit rows carry no checkmark or section slots, so the mapping
 * spends the label itself: the current value wears "✓ " and a group's heading
 * folds into its rows as "Group · Label". That trade was originally grounds to
 * keep pickers on the JS sheet; the 2026-08-28 device feedback ("model
 * switcher menus are still old style") decided the other way — the native
 * presentation is worth a checkmark spelled as a character.
 */
export function nativePickerSpec({
  title,
  groups,
  selected,
}: {
  title?: string | undefined
  groups: readonly { label?: string | undefined; options: readonly NativePickerOption[] }[]
  selected?: string | undefined
}): { spec: NativeSheetSpec; values: string[] } {
  const flat = groups.flatMap((group) =>
    group.options.map((option) => ({
      value: option.value,
      disabled: option.disabled === true,
      label: `${option.value === selected ? '✓ ' : ''}${
        group.label ? `${group.label} · ` : ''
      }${option.label}`,
    })),
  )
  const disabled = flat.flatMap((row, index) => (row.disabled ? [index] : []))
  return {
    spec: {
      ...(title ? { title } : {}),
      options: [...flat.map((row) => row.label), 'Cancel'],
      cancelButtonIndex: flat.length,
      ...(disabled.length > 0 ? { disabledButtonIndices: disabled } : {}),
    },
    values: flat.map((row) => row.value),
  }
}
