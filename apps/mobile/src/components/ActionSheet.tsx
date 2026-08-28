import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { alpha } from '../theme/mix'
import { color, font, leading, mono, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { PressableScale } from './PressableScale'

export interface SheetAction {
  label: string
  /** One line under the label, for a choice the label alone can't settle
   *  (e.g. task vs bare session — where the work ends up differs). */
  hint?: string
  /** Right-aligned metadata: a count, a machine name, a last-used stamp. */
  meta?: string
  /** Leading glyph slot — a harness mark, a repo tile, a stage glyph. */
  icon?: ReactNode
  /** Marks the current value; renders the checkmark and holds the row lit. */
  selected?: boolean
  destructive?: boolean
  disabled?: boolean
  onPress: () => void
}

/**
 * The app's menu sheet: a grouped, inset action list on the one shared
 * {@link BottomSheet} — same drag, same dismissal, same physics as the task
 * inspector and the new-work picker.
 *
 * Rows are LEFT-ALIGNED, not centred [POD-724]. A centred stack of labels is the
 * iOS 6 action sheet, and it stops being legible the moment a row carries a hint
 * or a trailing count: the eye has no column to run down. Left alignment with a
 * leading glyph slot is what every modern iOS menu does, and it is what lets the
 * new-work picker put a harness mark and a "last used" stamp on the same row
 * without inventing a second list style.
 */
export function ActionSheet({
  visible,
  title,
  subtitle,
  actions,
  onClose,
  testID,
}: {
  visible: boolean
  title?: string
  /** One sentence under the title, where the choice needs framing. */
  subtitle?: string
  actions: SheetAction[]
  onClose: () => void
  testID?: string
}) {
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      testID={testID}
      mode="fit"
      scrollable={actions.length > 7}
      contentStyle={styles.content}
      head={
        title ? (
          <View style={styles.titles}>
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={2}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        ) : null
      }
      footerRule={false}
      footer={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onClose}
          style={({ pressed }) => [styles.cancel, pressed && styles.rowPressed]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </PressableScale>
      }
    >
      <View style={styles.group}>
        {actions.map((action, i) => (
          <PressableScale
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            {...(action.hint ? { accessibilityHint: action.hint } : {})}
            // `aria-pressed`, not `aria-selected`, and beside `accessibilityState` rather
            // than instead of it. react-native-web 0.21 reads only the `aria-*` spelling,
            // so the web build announced no state at all; and `aria-selected` is only
            // valid on a listbox/tab/grid role, so on a `button` it is ignored — the
            // browser-visible way to say a button is the chosen one is `aria-pressed`.
            // React Native still reads `accessibilityState` on device. [POD-1664]
            // An action with no `selected` at all is not a toggle, and an undefined
            // value renders no attribute — which is what those actions want.
            accessibilityState={{ disabled: action.disabled, selected: action.selected }}
            aria-pressed={action.selected}
            disabled={action.disabled}
            scaleTo={0.99}
            onPress={() => {
              onClose()
              action.onPress()
            }}
            style={({ pressed }) => [
              styles.row,
              i > 0 && styles.divider,
              action.disabled && styles.rowDisabled,
              pressed && styles.rowPressed,
            ]}
          >
            {action.icon ? <View style={styles.icon}>{action.icon}</View> : null}
            <View style={styles.rowText}>
              <Text
                style={[styles.label, action.destructive && styles.destructive]}
                numberOfLines={1}
              >
                {action.label}
              </Text>
              {action.hint ? (
                <Text style={styles.hint} numberOfLines={2}>
                  {action.hint}
                </Text>
              ) : null}
            </View>
            {action.meta ? <Text style={styles.meta}>{action.meta}</Text> : null}
            {action.selected ? <Text style={styles.check}>✓</Text> : null}
          </PressableScale>
        ))}
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  titles: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: 3,
  },
  // The sheet's subject, not a section label: an issue ref and its title read as
  // shouting in the uppercase mono the old sheet used, and a task title is the
  // most common thing that lands here.
  title: {
    ...sans(600),
    color: color.body,
    fontSize: font.small,
    textAlign: 'center',
  },
  subtitle: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
    textAlign: 'center',
  },
  content: {
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  group: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: 'hidden',
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 11,
    paddingHorizontal: space.lg - 2,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.hairline, 0.8),
  },
  rowPressed: {
    backgroundColor: color.surfacePressed,
  },
  rowDisabled: {
    opacity: 0.38,
  },
  icon: {
    width: 26,
    alignItems: 'center',
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  label: {
    ...sans(500),
    color: color.text,
    fontSize: font.small,
  },
  hint: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  meta: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
  },
  check: {
    ...mono(600),
    color: color.accentTint,
    fontSize: font.small,
  },
  destructive: {
    color: color.danger,
  },
  cancel: {
    paddingVertical: 15,
    marginHorizontal: space.md,
    marginTop: space.sm,
    alignItems: 'center',
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  cancelText: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.body,
  },
})
