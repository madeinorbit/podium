import { LinearGradient } from 'expo-linear-gradient'
import { ArrowUp } from 'lucide-react-native'
import { useState } from 'react'
import { Platform, StyleSheet, TextInput, View } from 'react-native'
import { color, font, radius, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/** Chat composer: pill input on a glass bar, gradient send orb. */
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
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Send"
        disabled={!canSend}
        onPress={send}
        scaleTo={0.9}
        style={styles.sendWrap}
      >
        <LinearGradient
          colors={canSend ? color.accentGradient : ['#2a2e3c', '#232733']}
          style={styles.send}
        >
          <Icon as={ArrowUp} size={19} color={canSend ? color.onAccent : color.textFaint} />
        </LinearGradient>
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
    backgroundColor: color.glass,
    ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(14px)' } as object) : null),
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
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 3,
  },
  sendWrap: {
    borderRadius: radius.full,
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
