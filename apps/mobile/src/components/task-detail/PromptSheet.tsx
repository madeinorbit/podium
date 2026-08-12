import { useEffect, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { color, font, leading, monoLabel, radius, sans, space } from '../../theme/theme'
import { BottomSheet } from '../BottomSheet'
import { PressableScale } from '../PressableScale'

/**
 * One line of text, asked for from a sheet [POD-724].
 *
 * The desktop reaches for `window.prompt` when it flags a task for a human. There
 * is no such thing on a phone, and inventing a full-screen form for one optional
 * sentence would be heavier than the decision it serves — so this is the shared
 * {@link BottomSheet} with a field in its head and a confirm below. Empty is a
 * legitimate answer: flagging with no question is what the desktop does when the
 * operator dismisses the prompt's text, and the confirm stays enabled to say so.
 */
export function PromptSheet({
  visible,
  title,
  hint,
  placeholder,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  visible: boolean
  title: string
  hint?: string
  placeholder: string
  confirmLabel: string
  onConfirm: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState('')
  // A sheet reopened for a second flag must not carry the first one's text.
  useEffect(() => {
    if (visible) setValue('')
  }, [visible])

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      mode="fit"
      contentStyle={styles.content}
      head={
        <View style={styles.head}>
          <Text style={styles.label}>{title}</Text>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </View>
      }
    >
      <TextInput
        value={value}
        onChangeText={setValue}
        accessibilityLabel={title}
        placeholder={placeholder}
        placeholderTextColor={color.textMicro}
        multiline
        autoFocus
        style={styles.field}
      />
      <View style={styles.bar}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={onClose}
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
        >
          <Text style={styles.btnText}>Cancel</Text>
        </PressableScale>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
          onPress={() => {
            onClose()
            onConfirm(value.trim())
          }}
          style={({ pressed }) => [styles.btn, styles.confirm, pressed && styles.pressed]}
        >
          <Text style={[styles.btnText, styles.confirmText]}>{confirmLabel}</Text>
        </PressableScale>
      </View>
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
  hint: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.md,
  },
  field: {
    ...sans(400),
    minHeight: 88,
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
    textAlignVertical: 'top',
    backgroundColor: color.bgSunken,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space.sm,
  },
  btn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  confirm: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  pressed: {
    opacity: 0.7,
  },
  btnText: {
    ...sans(600),
    color: color.body,
    fontSize: font.small,
  },
  confirmText: {
    color: color.onAccent,
  },
})
