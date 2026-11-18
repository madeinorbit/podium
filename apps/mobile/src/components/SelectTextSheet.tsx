import { markdownPlainText } from '@podium/client-core/markdown-plain-text'
import { useEffect, useMemo, useState } from 'react'
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { useDismissOnRootLeave } from '../navigation/use-dismiss-on-root-leave'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { ActivityModal as Modal } from './ActivityModal'
import { PressableScale } from './PressableScale'

/**
 * SELECT TEXT (POD-2429): one message in a native, read-only text view, so the
 * operator gets the system's own selection — handles, loupe, any range — and
 * can copy or quote just that range. React Native's selectable paragraph text
 * on iOS only copies whole paragraphs, so the feed cannot do this in place.
 */
export function SelectTextSheet({
  text,
  onClose,
  onCopy,
  onQuote,
}: {
  /** The message's raw text; `null` hides the sheet. */
  text: string | null
  onClose: () => void
  onCopy: (text: string) => void
  /** Absent where the host has no composer to quote into. */
  onQuote?: ((text: string) => void) | undefined
}) {
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  useDismissOnRootLeave(onClose, text !== null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message starts with nothing selected
  useEffect(() => {
    setSelection({ start: 0, end: 0 })
  }, [text])
  const body = useMemo(() => markdownPlainText(text ?? ''), [text])
  const selected = body.slice(selection.start, selection.end)
  const chosen = selected.trim().length > 0 ? selected : body
  const finish = (act: (value: string) => void) => {
    act(chosen)
    onClose()
  }
  return (
    <Modal
      visible={text !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <View style={styles.bar}>
          <View style={styles.barSide} />
          <Text style={styles.title} accessibilityRole="header">
            Select Text
          </Text>
          <View style={[styles.barSide, styles.barTrailing]}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Done"
              haptic={false}
              onPress={onClose}
              style={styles.barButton}
            >
              <Text style={styles.done}>Done</Text>
            </PressableScale>
          </View>
        </View>
        <TextInput
          accessibilityLabel="Message text"
          value={body}
          multiline
          scrollEnabled
          // iOS keeps a non-editable text view selectable; elsewhere the field
          // stays focusable for selection but never raises a keyboard or edits.
          editable={Platform.OS !== 'ios'}
          showSoftInputOnFocus={false}
          onChangeText={() => {}}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          selectionColor={color.accent}
          style={styles.text}
        />
        <View style={styles.toolbar}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={selected.trim() ? 'Copy selection' : 'Copy message'}
            onPress={() => finish(onCopy)}
            style={styles.action}
          >
            <Text style={styles.actionLabel}>
              {selected.trim() ? 'Copy Selection' : 'Copy All'}
            </Text>
          </PressableScale>
          {onQuote ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={selected.trim() ? 'Quote selection' : 'Quote message'}
              onPress={() => finish(onQuote)}
              style={styles.action}
            >
              <Text style={styles.actionLabel}>
                {selected.trim() ? 'Quote Selection' : 'Quote All'}
              </Text>
            </PressableScale>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bgRaised },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: space.lg,
  },
  barSide: { flex: 1 },
  barTrailing: { alignItems: 'flex-end' },
  barButton: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' },
  title: { ...sans(600), color: color.text, fontSize: font.body },
  done: { ...sans(600), color: color.accentTint, fontSize: font.body },
  text: {
    ...sans(400),
    flex: 1,
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.lg,
    textAlignVertical: 'top',
  },
  toolbar: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xl + space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  action: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.control,
    backgroundColor: color.tertiaryFill,
  },
  actionLabel: { ...sans(600), color: color.accentTint, fontSize: font.small },
})
