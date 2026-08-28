import {
  ISSUE_COLOR_HEX,
  ISSUE_COLOR_SLOTS,
  type IssueColorSlot,
  type IssueWire,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import * as Haptics from 'expo-haptics'
import { StyleSheet, Text, View } from 'react-native'
import { useMobileStore } from '../client/hooks'
import { issueSquareFg } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { PressableScale } from './PressableScale'

/**
 * The ten-slot colour grid, on the phone — the twin of the desktop's
 * `IssueColorSwatches`, which POD-380 lifted out of the web IdSquare precisely
 * so the context menu's Colour submenu IS the picker rather than a text list
 * imitating one. The phone had no picker at all: an issue could only be coloured
 * at the desk, which made the colour channel — the thing that carries a task's
 * identity through every row, header and pane on both platforms — a desktop
 * feature the phone merely rendered.
 *
 * The write uses the same optimistic `updateIssue` action as the desktop menu,
 * so a colour chosen here is on the sidebar row before the thumb leaves the
 * glass and survives offline in the mobile queue.
 */
export function IssueColorSheet({
  issue,
  onClose,
}: {
  issue: IssueWire | null
  onClose: () => void
}) {
  const store = useMobileStore()
  const current = issue?.color as IssueColorSlot | undefined

  const pick = (slot: IssueColorSlot | null) => {
    if (!issue) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
    void store.updateIssue(issue.id, { color: slot }).catch(() => {})
    onClose()
  }

  return (
    <BottomSheet
      visible={issue !== null}
      onClose={onClose}
      mode="fit"
      contentStyle={styles.content}
      head={
        issue ? (
          <View style={styles.head}>
            <Text style={styles.label}>Colour</Text>
            <Text style={styles.title} numberOfLines={1}>
              {issueDisplayRef(issue)} {issue.title}
            </Text>
          </View>
        ) : null
      }
    >
      <View style={styles.grid}>
        {ISSUE_COLOR_SLOTS.map((slot) => {
          const hex = ISSUE_COLOR_HEX[slot]
          const on = current === slot
          return (
            <PressableScale
              key={slot}
              accessibilityRole="button"
              accessibilityLabel={slot}
              // `aria-pressed`, not `aria-selected`, and beside `accessibilityState` rather
              // than instead of it. react-native-web 0.21 reads only the `aria-*` spelling,
              // so the web build announced no state at all; and `aria-selected` is only
              // valid on a listbox/tab/grid role, so on a `button` it is ignored — the
              // browser-visible way to say a button is the chosen one is `aria-pressed`.
              // React Native still reads `accessibilityState` on device. [POD-1664]
              accessibilityState={{ selected: on }}
              aria-pressed={on}
              onPress={() => pick(slot)}
              scaleTo={0.92}
              style={[
                styles.swatch,
                { backgroundColor: hex },
                on ? { borderColor: color.text, borderWidth: 2.5 } : null,
              ]}
            >
              {on ? <Text style={[styles.tick, { color: issueSquareFg(hex) }]}>✓</Text> : null}
            </PressableScale>
          )
        })}
      </View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="No colour"
        accessibilityState={{ selected: current === undefined }}
        aria-pressed={current === undefined}
        onPress={() => pick(null)}
        style={({ pressed }) => [styles.clear, pressed && styles.clearPressed]}
      >
        <View style={styles.clearChip}>
          <Text style={styles.clearGlyph}>✕</Text>
        </View>
        <Text style={styles.clearText}>No colour</Text>
      </PressableScale>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  head: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: 3,
  },
  label: {
    ...monoLabel(),
    color: color.label,
  },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm + 2,
  },
  // Five per row at any phone width: the cell is the remainder after four gaps,
  // expressed as a flex basis rather than a hard-coded pixel size that only
  // lands on one device.
  swatch: {
    flexBasis: '17%',
    flexGrow: 1,
    aspectRatio: 1,
    borderRadius: radius.lg,
    borderWidth: 0,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tick: {
    ...mono(700),
    fontSize: font.body,
  },
  clear: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  clearPressed: {
    backgroundColor: color.surfacePressed,
  },
  clearChip: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.textFaint,
    backgroundColor: alpha(color.border, 0.5),
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearGlyph: {
    ...mono(400),
    color: color.textMicro,
    fontSize: 10,
  },
  clearText: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
  },
})
