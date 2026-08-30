import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
// `ActionSheetIOS` exists only in React Native proper — react-native-web has no
// such export, and a NAMED import of it would fail the web bundle and the
// vitest graph at resolve time — so the native-only API is reached as a
// namespace member instead. Everything both platforms export stays named.
import * as ReactNative from 'react-native'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { alpha } from '../theme/mix'
import { color, font, leading, mono, radius, sans, space } from '../theme/theme'
import { nativeSheetEligible, nativeSheetSpec } from './action-sheet-native'
import { BottomSheet } from './BottomSheet'
import { PressableScale } from './PressableScale'

export interface SheetAction {
  label: string
  /** One line under the label, for a choice the label alone can't settle
   *  (e.g. task vs bare session — where the work ends up differs).
   *  JS sheet only — the UIKit sheet has no subtitle line. */
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

interface ActionSheetProps {
  visible: boolean
  title?: string
  /** One sentence under the title, where the choice needs framing. */
  subtitle?: string
  actions: SheetAction[]
  onClose: () => void
  testID?: string
}

/**
 * The app's menu sheet.
 *
 * On iOS it is the REAL UIKit action sheet wherever the menu is expressible as
 * one — plain labels, red destructive rows, greyed disabled rows, Cancel. That
 * is what the 3-dots and long-press menus are, and no JS redraw of the platform
 * sheet ever reads as native next to the genuine article. Menus whose rows
 * carry state or identity beyond a label (a checkmark, a count, a glyph — see
 * {@link nativeSheetEligible}) keep the JS sheet on every platform, as does the
 * web and Android build wholesale. A given menu's shape is static, so the
 * choice never flips while a sheet is open.
 */
export function ActionSheet(props: ActionSheetProps) {
  if (Platform.OS === 'ios' && nativeSheetEligible(props.actions)) {
    return <NativeActionSheet {...props} />
  }
  return <JsActionSheet {...props} />
}

/**
 * The UIKit presentation. `showActionSheetWithOptions` is imperative, so this
 * renders nothing and presents on the rising edge of `visible`, reading the
 * menu's content through `latest` at that moment — the arrays call sites pass
 * are rebuilt every render, and an effect keyed on them would re-present.
 *
 * The chosen action runs DEFERRED, the same contract as the JS sheet below:
 * iOS silently drops a modal presented while another dismisses (item 5 of the
 * 2026-08-27 device feedback), and an action here may open an RN `Modal` — a
 * follow-up picker on the JS sheet, the task inspector. UIKit invokes this
 * completion only after its own dismissal has finished; the one extra
 * macrotask keeps the follow-up's presentation off the very tail of that
 * transition. The action runs BEFORE `onClose`: hosts like WorkIssueMenu key
 * their teardown on "nothing is open", and the action's hand-off to a nested
 * sheet is what keeps the close from reading as done.
 */
function NativeActionSheet({ visible, title, subtitle, actions, onClose }: ActionSheetProps) {
  const latest = useRef({ title, subtitle, actions, onClose })
  latest.current = { title, subtitle, actions, onClose }
  const presented = useRef(false)
  useEffect(() => {
    if (!visible) {
      // A host withdrawing `visible` while the sheet is up (a programmatic
      // close) has no other way to reach UIKit.
      if (presented.current) {
        presented.current = false
        ReactNative.ActionSheetIOS.dismissActionSheet()
      }
      return
    }
    if (presented.current) return
    presented.current = true
    const spec = nativeSheetSpec(latest.current)
    ReactNative.ActionSheetIOS.showActionSheetWithOptions(
      // Dark-only app, and the bisque accent writes the option labels the way
      // it writes every other accent `color:` in the app.
      { ...spec, tintColor: color.accent, userInterfaceStyle: 'dark' },
      (buttonIndex) => {
        presented.current = false
        const current = latest.current
        const chosen = buttonIndex >= 0 ? current.actions[buttonIndex] : undefined
        if (!chosen || chosen.disabled) {
          current.onClose()
          return
        }
        setTimeout(() => {
          chosen.onPress()
          latest.current.onClose()
        }, 0)
      },
    )
  }, [visible])
  return null
}

/**
 * The JS sheet: a grouped, inset action list on the one shared
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
function JsActionSheet({ visible, title, subtitle, actions, onClose, testID }: ActionSheetProps) {
  // A pressed action runs AFTER this sheet's modal is fully gone, not at press
  // time. Both this menu and whatever the action opens (the task inspector, the
  // launch picker, the colour sheet) live in their own RN `Modal`, and iOS will
  // not present a modal while another is still dismissing — it silently drops
  // the presentation. (Item 5 of the 2026-08-27 device feedback: "inspect task
  // does not open the inspector sheet".)
  //
  // And the sheet closes ITSELF (`closing`) rather than asking the host at
  // press time: hosts like WorkIssueMenu key their teardown on "no sheet is
  // open", and an `onClose` fired at press reads as exactly that — the host
  // unmounts everything, exit animation and pending action included. So a row
  // press only records its action and starts the exit; when the animation
  // finishes and the Modal unmounts, one macrotask clears UIKit to present the
  // next sheet, the action runs — free to hand off to a follow-up sheet — and
  // only then does the host hear `onClose`.
  const [closing, setClosing] = useState(false)
  const pendingAction = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!visible) setClosing(false)
  }, [visible])
  const finishDismiss = useCallback(() => {
    const run = pendingAction.current
    pendingAction.current = null
    if (!run) {
      onClose()
      return
    }
    setTimeout(() => {
      run()
      onClose()
    }, 0)
  }, [onClose])
  const hasIcons = actions.some((action) => action.icon != null)
  return (
    <BottomSheet
      visible={visible && !closing}
      onClose={finishDismiss}
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
          onPress={() => setClosing(true)}
          style={({ pressed }) => [styles.cancel, pressed && styles.rowPressed]}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </PressableScale>
      }
    >
      <View style={styles.group}>
        {actions.map((action, i) => (
          <Fragment key={action.label}>
            {/* iOS-style separators: their own hairlines, inset to the text
                column when the rows carry a glyph, full-bleed to the right. */}
            {i > 0 ? <View style={[styles.separator, hasIcons && styles.separatorInset]} /> : null}
            <PressableScale
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
                pendingAction.current = action.onPress
                setClosing(true)
              }}
              style={({ pressed }) => [
                styles.row,
                action.disabled && styles.rowDisabled,
                pressed && (action.destructive ? styles.rowPressedDanger : styles.rowPressed),
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
          </Fragment>
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
  // The inset-grouped card, at the corner radius iOS gives its own.
  group: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
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
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: alpha(color.hairline, 0.8),
    marginLeft: space.lg - 2,
  },
  // Past the glyph column (icon 26 + row gap), so the rules run down the text edge.
  separatorInset: {
    marginLeft: space.lg - 2 + 26 + space.md,
  },
  rowPressed: {
    backgroundColor: color.surfacePressed,
  },
  rowPressedDanger: {
    backgroundColor: color.dangerSoft,
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
  // Menu rows read at body size, like the platform's own sheets — the old
  // `small` was the footnote tier, and it is most of why the menu felt like a
  // desktop tool shrunk onto a phone.
  label: {
    ...sans(500),
    color: color.text,
    fontSize: font.body,
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
    color: color.dangerText,
  },
  cancel: {
    paddingVertical: 15,
    marginHorizontal: space.md,
    marginTop: space.sm,
    alignItems: 'center',
    borderRadius: radius.xl,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  cancelText: {
    ...sans(600),
    color: color.body,
    fontSize: font.body,
  },
})
