import { LinearGradient } from 'expo-linear-gradient'
import { ArrowUp } from 'lucide-react-native'
import { useState } from 'react'
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { color, font, mono, radius, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/** Chat composer — the super-agent field (Flat Field, POD-159): mono, a '>'
 *  prompt glyph, yellow border on focus; gradient send orb kept for touch. */
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
  const [focused, setFocused] = useState(false)
  const canSend = !disabled && text.trim().length > 0
  const armed = focused || canSend

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  return (
    <View style={styles.row}>
      <View style={[styles.field, armed && styles.fieldArmed]}>
        <Text style={styles.gt}>{'>'}</Text>
        <TextInput
          accessibilityLabel={placeholder}
          style={styles.input}
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={color.textFaint}
          multiline
          editable={!disabled}
        />
      </View>
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
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm + 1,
    backgroundColor: 'rgba(8, 8, 12, 0.7)',
    borderColor: color.borderStrong,
    borderWidth: 1.5,
    borderRadius: 9,
    paddingHorizontal: space.md + 1,
    paddingVertical: space.sm + 2,
  },
  // Focused/armed composer lights Superade Yellow — the composer grammar.
  fieldArmed: {
    borderColor: color.accent,
  },
  gt: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.body,
    lineHeight: 19,
    paddingTop: 1,
  },
  input: {
    ...mono(400),
    flex: 1,
    color: color.text,
    fontSize: font.body,
    lineHeight: 19,
    maxHeight: 120,
    padding: 0,
    paddingTop: 1,
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
