import { BlurView } from 'expo-blur'
import { LinearGradient } from 'expo-linear-gradient'
import { ArrowUp } from 'lucide-react-native'
import { useEffect, useRef, useState } from 'react'
import type {
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
} from 'react-native'
import {
  Animated,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useKeyboardVisible } from '../hooks/useKeyboardVisible'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { color, font, leading, mono, radius, space, spring } from '../theme/theme'
import {
  COMPOSER_LINE,
  COMPOSER_MIN_HEIGHT,
  composerFieldHeight,
  composerMaxHeight,
  composerScrolls,
} from './composer-height'
import { useComposerMeasure } from './composer-measure'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/**
 * Translucent chrome under the composer. Web already had it via CSS
 * `backdrop-filter`; native had nothing, so the bar read as a flat slab over
 * the transcript [POD-366].
 */
function ComposerBackdrop() {
  if (Platform.OS === 'web') return null
  return <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
}

/**
 * Chat composer — one floating rounded surface inset from the screen edges
 * [POD-502].
 *
 * It used to be a full-width slab welded to the bottom edge, holding an
 * outlined field with a terminal `>` glyph and a fixed 45px editable area: the
 * text wrapped and clipped inside a box that never moved. It is now a single
 * surface that measures its own content and animates from one line through six
 * before scrolling inside itself, with the send orb pinned to the bottom of the
 * row so it never travels while the text grows above it.
 */
export function Composer({
  placeholder,
  onSend,
  disabled,
  caption,
  captionTone = 'working',
  draftInsertion,
  bottomInset = 0,
}: {
  placeholder: string
  onSend: (text: string) => void
  disabled?: boolean
  /** Compact agent activity inside the composer chrome; absent takes no space. */
  caption?: string | null
  captionTone?: 'working' | 'attention'
  /** A keyed insertion from a transcript action (for example Quote in reply). */
  draftInsertion?: { id: number; text: string } | null
  /**
   * Chrome already sitting below the composer that has paid the bottom safe
   * area for it — the floating tab bar. Zero (the default) means the composer
   * is the bottom-most thing on the screen and owns that inset itself.
   */
  bottomInset?: number
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [measured, setMeasured] = useState<number | null>(null)
  const [line, setLine] = useState(COMPOSER_LINE)
  const inputRef = useRef<TextInput>(null)
  const insets = useSafeAreaInsets()
  const keyboardVisible = useKeyboardVisible()
  const reduceMotion = useReduceMotion()
  const { width, fontScale } = useWindowDimensions()
  const canSend = !disabled && text.trim().length > 0
  const armed = focused || canSend

  const height = composerFieldHeight(measured, line)
  const scrolls = composerScrolls(measured, line)
  const maxHeight = composerMaxHeight(line)
  const animatedHeight = useRef(new Animated.Value(COMPOSER_MIN_HEIGHT)).current

  // Web has to be asked for the content height; native volunteers it through
  // onContentSizeChange below. `fontScale` is a dependency so raising Dynamic
  // Type re-measures instead of leaving the field a stale number of pixels tall.
  useComposerMeasure(inputRef, text, width * fontScale, setMeasured)

  // An empty field IS one line, so measuring it is how the composer learns what
  // a line costs at the operator's text size — the six-line cap is derived from
  // that rather than from the default-size token.
  useEffect(() => {
    if (text === '' && measured && measured > 0) setLine(measured)
  }, [text, measured])

  // Height is a layout property, so this animation cannot run on the native
  // driver. Reduce Motion takes the same geometry without the transition —
  // the composer still ends up exactly as tall, it just gets there at once.
  useEffect(() => {
    if (reduceMotion) {
      animatedHeight.setValue(height)
      return
    }
    const settle = Animated.spring(animatedHeight, {
      toValue: height,
      useNativeDriver: false,
      ...spring.smooth,
    })
    settle.start()
    return () => settle.stop()
  }, [animatedHeight, height, reduceMotion])

  useEffect(() => {
    if (!draftInsertion) return
    setText(
      (current) =>
        `${current}${current && !current.endsWith('\n') ? '\n' : ''}${draftInsertion.text}`,
    )
    inputRef.current?.focus()
  }, [draftInsertion])

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    setMeasured(null)
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

  const onContentSizeChange = (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
    setMeasured(e.nativeEvent.contentSize.height)
  }

  // The keyboard covers the home indicator, so its inset stops existing the
  // moment the keyboard is up; keeping it would float the composer in a gap.
  const chrome = bottomInset > 0 ? bottomInset : keyboardVisible ? 0 : insets.bottom

  return (
    <View style={[styles.dock, { paddingBottom: chrome + space.sm }]}>
      <View
        testID="composer-bar"
        style={[styles.surface, armed && styles.surfaceArmed, disabled && styles.surfaceDisabled]}
      >
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
          <Animated.View style={[styles.fieldWrap, { height: animatedHeight }]}>
            <TextInput
              ref={inputRef}
              accessibilityLabel={placeholder}
              style={[styles.input, { maxHeight }]}
              value={text}
              onChangeText={setText}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={placeholder}
              placeholderTextColor={color.textFaint}
              multiline
              editable={!disabled}
              onKeyPress={onKeyPress}
              // react-native-web answers this with a scrollHeight that can only
              // grow; useComposerMeasure asks the node directly instead.
              onContentSizeChange={Platform.OS === 'web' ? undefined : onContentSizeChange}
              scrollEnabled={scrolls}
              submitBehavior="submit"
              onSubmitEditing={send}
            />
          </Animated.View>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={!canSend}
            onPress={send}
            scaleTo={0.9}
            style={styles.sendWrap}
          >
            <LinearGradient
              // Disabled is a quiet raised chip in the navy family, not the
              // off-palette grey the old orb fell back to.
              colors={canSend ? color.accentGradient : [color.surfacePressed, color.elevated]}
              style={styles.send}
            >
              <Icon as={ArrowUp} size={19} color={canSend ? color.onAccent : color.textFaint} />
            </LinearGradient>
          </PressableScale>
        </View>
      </View>
    </View>
  )
}

const SEND = 34

const styles = StyleSheet.create({
  /** Positioning only — the inset the surface floats inside. */
  dock: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  surface: {
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.glass,
    // The blur backdrop and the scrolled text both have to stop at the radius.
    overflow: 'hidden',
    paddingLeft: space.lg,
    paddingRight: space.xs + 1,
    paddingVertical: 6,
    ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(14px)' } as object) : null),
  },
  // Focused/armed composer lights Superade Yellow — the composer grammar.
  surfaceArmed: {
    borderColor: color.accent,
  },
  // Opacity, never geometry: a pending or blocked composer must not resize.
  surfaceDisabled: {
    opacity: 0.55,
  },
  caption: {
    ...mono(400),
    color: color.working,
    fontSize: font.micro,
    lineHeight: leading(font.micro),
    paddingTop: 2,
    paddingBottom: 3,
  },
  captionAttention: {
    color: color.needsYou,
  },
  /**
   * `flex-end` is what makes the control row stable: the field grows upward off
   * the bottom edge and the send orb stays exactly where it was.
   */
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
  },
  /**
   * Height is animated, so it is set on the wrapper rather than the input —
   * the input's own node stays free for the web measurement to collapse.
   * The bottom margin centres a single line against the taller send orb and
   * then simply rides up with the text.
   */
  fieldWrap: {
    flex: 1,
    minWidth: 0,
    marginBottom: (SEND - COMPOSER_MIN_HEIGHT) / 2,
  },
  input: {
    ...mono(400),
    // The armed yellow border IS the focus signal (The Signal Rule); the
    // browser's own focus ring would draw a second, competing one.
    ...(Platform.OS === 'web'
      ? ({ outlineStyle: 'none', overflowY: 'auto', resize: 'none' } as object)
      : null),
    flex: 1,
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body),
    padding: 0,
  },
  sendWrap: {
    borderRadius: radius.full,
  },
  send: {
    width: SEND,
    height: SEND,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
