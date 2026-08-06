import { BlurView } from 'expo-blur'
import { LinearGradient } from 'expo-linear-gradient'
import { ArrowUp } from 'lucide-react-native'
import { useState } from 'react'
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from 'react-native'
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { color, font, leading, mono, radius, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/**
 * Translucent chrome under the composer. Web already had it via CSS
 * `backdrop-filter`; native had nothing, so the bar read as a flat slab over
 * the transcript [POD-366]. `expo-blur` was already a dependency with zero
 * call sites.
 */
function ComposerBackdrop() {
  if (Platform.OS === 'web') return null
  return <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
}

/** Chat composer — the super-agent field (Flat Field, POD-159): mono, a '>'
 *  prompt glyph, yellow border on focus; gradient send orb kept for touch. */
export function Composer({
  placeholder,
  onSend,
  disabled,
  caption,
  captionTone = 'working',
}: {
  placeholder: string
  onSend: (text: string) => void
  disabled?: boolean
  /** Compact agent activity inside the composer chrome; absent takes no space. */
  caption?: string | null
  captionTone?: 'working' | 'attention'
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

  // A physical keyboard (the phone web app on a desktop browser, or a paired
  // Bluetooth keyboard) must submit on Enter — the multiline field otherwise
  // only ever inserts a newline and the composer reads as "it doesn't send".
  // Shift+Enter keeps the newline, matching the desktop composer.
  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const native = e.nativeEvent as TextInputKeyPressEventData & { shiftKey?: boolean }
    if (native.key !== 'Enter' || native.shiftKey) return
    e.preventDefault?.()
    send()
  }

  return (
    <View style={styles.bar} testID="composer-bar">
      <ComposerBackdrop />
      {caption ? (
        <Text
          numberOfLines={1}
          testID="composer-caption"
          style={[styles.caption, captionTone === 'attention' && styles.captionAttention]}
        >
          {caption}
        </Text>
      ) : null}
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
            onKeyPress={onKeyPress}
            submitBehavior="submit"
            onSubmitEditing={send}
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
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
    backgroundColor: color.glass,
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(14px)' } as object) : null),
  },
  caption: {
    ...mono(400),
    color: color.working,
    fontSize: font.micro,
    lineHeight: leading(font.micro),
    paddingHorizontal: space.xs,
    paddingBottom: 2,
  },
  captionAttention: {
    color: color.needsYou,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
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
    lineHeight: leading(font.body),
    paddingTop: 1,
  },
  input: {
    ...mono(400),
    // The armed yellow border IS the focus signal (The Signal Rule); the
    // browser's own focus ring would draw a second, competing one.
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
    flex: 1,
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body),
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
