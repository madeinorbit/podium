import { BlurView } from 'expo-blur'
import { LinearGradient } from 'expo-linear-gradient'
import { ArrowUp } from 'lucide-react-native'
import { useEffect, useRef, useState } from 'react'
import type {
  LayoutChangeEvent,
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
import { alpha } from '../theme/mix'
import { color, font, leading, radius, sans, space, spring } from '../theme/theme'
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

/** The send target — 32pt of ink, 52pt of thumb once hitSlop is counted. */
const SEND = 32
/** The band above the composer where scrolling text dissolves into the canvas. */
const SCRIM = 24

/**
 * Chat composer — one floating rounded surface inset from the screen edges
 * [POD-502].
 *
 * It used to be a full-width slab welded to the bottom edge, holding an
 * outlined field with a terminal `>` glyph and a fixed 45px editable area. It
 * is now a frosted capsule in the same material as the floating tab bar: it
 * measures its own content and springs from one line through six before
 * scrolling inside itself, with the send control pinned to the bottom of the
 * row so it never travels while the text grows above it.
 *
 * Two deliberate quietings. THE FIELD IS SANS, not the old mono: a prompt is
 * prose, it renders as sans the moment it lands in the transcript, and every
 * other field in the app is already sans — the mono was a terminal costume on
 * a touch text view. And NOTHING IN THE RESTING COMPOSER IS COLOURED: focus
 * lifts the hairline by one tier rather than flipping it to Superade Yellow,
 * and the send control earns its fill only once there is something to send.
 * Yellow in this app means "waiting on you"; a permanently yellow composer
 * spends the one signal on furniture.
 */
export function Composer({
  placeholder,
  onSend,
  disabled,
  caption,
  captionTone = 'working',
  draftInsertion,
  bottomInset = 0,
  scrimColor,
  onRestingHeight,
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
  /**
   * The canvas colour behind the composer, when it floats OVER scrolling
   * content. Text passing underneath dissolves into this rather than being
   * sliced by the capsule's top edge. Absent means the composer sits in the
   * layout flow and has nothing to dissolve.
   */
  scrimColor?: string
  /**
   * The composer's total height whenever the field is at rest, so a list
   * underneath can end its content above it. Deliberately not reported while
   * the field is grown: the reference composers do not reflow the conversation
   * under you as you type, and doing so would relayout the feed on every frame
   * of the growth spring.
   */
  onRestingHeight?: (height: number) => void
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

  const height = composerFieldHeight(measured, line)
  const scrolls = composerScrolls(measured, line)
  const maxHeight = composerMaxHeight(line)
  const atRest = height === COMPOSER_MIN_HEIGHT
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

  const onLayout = (e: LayoutChangeEvent) => {
    if (atRest) onRestingHeight?.(e.nativeEvent.layout.height)
  }

  // The keyboard covers the home indicator, so its inset stops existing the
  // moment the keyboard is up; keeping it would float the composer in a gap.
  const chrome = bottomInset > 0 ? bottomInset : keyboardVisible ? 0 : insets.bottom

  return (
    <View
      style={[styles.dock, { paddingBottom: chrome + space.sm }]}
      pointerEvents="box-none"
      onLayout={onLayout}
    >
      {scrimColor ? (
        <LinearGradient
          colors={[alpha(scrimColor, 0), scrimColor]}
          style={styles.scrim}
          pointerEvents="none"
        />
      ) : null}
      <BlurView
        intensity={32}
        tint="dark"
        testID="composer-bar"
        style={[styles.surface, focused && styles.surfaceFocused, disabled && styles.disabled]}
      >
        {/* The blur is not a surface on its own — it needs a tint to sit on,
            the way the tab-bar capsule does. */}
        <View style={styles.fill} pointerEvents="none" />
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
              placeholderTextColor={color.textDim}
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
          <SendButton ready={canSend} onPress={send} reduceMotion={reduceMotion} />
        </View>
      </BlurView>
    </View>
  )
}

/**
 * Ink arrow at rest, filled disc once there is something to send.
 *
 * The fill animates in behind a glyph that never moves, so "can send" arrives
 * as a change of weight rather than a change of layout — this control row has
 * to stay put while the field above it grows.
 */
function SendButton({
  ready,
  onPress,
  reduceMotion,
}: {
  ready: boolean
  onPress: () => void
  reduceMotion: boolean
}) {
  const fill = useRef(new Animated.Value(ready ? 1 : 0)).current

  useEffect(() => {
    if (reduceMotion) {
      fill.setValue(ready ? 1 : 0)
      return
    }
    const settle = Animated.spring(fill, {
      toValue: ready ? 1 : 0,
      useNativeDriver: true,
      ...spring.snappy,
    })
    settle.start()
    return () => settle.stop()
  }, [fill, ready, reduceMotion])

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="Send"
      disabled={!ready}
      onPress={onPress}
      scaleTo={0.9}
      hitSlop={10}
      style={styles.send}
    >
      <Animated.View
        style={[
          styles.sendDisc,
          {
            opacity: fill,
            transform: [{ scale: fill.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.sendGlyph,
          { opacity: fill.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) },
        ]}
      >
        <Icon as={ArrowUp} size={18} color={color.textFaint} />
      </Animated.View>
      <Animated.View style={[styles.sendGlyph, { opacity: fill }]}>
        <Icon as={ArrowUp} size={18} color={color.bg} />
      </Animated.View>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  /** Positioning only — the inset the capsule floats inside. */
  dock: {
    paddingHorizontal: space.lg,
    paddingTop: SCRIM,
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SCRIM,
  },
  surface: {
    borderRadius: radius.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    // The blur is drawn by a child layer, so the radius has to clip it — the
    // same arrangement as the tab-bar capsule.
    overflow: 'hidden',
    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.5)',
    // Text sits a comfortable inset off the curve; a round control needs less
    // than text does to look equally inset.
    paddingLeft: space.lg + 2,
    paddingRight: space.sm + 2,
    paddingVertical: space.sm + 1,
  },
  // Focus lifts the seam one tier. It does not change hue: the caret is in the
  // field and the keyboard is already up — the signal has been sent.
  surfaceFocused: {
    borderColor: color.border,
  },
  // Opacity, never geometry: a pending or blocked composer must not resize.
  disabled: {
    opacity: 0.55,
  },
  fill: {
    ...StyleSheet.absoluteFill,
    // Opaque enough that a coloured row passing underneath reads as a soft
    // shape rather than as colour inside the composer — a yellow action card
    // sliding past used to tint the capsule itself.
    backgroundColor: 'rgba(10, 15, 28, 0.88)',
  },
  caption: {
    ...sans(500),
    color: color.working,
    fontSize: font.micro,
    lineHeight: leading(font.micro),
    paddingBottom: space.xs + 1,
  },
  captionAttention: {
    color: color.needsYou,
  },
  /**
   * `flex-end` is what makes the control row stable: the field grows upward off
   * the bottom edge and the send control stays exactly where it was.
   */
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
  },
  /**
   * Height is animated, so it is set on the wrapper rather than the input —
   * the input's own node stays free for the web measurement to collapse.
   * The bottom margin centres a single line against the taller send control
   * and then simply rides up with the text.
   */
  fieldWrap: {
    flex: 1,
    minWidth: 0,
    marginBottom: (SEND - COMPOSER_MIN_HEIGHT) / 2,
  },
  input: {
    ...sans(400),
    // The keyboard and the caret are the focus signal on a touch field; the
    // browser's own ring would draw a second, competing one.
    ...(Platform.OS === 'web'
      ? ({ outlineStyle: 'none', overflowY: 'auto', resize: 'none' } as object)
      : null),
    flex: 1,
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body),
    padding: 0,
  },
  send: {
    width: SEND,
    height: SEND,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisc: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.full,
    backgroundColor: color.text,
  },
  sendGlyph: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
