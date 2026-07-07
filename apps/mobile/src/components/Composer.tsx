import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { color, font, radius, space } from '../theme/theme'

/** Chat composer: multiline input + send. Clears on send; caller queues delivery. */
export function Composer({
  placeholder,
  onSend,
  disabled,
}: {
  placeholder: string
  onSend: (text: string) => void
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const canSend = !disabled && text.trim().length > 0

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  return (
    <View style={styles.row}>
      <TextInput
        accessibilityLabel={placeholder}
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={color.textFaint}
        multiline
        editable={!disabled}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send"
        disabled={!canSend}
        onPress={send}
        style={[styles.send, !canSend && styles.sendDisabled]}
      >
        <Text style={styles.sendText}>↑</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.bgRaised,
  },
  input: {
    flex: 1,
    color: color.text,
    fontSize: font.body,
    lineHeight: 20,
    maxHeight: 120,
    backgroundColor: color.bgSunken,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: radius.full,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: {
    opacity: 0.35,
  },
  sendText: {
    color: color.accentText,
    fontSize: 20,
    fontWeight: '700',
    marginTop: -2,
  },
})
