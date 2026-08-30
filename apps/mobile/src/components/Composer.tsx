import { BlurView } from 'expo-blur'
import { ArrowUp, ClipboardPaste, Mic, MicOff, Paperclip, Square } from './icons'
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
import { useKeyboardVisible } from '../hooks/useKeyboardVisible'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { type VoiceInput, useVoiceInput } from '../hooks/useVoiceInput'
import { onMediaPaste } from '../lib/composer-media'
import { alpha } from '../theme/mix'
import { color, font, leading, radius, sans, space, spring } from '../theme/theme'
import { AttachmentStrip } from './AttachmentStrip'
import {
  COMPOSER_LINE,
  composerAtRest,
  composerFieldHeight,
  composerMaxHeight,
  composerScrolls,
} from './composer-height'
import { composerKeyAction, hasHardwareKeyboard } from './composer-keys'
import { useComposerMeasure } from './composer-measure'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import type { ComposerAttachmentsApi, SentAttachment } from './useComposerAttachments'

const CONTROL_TARGET = 44
/** The filled disc inside a control's 44pt target — send, and mic while live. */
const CONTROL_INK = 32
/** One glyph size for the whole row: three controls, three weights read as a bug. */
const GLYPH = 20
/**
 * How far text sits off the surface padding. Small, because the padding does
 * most of the work — this is the last few points that put the prose on the
 * same left edge as the control glyphs below it.
 */
const TEXT_INSET = space.xs

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
 * [POD-502], stacked field-over-controls [POD-1659].
 *
 * It used to be a full-width slab welded to the bottom edge, holding an
 * outlined field with a terminal `>` glyph and a fixed 45px editable area. It
 * is now a frosted capsule in the same material as the floating tab bar: it
 * measures its own content and snaps from one line through six before scrolling
 * inside itself.
 *
 * THE CONTROLS SIT ON THEIR OWN ROW UNDER THE FIELD. They used to flank it —
 * attach and mic to its left, send to its right — which spent three 44pt
 * targets of the one line the prose had. On a 390pt phone that left the field
 * roughly half the capsule, and a placeholder of ordinary length ("Message —
 * resumes the agent…") did not fit in it: POD-1666 stopped it wrapping the
 * composer to two lines, but it stops fitting either way, and what the operator
 * reads is "Message — resumes the ag…". Stacking is the other half of that fix
 * — the field is 1.78× wider here, the placeholder fits whole, and a grown
 * prompt spends FEWER lines than it did flanked despite the extra row.
 *
 * It is also the arrangement every reference composer on a phone converges on,
 * which is the shape this was asked for.
 *
 * The row reads outside-in from each end: attach at the leading edge because
 * it acts on what you are about to write, dictation and send at the trailing
 * edge because they are how you finish. Nothing travels when the field grows —
 * the row hangs off the bottom of the capsule and the text expands upward
 * away from it.
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
export function Composer({
  placeholder,
  onSend,
  disabled,
  caption,
  captionTone = 'working',
  draftInsertion,
  attachments,
  // Aliased: `leading` is also the theme's line-height helper, imported above.
  leading: leadingSlot,
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
   * Rides at the LEADING end of the control row, after the attach control —
   * the Superagent model/effort rail.
   *
   * It used to hang under the capsule as a third band, on the reasoning that
   * anything inside the well would steal tap targets from the text. That held
   * while the field shared its line with the controls; it does not now that
   * the field owns a full-width row of its own [POD-1659]. Below the capsule
   * it left the control row's whole leading half empty and stacked a third
   * band under a two-row box. Whatever lands here has to SHRINK — the row's
   * trailing pair is two fixed 44pt targets, and the leading slot gets what
   * is left.
   */
  leading?: ReactNode
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
  const takesAttach = Boolean(attachments?.pick ?? attachments?.paste)
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
  const atRest = composerAtRest(measured, line)

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
        <View style={[styles.fieldWrap, { height }]}>
          <TextInput
            ref={inputRef}
            {...composerFieldProps}
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
        {/* Leading cluster, then the gap, then the trailing cluster. The
            spacer is a flexing view rather than `justifyContent: space-between`
            so the row keeps its shape when one end is empty — a composer with
            no attach control must not centre its send disc. */}
        <View style={styles.controls}>
          {takesAttach ? (
            <AttachButton
              mode={attachments?.pick ? 'pick' : 'paste'}
              disabled={disabled === true}
              onPress={attachments?.pick ?? attachments?.paste ?? (() => {})}
            />
          ) : null}
          {leadingSlot ? (
            <View style={[styles.leading, !takesAttach && styles.leadingAlone]}>{leadingSlot}</View>
          ) : null}
          <View style={styles.controlGap} pointerEvents="none" />
          {voice.supported ? (
            <VoiceButton
              starting={voice.starting}
              listening={voice.listening}
              failed={voice.error !== null}
              disabled={disabled === true}
              onStart={startVoice}
              onStop={voice.stop}
            />
          ) : null}
          <SendButton ready={canSend} onPress={send} reduceMotion={reduceMotion} />
        </View>
      </BlurView>
    </View>
  )
}

/**
 * Names the field for the web shell's one-line placeholder rule [POD-1666].
 *
 * The composer rests at ONE line, so a placeholder that wraps has nowhere to
 * put its second one — it was silently clipped mid-word. The rule that
 * ellipsizes it lives in scripts/patch-web-html.ts with the app's other
 * browser tells, and needs a handle on the node; `dataSet` is
 * react-native-web's escape hatch to a `data-*` attribute, the same one
 * ../lib/selectable.ts uses. On native the placeholder is laid out by the
 * platform and takes no rule.
 */
const composerFieldProps: object =
  Platform.OS === 'web' ? { dataSet: { composerField: 'true' } } : {}

/**
 * Dictation — a bare mic at rest, a stop square on an ink disc while it runs.
 *
 * The active fill is the SAME 32pt disc the send control draws, not the full
 * 44pt target it used to flood: two round controls sitting side by side on the
 * trailing edge have to agree about how big a filled control is, or the row
 * looks like it has two different button sizes in it.
 */
function VoiceButton({
  starting,
  listening,
  failed,
  disabled,
  onStart,
  onStop,
}: {
  starting: boolean
  listening: boolean
  failed: boolean
  disabled: boolean
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
      // BOTH spellings on purpose. `accessibilityState` is what React Native
      // reads on device; react-native-web stopped mapping it to ARIA in 0.21
      // and takes the `aria-*` props directly, so web dropped the busy state
      // silently — the control announced "start dictation" while it was
      // already opening the microphone. [POD-1659]
      accessibilityState={{ busy: starting, disabled }}
      aria-busy={starting}
      testID="composer-voice"
      disabled={disabled}
      onPress={active ? onStop : onStart}
      scaleTo={0.9}
      style={({ pressed }) => [styles.control, pressed && styles.controlPressed]}
    >
      {listening || failed ? (
        <View style={[styles.controlDisc, failed ? styles.voiceFailed : styles.voiceListening]} />
      ) : null}
      <Icon
        as={listening ? Square : failed ? MicOff : Mic}
        size={listening ? 14 : GLYPH}
        color={listening ? color.bg : failed ? color.dangerText : color.textDim}
      />
    </PressableScale>
  )
}

/**
 * The attach control — a paperclip where a file dialog exists, a clipboard where
 * the only route is the OS pasteboard (native, whose text field reports no paste
 * event of its own).
 * It sits alone at the LEADING end of the control row, under the field rather
 * than beside it, so a growing prompt pushes nothing around. Ink weight, never
 * accent: this is furniture, and the one filled control in the capsule is the
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
      style={({ pressed }) => [styles.control, pressed && styles.controlPressed]}
    >
      <Icon as={mode === 'pick' ? Paperclip : ClipboardPaste} size={GLYPH} color={color.textDim} />
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
      style={styles.control}
    >
      <Animated.View
        style={[
          styles.controlDisc,
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
        <Icon as={ArrowUp} size={GLYPH} color={color.textDim} />
      </Animated.View>
      <Animated.View style={[styles.sendGlyph, { opacity: fill }]}>
        <Icon as={ArrowUp} size={GLYPH} color={color.bg} />
      </Animated.View>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  /** Positioning only — the inset the capsule floats inside. */
  dock: {
    paddingHorizontal: space.lg,
  },
  /**
   * One padding on all four sides now that nothing is welded to an edge. The
   * old asymmetry (18 left for text, 10 right for a round control) existed
   * because the field and the send target shared a row; with the controls on
   * their own rail below, the row hangs its own glyphs back out to the curve
   * through `controls` and the surface can be square about it.
   */
  surface: {
    borderRadius: radius.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    // The blur is drawn by a child layer, so the radius has to clip it — the
    // same arrangement as the tab-bar capsule.
    overflow: 'hidden',
    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.5)',
    paddingHorizontal: space.md,
    paddingTop: space.md,
    // The control row's 44pt target already carries ~12 of air under its
    // glyph; paying the full inset again would hang the capsule open.
    paddingBottom: space.xs,
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
    color: color.workingText,
    fontSize: font.micro,
    lineHeight: leading(font.micro),
    paddingBottom: space.xs + 1,
    marginHorizontal: TEXT_INSET,
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
    marginHorizontal: TEXT_INSET,
  },
  voiceStatusError: {
    color: color.dangerText,
  },
  voiceStatusEmpty: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    opacity: 0,
  },
  /**
   * Height is set on the wrapper rather than the input, leaving the input's own
   * node free for web measurement to collapse. It snaps to each measurement:
   * typing and paste are too frequent to drive layout frames under the blur.
   * Full width: the whole point of the stack is that prose never shares a line
   * with a control.
   */
  fieldWrap: {
    marginHorizontal: TEXT_INSET,
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
  /**
   * The control rail. The negative inset pulls the 44pt targets back out so the
   * GLYPHS — not the invisible boxes around them — line up with the text above:
   * a 20pt glyph centred in a 44pt box carries 12 of its own padding, which is
   * exactly the surface inset it has to cancel to sit at {@link TEXT_INSET}.
   */
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: -(CONTROL_TARGET - GLYPH) / 2 + TEXT_INSET,
    marginTop: space.xs,
  },
  /**
   * The leading slot's box. It SHRINKS and the trailing pair does not: the two
   * 44pt targets are fixed, so a long model label ellipsizes rather than
   * pushing send off the row.
   */
  leading: {
    flexShrink: 1,
    minWidth: 0,
    // Shrinking stops exactly where the trailing target begins, which reads as
    // a chip kissing the mic once a long label truncates. This is the air the
    // flexing gap cannot guarantee, because at narrow widths there is none.
    marginRight: space.sm,
  },
  /**
   * With no attach control in front of it, the slot pays back half the
   * difference the row's negative inset took out, so a chip's border starts on
   * the same left edge a glyph would have. Alongside the paperclip it needs
   * nothing: that target already carries those 12 points as trailing air.
   */
  leadingAlone: {
    marginLeft: (CONTROL_TARGET - GLYPH) / 2,
  },
  controlGap: {
    flex: 1,
  },
  control: {
    width: CONTROL_TARGET,
    height: CONTROL_TARGET,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlPressed: {
    opacity: 0.55,
  },
  /** The one filled shape a control is allowed: centred, and never the target. */
  controlDisc: {
    position: 'absolute',
    top: (CONTROL_TARGET - CONTROL_INK) / 2,
    left: (CONTROL_TARGET - CONTROL_INK) / 2,
    width: CONTROL_INK,
    height: CONTROL_INK,
    borderRadius: radius.full,
  },
  voiceListening: {
    backgroundColor: color.text,
  },
  voiceFailed: {
    backgroundColor: alpha(color.danger, 0.12),
  },
  sendDisc: {
    backgroundColor: color.text,
  },
  sendGlyph: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
