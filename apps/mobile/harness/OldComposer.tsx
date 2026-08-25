/**
 * The pre-POD-1659 composer — the flanked layout, taken from 9e6dfbfb4 so the
 * restack can be judged against the thing it replaced rather than a memory of
 * it. Capture only; nothing ships this.
 *
 * Changed from that revision in two ways and no others: the relative imports
 * are rewritten for this directory, and the export is renamed so both layouts
 * can stand on one page. The layout, the styles and the geometry are untouched.
 */
import { BlurView } from 'expo-blur'
import { ArrowUp, ClipboardPaste, Mic, MicOff, Paperclip, Square } from 'lucide-react-native'
import { type ReactNode, useEffect, useRef, useState } from 'react'
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
import { AttachmentStrip } from '../src/components/AttachmentStrip'
import {
  COMPOSER_LINE,
  COMPOSER_MIN_HEIGHT,
  composerFieldHeight,
  composerMaxHeight,
  composerScrolls,
} from '../src/components/composer-height'
import { composerKeyAction, hasHardwareKeyboard } from '../src/components/composer-keys'
import { useComposerMeasure } from '../src/components/composer-measure'
import { Icon } from '../src/components/Icon'
import { PressableScale } from '../src/components/PressableScale'
import type {
  ComposerAttachmentsApi,
  SentAttachment,
} from '../src/components/useComposerAttachments'
import { useKeyboardVisible } from '../src/hooks/useKeyboardVisible'
import { useReduceMotion } from '../src/hooks/useReduceMotion'
import { useVoiceInput, type VoiceInput } from '../src/hooks/useVoiceInput'
import { onMediaPaste } from '../src/lib/composer-media'
import { alpha } from '../src/theme/mix'
import { color, font, leading, radius, sans, space, spring } from '../src/theme/theme'

const CONTROL_TARGET = 44
const SEND_INK = 32

export function appendDictation(current: string, phrase: string): string {
  const finalized = phrase.trim()
  if (!finalized) return current
  if (!current || /\s$/.test(current)) return `${current}${finalized}`
  return `${current} ${finalized}`
}

export function composerVoiceStatus(
  voice: Pick<VoiceInput, 'starting' | 'listening' | 'statusMessage' | 'error'>,
): string {
  if (voice.starting) return voice.statusMessage ?? 'Starting dictation…'
  if (voice.listening) return voice.statusMessage ?? 'Listening…'
  return voice.error?.message ?? ''
}

/**
 * Chat composer — one floating rounded surface inset from the screen edges
 * [POD-502].
 *
 * It used to be a full-width slab welded to the bottom edge, holding an
 * outlined field with a terminal `>` glyph and a fixed 45px editable area. It
 * is now a frosted capsule in the same material as the floating tab bar: it
 * measures its own content and snaps from one line through six before scrolling
 * inside itself, with the send control pinned to the bottom of the row so it
 * never travels while the text grows above it.
 *
 * Two deliberate quietings. THE FIELD IS SANS, not the old mono: a prompt is
 * prose, it renders as sans the moment it lands in the transcript, and every
 * other field in the app is already sans — the mono was a terminal costume on
 * a touch text view. And NOTHING IN THE RESTING COMPOSER IS COLOURED: focus
 * lifts the hairline by one tier rather than flipping it to the accent, and the
 * send control earns its fill only once there is something to send. Bisque in
 * this app means "waiting on you"; a permanently accented composer spends the
 * one signal on furniture.
 */
export function OldComposer({
  placeholder,
  onSend,
  disabled,
  caption,
  captionTone = 'working',
  draftInsertion,
  attachments,
  below,
  bottomInset = 0,
  onRestingHeight,
}: {
  placeholder: string
  /**
   * The prose, plus anything attached to it. The two are handed over SEPARATELY
   * rather than pre-joined: the caller has to send one string but paint the
   * other half as thumbnails on its optimistic bubble, and re-splitting a
   * composed prompt to recover the paths is how the two copies drift.
   */
  onSend: (text: string, files?: readonly SentAttachment[]) => void
  disabled?: boolean
  /** Compact agent activity inside the composer chrome; absent takes no space. */
  caption?: string | null
  captionTone?: 'working' | 'attention'
  /** A keyed insertion from a transcript action (for example Quote in reply). */
  draftInsertion?: { id: number; text: string } | null
  /**
   * Files riding with this prompt — paste, drop, or the picker. Absent means
   * this composer takes words only, and no attach control is drawn at all: a
   * paperclip on a surface with nowhere to put a file is worse than none.
   */
  attachments?: ComposerAttachmentsApi
  /**
   * Sits UNDER the well, still inside the dock — the Superagent model/effort
   * rail. Outside the capsule so it is never an unreachable text target.
   */
  below?: ReactNode
  /**
   * Chrome already sitting below the composer that has paid the bottom safe
   * area for it — the floating tab bar. Zero (the default) means the composer
   * is the bottom-most thing on the screen and owns that inset itself.
   */
  bottomInset?: number
  /**
   * The composer's total height whenever the field is at rest, so a list
   * underneath can end its content above it. Deliberately not reported while
   * the field is grown: the reference composers do not reflow the conversation
   * under you as you type, and doing so would relayout the feed on every
   * content-size update.
   */
  onRestingHeight?: (height: number) => void
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [measured, setMeasured] = useState<number | null>(null)
  const [line, setLine] = useState(COMPOSER_LINE)
  const inputRef = useRef<TextInput>(null)
  const voice = useVoiceInput()
  const committedText = appendDictation(text, voice.session?.finalText ?? '')
  const composedText = appendDictation(committedText, voice.session?.interimText ?? '')
  const committedTextRef = useRef(committedText)
  committedTextRef.current = committedText
  const clearVoiceRef = useRef(voice.clear)
  clearVoiceRef.current = voice.clear
  // Read once per mount rather than per keystroke: `matchMedia` is a layout
  // query, and the answer does not change while a prompt is being typed.
  const hardwareKeyboard = useRef(hasHardwareKeyboard())
  const insets = useSafeAreaInsets()
  const keyboardVisible = useKeyboardVisible()
  const reduceMotion = useReduceMotion()
  const { width, fontScale } = useWindowDimensions()
  const attached = attachments?.attachments ?? []
  const uploading = attachments?.uploading ?? false
  // An attachment with no words IS a message — "look at this" is the whole
  // prompt half the time. What must never be sent is a path that has not
  // finished uploading, so a chip in flight blocks the send rather than racing
  // it.
  const canSend =
    !disabled &&
    !uploading &&
    (committedText.trim().length > 0 || attached.some((file) => file.state === 'ready'))

  const height = composerFieldHeight(measured, line)
  const scrolls = composerScrolls(measured, line)
  const maxHeight = composerMaxHeight(line)
  const atRest = height === COMPOSER_MIN_HEIGHT

  // Web has to be asked for the content height; native volunteers it through
  // onContentSizeChange below. `fontScale` is a dependency so raising Dynamic
  // Type re-measures instead of leaving the field a stale number of pixels tall.
  useComposerMeasure(inputRef, composedText, width * fontScale, setMeasured)

  // An empty field IS one line, so measuring it is how the composer learns what
  // a line costs at the operator's text size — the six-line cap is derived from
  // that rather than from the default-size token.
  useEffect(() => {
    if (composedText === '' && measured && measured > 0) setLine(measured)
  }, [composedText, measured])

  /**
   * PASTE AND DROP, ON THE FIELD ITSELF.
   *
   * Wired to the composer's own text node rather than the document: a paste into
   * the PROMPT is a different event from a paste anywhere else on the page, and
   * a page-level listener would swallow both. `accept` is read through a ref so
   * re-binding the listener is not the price of one chip arriving.
   */
  const acceptRef = useRef(attachments?.accept)
  acceptRef.current = attachments?.accept
  const takesMedia = attachments !== undefined
  useEffect(() => {
    if (!takesMedia) return
    return onMediaPaste(inputRef.current, (files) => acceptRef.current?.(files))
  }, [takesMedia])

  useEffect(() => {
    if (!draftInsertion) return
    clearVoiceRef.current()
    const current = committedTextRef.current
    setText(`${current}${current && !current.endsWith('\n') ? '\n' : ''}${draftInsertion.text}`)
    inputRef.current?.focus()
  }, [draftInsertion])

  useEffect(() => {
    if (disabled && (voice.starting || voice.listening)) voice.stop()
  }, [disabled, voice.listening, voice.starting, voice.stop])

  const send = () => {
    if (!canSend) return
    const trimmed = committedText.trim()
    const files = attachments?.ready() ?? []
    if (!trimmed && files.length === 0) return
    voice.clear()
    onSend(trimmed, files.length > 0 ? files : undefined)
    attachments?.clear()
    setText('')
    setMeasured(null)
  }

  // ENTER MAKES A NEWLINE ON A PHONE. See ./composer-keys.ts for why, and for
  // the one case that still submits: a real keyboard, or the Cmd/Ctrl chord.
  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const native = e.nativeEvent as TextInputKeyPressEventData & {
      shiftKey?: boolean
      metaKey?: boolean
      ctrlKey?: boolean
      altKey?: boolean
    }
    const action = composerKeyAction(native, hardwareKeyboard.current)
    if (action !== 'send') return
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
  const voiceStatus = composerVoiceStatus(voice)

  const changeText = (next: string) => {
    if (voice.session || voice.starting || voice.listening || voice.error) voice.clear()
    setText(next)
  }

  const startVoice = () => {
    // A completed session remains visible until the next draft boundary. Move
    // its finalized text into the typed base before starting the new session.
    setText(committedText)
    voice.start()
  }

  return (
    <View
      style={[styles.dock, { paddingBottom: chrome + space.sm }]}
      pointerEvents="box-none"
      onLayout={onLayout}
    >
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
        {attachments ? (
          <AttachmentStrip attachments={attached} onRemove={attachments.remove} />
        ) : null}
        <Text
          accessibilityLiveRegion="polite"
          testID="composer-voice-status"
          style={[
            styles.voiceStatus,
            !voiceStatus && styles.voiceStatusEmpty,
            voice.error && styles.voiceStatusError,
          ]}
        >
          {voiceStatus}
        </Text>
        <View style={styles.row}>
          {attachments?.pick || attachments?.paste ? (
            <AttachButton
              mode={attachments.pick ? 'pick' : 'paste'}
              disabled={disabled === true}
              onPress={attachments.pick ?? attachments.paste ?? (() => {})}
            />
          ) : null}
          {voice.supported ? (
            <VoiceButton
              starting={voice.starting}
              listening={voice.listening}
              failed={voice.error !== null}
              disabled={disabled === true}
              inset={!(attachments?.pick || attachments?.paste)}
              onStart={startVoice}
              onStop={voice.stop}
            />
          ) : null}
          <View style={[styles.fieldWrap, { height }]}>
            <TextInput
              ref={inputRef}
              accessibilityLabel={placeholder}
              style={[styles.input, { maxHeight }]}
              value={composedText}
              onChangeText={changeText}
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
              // THE RETURN KEY INSERTS A LINE. It used to be wired to `submit`
              // with `onSubmitEditing` sending, which is what made a soft
              // keyboard's Enter fire the message; the hardware-keyboard case is
              // handled in `onKeyPress` instead, where the modifiers are legible.
              submitBehavior="newline"
            />
          </View>
          <SendButton ready={canSend} onPress={send} reduceMotion={reduceMotion} />
        </View>
      </BlurView>
      {below}
    </View>
  )
}

function VoiceButton({
  starting,
  listening,
  failed,
  disabled,
  inset,
  onStart,
  onStop,
}: {
  starting: boolean
  listening: boolean
  failed: boolean
  disabled: boolean
  inset: boolean
  onStart: () => void
  onStop: () => void
}) {
  const active = starting || listening
  const label = starting
    ? 'Cancel dictation startup'
    : listening
      ? 'Stop dictation'
      : failed
        ? 'Retry dictation'
        : 'Start dictation'

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: starting, disabled }}
      testID="composer-voice"
      disabled={disabled}
      onPress={active ? onStop : onStart}
      scaleTo={0.9}
      style={({ pressed }) => [
        styles.voice,
        inset && styles.voiceInset,
        listening && styles.voiceListening,
        failed && styles.voiceFailed,
        pressed && styles.voicePressed,
      ]}
    >
      <Icon
        as={listening ? Square : failed ? MicOff : Mic}
        size={listening ? 15 : 19}
        color={listening ? color.bg : failed ? color.danger : color.textFaint}
      />
    </PressableScale>
  )
}

/**
 * The attach control — a paperclip where a file dialog exists, a clipboard where
 * the only route is the OS pasteboard (native, whose text field reports no paste
 * event of its own).
 * It sits at the LEFT end of the control row, bottom-aligned with the send
 * target, so the growing field pushes neither of them around. Ink weight, never
 * accent: this is furniture, and the one coloured control in the capsule is the
 * send disc.
 */
function AttachButton({
  mode,
  disabled,
  onPress,
}: {
  mode: 'pick' | 'paste'
  disabled: boolean
  onPress: () => void
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={mode === 'pick' ? 'Attach a file' : 'Paste an image'}
      testID="composer-attach"
      disabled={disabled}
      onPress={onPress}
      scaleTo={0.9}
      style={({ pressed }) => [styles.attach, pressed && styles.attachPressed]}
    >
      <Icon as={mode === 'pick' ? Paperclip : ClipboardPaste} size={18} color={color.textFaint} />
    </PressableScale>
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
    // shape rather than as colour inside the composer — an accented action card
    // sliding past used to tint the capsule itself.
    backgroundColor: alpha(color.bg, 0.88),
  },
  caption: {
    ...sans(500),
    color: color.working,
    fontSize: font.micro,
    lineHeight: leading(font.micro),
    paddingBottom: space.xs + 1,
  },
  captionAttention: {
    color: color.needsYouText,
  },
  voiceStatus: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.micro,
    lineHeight: leading(font.micro),
    paddingBottom: space.xs + 1,
  },
  voiceStatusError: {
    color: color.danger,
  },
  voiceStatusEmpty: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    opacity: 0,
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
   * Height is set on the wrapper rather than the input, leaving the input's own
   * node free for web measurement to collapse. It snaps to each measurement:
   * typing and paste are too frequent to drive layout frames under the blur.
   * The bottom margin centres a single line against the taller send control and
   * then simply rides up with the text.
   */
  fieldWrap: {
    flex: 1,
    minWidth: 0,
    marginBottom: (CONTROL_TARGET - COMPOSER_MIN_HEIGHT) / 2,
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
  attach: {
    width: CONTROL_TARGET,
    height: CONTROL_TARGET,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    // Pulls the glyph back toward the capsule's curve: the field's own text
    // inset is generous, and a round control needs less of it than text does.
    marginLeft: -(space.sm + 2),
  },
  attachPressed: {
    opacity: 0.55,
  },
  voice: {
    width: CONTROL_TARGET,
    height: CONTROL_TARGET,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceInset: {
    marginLeft: -(space.sm + 2),
  },
  voiceListening: {
    backgroundColor: color.text,
  },
  voiceFailed: {
    backgroundColor: alpha(color.danger, 0.12),
  },
  voicePressed: {
    opacity: 0.65,
  },
  send: {
    width: CONTROL_TARGET,
    height: CONTROL_TARGET,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisc: {
    position: 'absolute',
    top: (CONTROL_TARGET - SEND_INK) / 2,
    left: (CONTROL_TARGET - SEND_INK) / 2,
    width: SEND_INK,
    height: SEND_INK,
    borderRadius: radius.full,
    backgroundColor: color.text,
  },
  sendGlyph: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
