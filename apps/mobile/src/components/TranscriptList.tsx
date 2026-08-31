import {
  type ChatBlock,
  failLine,
  formatChurn,
  latestPendingQuestion,
  type ParsedEnvelope,
  resultPreview,
  toolBatchTitle,
  toolRunFailures,
  toolVerdict,
} from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { ChevronDown, ChevronRight, ChevronUp, X } from './icons'
import {
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Animated,
  AppState,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  type RefreshControlProps,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useReduceMotion } from '../hooks/useReduceMotion'
import type { RefreshAccessibilityProps } from '../hooks/useRefreshableTab'
import type { TranscriptAssetContext } from '../lib/transcript-assets'
import {
  appendedTranscriptArrivals,
  buildMobileTranscript,
  envelopePrincipal,
  isChosenOption,
  liveAssistantRow,
  type MobileTranscriptRow,
  machineContextLabel,
  parseAskQuestions,
  quoteTranscriptText,
  searchMobileTranscript,
  transcriptItemKey,
} from '../lib/transcript-feed'
import {
  atTail as atTailRule,
  measureAtTail,
  newestJump,
  shouldFollowContentGrowth,
  tailOffset,
} from '../lib/transcript-tail'
import {
  color,
  elevation,
  font,
  leading,
  mono,
  monoLabel,
  radius,
  sans,
  space,
  spring,
} from '../theme/theme'
import { ActionSheet, type SheetAction } from './ActionSheet'
import { type AskQuestionAnswer, AskQuestionCard } from './AskQuestionCard'
import { Icon } from './Icon'
import { PendingFiles } from './PendingFiles'
import { PressableScale } from './PressableScale'
import { RichMarkdown } from './RichMarkdown'
import { SharedFiles } from './SharedFiles'
import { WorkingMark } from './WorkingMark'

/**
 * Flat Field rows (POD-159, adapted for mobile in POD-176): the agent's work
 * lies flat on the chassis; the operator's turns are the only elevated surface.
 * They do NOT stick to the top (POD-338) — a phone viewport is too short to
 * spend a permanent band on a message you already read. Tool runs are muted mono
 * one-liners with per-call ✓/✕ verdicts; the final answer gets the page's only
 * accent (a keyline, not a box); an answered ask collapses to a one-line receipt.
 */
interface PendingRow {
  key: string
  kind: 'pending'
  item: TranscriptItem
  blockIndices: []
  turn: 'open'
  pendingText: string
  pendingTurn: PendingTurn
}

type Row = MobileTranscriptRow | PendingRow

/** A turn the operator just sent, painted before the server echoes it back —
 *  the phone twin of the desktop chat's optimistic bubble (POD-338). Without it
 *  a send into a parked session looks like nothing happened at all. */
export interface PendingTurn {
  id: string
  /** The PROSE, without the attachment paths that ride with it — the paths are
   *  rendered as files below, exactly as they will be once the server echoes
   *  this turn back. */
  text: string
  /** Files uploaded with this turn, so the bubble shows the screenshot the
   *  operator just attached instead of a bare filename in the text. */
  files?: readonly { path: string; previewUri: string; name: string }[]
  /** Set when the send itself was REJECTED (POD-346). A rejected turn that
   *  keeps saying "sending…" is the worst possible outcome — the phone reads as
   *  broken and the words are lost. The row goes red, names the reason, and
   *  offers the send again. */
  failed?: string
  /** The operator stopped this interaction after sending it. */
  interrupted?: boolean
  /** Durable ledger identity. Present rows can be retracted across remounts. */
  queuedId?: string
  queued?: boolean
}

function shortTime(ts: string | undefined): string | undefined {
  if (!ts) return undefined
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return undefined
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function MessageText({
  text,
  style,
  onRefPress,
}: {
  text: string
  style: object
  onRefPress?: ((ref: string) => void) | undefined
}) {
  return <RichMarkdown text={text} textStyle={style} onRefPress={onRefPress} />
}

function EnvelopePrincipalLabel({
  label,
  onRefPress,
}: {
  label: string
  onRefPress?: (ref: string) => void
}) {
  const principal = envelopePrincipal(label)
  return (
    <>
      {principal.pre}
      {principal.ref ? (
        <Text
          style={styles.envelopeRef}
          onPress={onRefPress ? () => onRefPress(principal.ref as string) : undefined}
        >
          {principal.ref}
        </Text>
      ) : null}
      {principal.post}
    </>
  )
}

function EnvelopeRow({
  envelope,
  onRefPress,
}: {
  envelope: ParsedEnvelope
  onRefPress?: (ref: string) => void
}) {
  return (
    <View style={styles.envelope}>
      <View style={styles.envelopeHeader}>
        <Text style={styles.envelopeKind}>Internal</Text>
        <Text style={styles.envelopeRoute} numberOfLines={1}>
          <EnvelopePrincipalLabel label={envelope.from} onRefPress={onRefPress} />
          {' → '}
          <EnvelopePrincipalLabel label={envelope.to} onRefPress={onRefPress} />
        </Text>
        {envelope.question ? <Text style={styles.envelopeQuestion}>question</Text> : null}
        {envelope.expectsReply ? <Text style={styles.envelopeReply}>reply requested</Text> : null}
      </View>
      <Text style={styles.envelopeId}>{envelope.id}</Text>
      <View style={styles.envelopeBody}>
        <RichMarkdown text={envelope.body} onRefPress={onRefPress} />
      </View>
      {envelope.machineNote ? (
        <Text style={styles.envelopeMachine}>{envelope.machineNote}</Text>
      ) : null}
    </View>
  )
}

/** A machine-authored context block in headless sessions. Keep the transcript
 * quiet by default, while preserving the complete source behind a disclosure. */
function MachineContextDisclosure({ item }: { item: TranscriptItem }) {
  const [open, setOpen] = useState(false)
  return (
    <View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={machineContextLabel(item.text)}
        // `aria-expanded` beside `accessibilityState`: react-native-web 0.21 reads
        // only the former, so the web build announced no state at all. [POD-1664]
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [styles.contextToggle, pressed && styles.contextPressed]}
      >
        <Text style={styles.contextGlyph}>{open ? '▾' : '▸'}</Text>
        <Text style={styles.contextLabel}>{machineContextLabel(item.text)}</Text>
      </PressableScale>
      {open ? (
        <ScrollView style={styles.contextScroll} nestedScrollEnabled>
          <Text selectable style={styles.contextBody}>
            {item.text}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  )
}

/**
 * A phone-native work line. It spends one line on the run and a tap unfolds a
 * useful result preview.
 */
function ToolsRun({ blocks }: { blocks: ChatBlock[] }) {
  const [expanded, setExpanded] = useState(false)
  const failures = toolRunFailures(blocks)
  const durationMs = blocks.reduce((total, block) => total + (block.item.durationMs ?? 0), 0)

  return (
    <View style={styles.tools}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} work run: ${toolBatchTitle(blocks)}`}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.workLine, pressed && styles.workLinePressed]}
      >
        <Text style={[styles.workDisclosure, failures > 0 && styles.workDisclosureFailed]}>
          {failures > 0 ? '✕' : '✓'}
        </Text>
        <Text style={styles.workTitle} numberOfLines={1}>
          {toolBatchTitle(blocks)}
        </Text>
        <Text style={styles.workCount}>{formatChurn(durationMs)}</Text>
        <Icon as={expanded ? ChevronDown : ChevronRight} size={14} color={color.textMicro} />
      </PressableScale>
      {expanded
        ? blocks.map((b) => {
            const { item } = b
            const result = b.result ?? item.toolResult
            const verdict = toolVerdict(result)
            const desc = item.toolTitle ?? item.toolInput ?? ''
            const files = item.toolPaths?.length ?? 0
            const preview = resultPreview(result)
            return (
              <View key={item.id}>
                <View style={styles.trow}>
                  <Text
                    style={[
                      styles.toolGlyph,
                      verdict === 'ok' && styles.toolGlyphOk,
                      verdict === 'err' && styles.toolGlyphErr,
                    ]}
                  >
                    {verdict === 'err' ? '✕' : verdict === 'ok' ? '✓' : '·'}
                  </Text>
                  <Text style={styles.toolName}>{item.toolName ?? 'result'}</Text>
                  <Text style={styles.toolDesc} numberOfLines={1}>
                    {desc}
                  </Text>
                  {files > 1 ? <Text style={styles.toolMag}>{files} files</Text> : null}
                </View>
                {verdict === 'err' ? (
                  <Text style={styles.toolFail} numberOfLines={1}>
                    {failLine(result)}
                  </Text>
                ) : preview ? (
                  <Text style={styles.toolPreview} numberOfLines={1}>
                    {preview.line}
                    {preview.more > 0 ? `  +${preview.more}` : ''}
                  </Text>
                ) : null}
              </View>
            )
          })
        : null}
    </View>
  )
}

/** An answered AskUserQuestion, collapsed to "? question — picked" so past
 *  decisions stay auditable without spending attention. */
function AskReceipt({ item }: { item: TranscriptItem }) {
  const questions = parseAskQuestions(item.toolInputJson)
  const first = questions[0]
  const picked = first?.options
    .filter((o) => isChosenOption(item.toolResult ?? '', o.label))
    .map((o) => o.label)
    .join(', ')
  return (
    <View style={styles.receipt}>
      <Text style={styles.receiptGlyph}>?</Text>
      <Text style={styles.receiptQ} numberOfLines={2}>
        {first?.question ?? item.toolInput ?? 'Question'}
      </Text>
      {picked ? (
        <Text style={styles.receiptPick} numberOfLines={1}>
          {picked}
        </Text>
      ) : null}
    </View>
  )
}

export interface TranscriptTailState {
  label: string
  tone: 'working' | 'attention' | 'idle'
  since?: string
}

function elapsedSince(since: string | undefined, now: number): string | null {
  if (!since) return null
  const start = Date.parse(since)
  if (Number.isNaN(start)) return null
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function TranscriptTail({ state }: { state?: TranscriptTailState }) {
  const [now, setNow] = useState(Date.now())
  const tone = state?.tone
  const since = state?.since
  useEffect(() => {
    if (!since) return
    // The heartbeat pauses while the app is not on screen — the same fix the
    // web transcript made for its hidden-tab heartbeat. A working tail ticks
    // every second; ticking a backgrounded surface spends renderer work on a
    // number nobody can see. On return the first tick catches the clock up
    // before the interval resumes.
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer !== null) return
      setNow(Date.now())
      timer = setInterval(() => setNow(Date.now()), tone === 'working' ? 1000 : 20_000)
    }
    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') start()
    const subscription = AppState.addEventListener('change', (next) =>
      next === 'active' ? start() : stop(),
    )
    return () => {
      stop()
      subscription.remove()
    }
  }, [since, tone])

  if (!state) return null
  const elapsed = elapsedSince(state.since, now)
  return (
    <View style={styles.tailWrap}>
      <View style={styles.tail} accessibilityRole="text">
        {/* The end of the feed is the one surface a reader watches while
            nothing else moves, so "working" is the moving mark here rather
            than the static ⠿ cell it used to be — the same swap the web tail
            made. The label beside it already says the state, so the mark is
            decorative. */}
        {state.tone === 'working' ? (
          <WorkingMark size={18} label={null} />
        ) : (
          <Text style={[styles.tailMark, state.tone === 'attention' && styles.tailAttention]}>
            ●
          </Text>
        )}
        <Text style={styles.tailLabel}>{state.label}</Text>
        {elapsed ? <Text style={styles.tailElapsed}>{elapsed}</Text> : null}
        <View style={styles.tailRule} />
      </View>
    </View>
  )
}

function FeedRowFrame({
  row,
  arrived,
  highlighted,
  dimmed,
  reduceMotion,
  children,
}: {
  row: Row
  arrived: boolean
  highlighted: boolean
  dimmed: boolean
  reduceMotion: boolean
  children: React.ReactNode
}) {
  const entrance = useRef(new Animated.Value(arrived && !reduceMotion ? 0 : 1)).current
  useEffect(() => {
    if (!arrived || reduceMotion) return
    Animated.timing(entrance, { toValue: 1, duration: 220, useNativeDriver: true }).start()
  }, [arrived, entrance, reduceMotion])
  return (
    <Animated.View
      style={[
        styles.feedRow,
        row.turn === 'open'
          ? styles.turnOpen
          : row.turn === 'bind'
            ? styles.turnBind
            : styles.turnBeat,
        highlighted && styles.searchHit,
        dimmed && styles.searchDim,
        {
          opacity: entrance,
          transform: [
            { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [7, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  )
}

function HoldableMessage({
  text,
  onHold,
  children,
}: {
  text: string
  onHold: (text: string) => void
  children: React.ReactNode
}) {
  return (
    <Pressable
      accessibilityActions={[
        { name: 'copy', label: 'Copy message' },
        { name: 'quote', label: 'Quote in reply' },
      ]}
      onAccessibilityAction={() => onHold(text)}
      onLongPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
        onHold(text)
      }}
      delayLongPress={350}
    >
      {children}
    </Pressable>
  )
}

function StreamingCaret({ reduceMotion }: { reduceMotion: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (reduceMotion) return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 520, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 520, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [opacity, reduceMotion])
  return <Animated.Text style={[styles.streamingCaret, { opacity }]}>▋</Animated.Text>
}

interface TranscriptFeedRowProps {
  row: Row
  arrived: boolean
  highlighted: boolean
  dimmed: boolean
  reduceMotion: boolean
  liveQuestion: boolean
  streaming: boolean
  assetContext?: TranscriptAssetContext
  onAnswer: (answer: AskQuestionAnswer) => Promise<void>
  onRefPress?: (ref: string) => void
  onRetryPending?: (turn: PendingTurn) => void
  onRetractPending?: (id: string) => void
  onHold: (text: string) => void
}

function sameAssetContext(
  previous: TranscriptAssetContext | undefined,
  next: TranscriptAssetContext | undefined,
): boolean {
  return (
    previous === next ||
    (previous !== undefined &&
      next !== undefined &&
      previous.httpOrigin === next.httpOrigin &&
      previous.sessionId === next.sessionId &&
      previous.cwd === next.cwd)
  )
}

function sameRow(previous: Row, next: Row): boolean {
  if (previous === next) return true
  if (previous.key !== next.key || previous.kind !== next.kind || previous.turn !== next.turn)
    return false
  if (previous.kind === 'pending' || next.kind === 'pending') {
    return (
      previous.kind === 'pending' &&
      next.kind === 'pending' &&
      previous.pendingTurn === next.pendingTurn
    )
  }
  if (previous.item !== next.item) return false
  const previousBlocks = previous.blocks
  const nextBlocks = next.blocks
  if (previousBlocks === nextBlocks) return true
  if (!previousBlocks || !nextBlocks || previousBlocks.length !== nextBlocks.length) return false
  return previousBlocks.every(
    (block, index) =>
      block.item === nextBlocks[index]?.item && block.result === nextBlocks[index]?.result,
  )
}

const TranscriptFeedRow = memo(
  function TranscriptFeedRow({
    row,
    arrived,
    highlighted,
    dimmed,
    reduceMotion,
    liveQuestion,
    streaming,
    assetContext,
    onAnswer,
    onRefPress,
    onRetryPending,
    onRetractPending,
    onHold,
  }: TranscriptFeedRowProps) {
    const message = (text: string, child: ReactNode) => (
      <HoldableMessage text={text} onHold={onHold}>
        {child}
      </HoldableMessage>
    )

    let content: ReactNode
    switch (row.kind) {
      case 'user': {
        const time = shortTime(row.item.ts)
        content = message(
          row.item.text,
          <View style={styles.userWrap}>
            <View style={styles.userCard}>
              <MessageText
                text={row.item.text.trim()}
                style={styles.userText}
                onRefPress={onRefPress}
              />
              <SharedFiles item={row.item} context={assetContext} showHeader={false} />
            </View>
            {time ? <Text style={styles.userMetaOutside}>{time}</Text> : null}
          </View>,
        )
        break
      }
      case 'pending': {
        const turn = row.pendingTurn
        const failed = turn.failed
        content = (
          <View style={styles.userWrap}>
            <View
              style={[styles.userCard, failed ? styles.userCardFailed : styles.userCardPending]}
            >
              <MessageText text={row.pendingText} style={styles.userText} onRefPress={onRefPress} />
              <PendingFiles files={turn.files ?? []} />
              {failed ? (
                <>
                  <Text style={styles.pendingError}>{failed}</Text>
                  {onRetryPending ? (
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel="Send this message again"
                      onPress={() => onRetryPending(turn)}
                      hitSlop={8}
                      style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
                    >
                      <Text style={styles.retryText}>Try again</Text>
                    </PressableScale>
                  ) : null}
                </>
              ) : turn.queuedId && onRetractPending ? (
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel="Retract this queued message"
                  onPress={() => onRetractPending(turn.queuedId as string)}
                  hitSlop={8}
                  style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
                >
                  <Text style={styles.retryText}>Retract</Text>
                </PressableScale>
              ) : null}
            </View>
            <Text style={[styles.userMetaOutside, failed && styles.userTimeFailed]}>
              {failed
                ? 'not sent'
                : turn.interrupted
                  ? 'interrupted'
                  : turn.queued
                    ? 'waiting its turn'
                    : 'sending…'}
            </Text>
          </View>
        )
        break
      }
      case 'question':
        content = <AskQuestionCard item={row.item} live={liveQuestion} onAnswer={onAnswer} />
        break
      case 'receipt':
        content = <AskReceipt item={row.item} />
        break
      case 'tools':
        content = <ToolsRun blocks={row.blocks ?? []} />
        break
      case 'shared':
        content = <SharedFiles item={row.item} context={assetContext} />
        break
      case 'envelope':
        content = row.envelope
          ? message(
              row.envelope.body,
              <EnvelopeRow envelope={row.envelope} onRefPress={onRefPress} />,
            )
          : null
        break
      case 'context':
        content = <MachineContextDisclosure item={row.item} />
        break
      case 'recap': {
        const time = shortTime(row.item.ts)
        content = message(
          row.item.text,
          <View style={styles.recap}>
            <View style={styles.answerLabelRow}>
              <Text style={styles.answerLabel}>Recap</Text>
              {time ? <Text style={styles.answerMeta}>{time}</Text> : null}
            </View>
            <MessageText
              text={row.item.text.trim()}
              style={styles.proseText}
              onRefPress={onRefPress}
            />
          </View>,
        )
        break
      }
      case 'quiet':
        content = (
          <Text style={styles.quiet} numberOfLines={2}>
            {row.quietText}
          </Text>
        )
        break
      case 'answer': {
        const time = shortTime(row.item.ts)
        content = message(
          row.item.text,
          <>
            <View style={styles.answer}>
              <View style={styles.answerLabelRow}>
                <Text style={styles.answerLabel}>Answer</Text>
                {time ? <Text style={styles.answerMeta}>{time}</Text> : null}
              </View>
              <MessageText
                text={row.item.text.trim()}
                style={styles.proseText}
                onRefPress={onRefPress}
              />
              {streaming ? <StreamingCaret reduceMotion={reduceMotion} /> : null}
            </View>
            <SharedFiles item={row.item} context={assetContext} showHeader={false} />
          </>,
        )
        break
      }
      default:
        content = message(
          row.item.text,
          <>
            <MessageText
              text={row.item.text.trim()}
              style={styles.proseText}
              onRefPress={onRefPress}
            />
            {streaming ? <StreamingCaret reduceMotion={reduceMotion} /> : null}
            <SharedFiles item={row.item} context={assetContext} showHeader={false} />
          </>,
        )
    }

    return (
      <FeedRowFrame
        row={row}
        arrived={arrived}
        highlighted={highlighted}
        dimmed={dimmed}
        reduceMotion={reduceMotion}
      >
        {content}
      </FeedRowFrame>
    )
  },
  (previous, next) =>
    sameRow(previous.row, next.row) &&
    previous.arrived === next.arrived &&
    previous.highlighted === next.highlighted &&
    previous.dimmed === next.dimmed &&
    previous.reduceMotion === next.reduceMotion &&
    previous.liveQuestion === next.liveQuestion &&
    previous.streaming === next.streaming &&
    sameAssetContext(previous.assetContext, next.assetContext) &&
    previous.onAnswer === next.onAnswer &&
    previous.onRefPress === next.onRefPress &&
    previous.onRetryPending === next.onRetryPending &&
    previous.onRetractPending === next.onRetractPending &&
    previous.onHold === next.onHold,
)

/**
 * Jump-to-newest, floating ABOVE the prompt box (POD-724).
 *
 * It used to sit `space.sm` off the bottom of the list frame — the same band
 * the composer capsule floats in, as a sibling layer over the same area — so
 * the one control that says "you are behind the conversation" was rendered
 * BEHIND the composer. It is now lifted by the composer's own resting height:
 * the value the feed already pays as bottom padding, plus a gap. With no
 * composer (a read-only transcript) the lift is zero and the pill rests near
 * the bottom edge, where it always did.
 *
 * It also carries what arrived while you were away, because "Newest" answers
 * where the button goes and not whether it is worth pressing.
 */
function JumpToNewest({
  visible,
  unread,
  lift,
  reduceMotion,
  onPress,
}: {
  visible: boolean
  unread: number
  lift: number
  reduceMotion: boolean
  onPress: () => void
}) {
  const [mounted, setMounted] = useState(visible)
  const enter = useRef(new Animated.Value(visible ? 1 : 0)).current

  useEffect(() => {
    if (visible) setMounted(true)
    // Reduce Motion still gets the control, immediately — the appearance is
    // information, only its travel is decoration.
    if (reduceMotion) {
      enter.setValue(visible ? 1 : 0)
      if (!visible) setMounted(false)
      return
    }
    const animation = Animated.spring(enter, {
      toValue: visible ? 1 : 0,
      ...spring.snappy,
      useNativeDriver: true,
    })
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false)
    })
    return () => animation.stop()
  }, [enter, reduceMotion, visible])

  if (!mounted) return null
  return (
    <Animated.View
      pointerEvents={visible ? 'box-none' : 'none'}
      style={[
        styles.newestLayer,
        {
          bottom: lift,
          opacity: enter,
          transform: [
            { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          ],
        },
      ]}
    >
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={
          unread > 0 ? `Jump to ${unread} new messages` : 'Jump to newest message'
        }
        onPress={onPress}
        hitSlop={8}
        // The one control here that is genuinely ABOVE the page rather than
        // carved into it, so it takes the card shadow — a bordered capsule on
        // its own reads as another row that happens to be centred.
        style={({ pressed }) => [styles.newest, elevation.card, pressed && styles.utilityPressed]}
      >
        <Icon as={ChevronDown} size={14} color={color.text} />
        <Text style={styles.newestText}>{unread > 0 ? `${unread} new` : 'Newest'}</Text>
      </PressableScale>
    </Animated.View>
  )
}

export function TranscriptList({
  items,
  liveItem,
  live,
  onAnswer,
  onLoadOlder,
  onRefPress,
  assetContext,
  collapseContext = false,
  pendingTurns,
  pendingAsk,
  onRetryPending,
  onRetractPending,
  onQuote,
  tail,
  streaming = false,
  refreshControl,
  refreshAccessibilityProps,
  emptyComponent,
  footer,
  bottomInset = 0,
  hidePendingQuestion = false,
  findRequest = 0,
  pinRequest = 0,
}: {
  items: TranscriptItem[]
  /** In-progress assistant prose, kept outside the stable settled item array. */
  liveItem?: TranscriptItem
  live: boolean
  onAnswer: (answer: AskQuestionAnswer) => Promise<void>
  /** Called when the user scrolls back to the oldest loaded item (paging). */
  onLoadOlder?: () => void
  /** Tap handler for POD-refs in message text (opens the task peek sheet). */
  onRefPress?: (ref: string) => void
  /** Session-scoped server route context for transferred files and image previews. */
  assetContext?: TranscriptAssetContext
  /** Collapse machine-authored headless context blocks behind a disclosure row. */
  collapseContext?: boolean
  /** Turns sent but not yet echoed by the server, appended at the tail. */
  pendingTurns?: readonly PendingTurn[]
  /**
   * A live question the transcript does not carry yet, drawn from agent state
   * (`pendingAskFromState`) and rendered at the end of the feed — where the
   * transcript's own item will land once Claude Code resolves the call. Passing
   * it is how the phone can answer a question during the whole window the
   * transcript is silent about it (POD-1273).
   */
  pendingAsk?: TranscriptItem | null
  /** Send a rejected turn again (only failed rows expose the affordance). */
  onRetryPending?: (turn: PendingTurn) => void
  /** Retract a durable message before the agent begins its turn. */
  onRetractPending?: (id: string) => void
  /** Insert quoted markdown into the screen's composer. */
  onQuote?: (markdown: string) => void
  /** Live/idle state rendered as the transcript's final line. */
  tail?: TranscriptTailState
  /** The latest assistant row is actively receiving text, not merely a live session. */
  streaming?: boolean
  /** Native pull control; web uses the pointer boundary around this list. */
  refreshControl?: ReactElement<RefreshControlProps>
  refreshAccessibilityProps?: RefreshAccessibilityProps
  emptyComponent?: ReactElement
  /** Session-owned actions rendered after the tail, inside the scroller rather
   *  than as a persistent bottom accessory. */
  footer?: ReactNode
  /**
   * Room to leave at the end of the feed for chrome that floats OVER it — the
   * composer. Without it the last row rests under the capsule forever.
   */
  bottomInset?: number
  /** Keep the active ask out of the feed when screen chrome renders its band. */
  hidePendingQuestion?: boolean
  /** Incremented by header/menu chrome to reveal the find bar. */
  findRequest?: number
  /**
   * Incremented by the screen when the OPERATOR SENDS from it. A send is a
   * statement of intent about the tail — the message just written must be
   * visible even if the reader had scrolled up — so each bump re-pins the feed
   * to its newest row, exactly as the web chat's send calls `pinToBottom`.
   */
  pinRequest?: number
}) {
  const reduceMotion = useReduceMotion()
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [actionText, setActionText] = useState<string | null>(null)
  const [atTail, setAtTail] = useState(true)
  /** Rows that arrived while the operator was reading further up. */
  const [unread, setUnread] = useState(0)
  const answerRef = useRef(onAnswer)
  const refPressRef = useRef(onRefPress)
  const retryPendingRef = useRef(onRetryPending)
  const retractPendingRef = useRef(onRetractPending)
  // Memoized rows need stable wrappers, but their targets must advance only
  // after React commits. Render-time writes can leak handlers from a suspended
  // or abandoned concurrent render into the still-visible previous tree.
  useLayoutEffect(() => {
    answerRef.current = onAnswer
    refPressRef.current = onRefPress
    retryPendingRef.current = onRetryPending
    retractPendingRef.current = onRetractPending
  }, [onAnswer, onRefPress, onRetractPending, onRetryPending])
  const answerRow = useCallback((answer: AskQuestionAnswer) => answerRef.current(answer), [])
  const pressRowRef = useCallback((ref: string) => refPressRef.current?.(ref), [])
  const retryPendingRow = useCallback((turn: PendingTurn) => retryPendingRef.current?.(turn), [])
  const retractPendingRow = useCallback((id: string) => retractPendingRef.current?.(id), [])

  const model = useMemo(
    () => buildMobileTranscript(items, { collapseContext }),
    [collapseContext, items],
  )
  const liveRow = useMemo(
    () => liveAssistantRow(liveItem, model.blocks.length),
    [liveItem, model.blocks.length],
  )
  const pending = useMemo(() => latestPendingQuestion(items), [items])
  const pendingKey = pending ? transcriptItemKey(pending) : null
  const statePendingKey = pendingAsk ? transcriptItemKey(pendingAsk) : null
  const visibleModel = useMemo(
    () =>
      hidePendingQuestion
        ? {
            ...model,
            rows: model.rows.filter((row) => row.kind !== 'question' || row.key !== pendingKey),
          }
        : model,
    [hidePendingQuestion, model, pendingKey],
  )
  // The settled rows remain FlatList's stable data while transport text changes.
  // Tail-only rows are a bounded suffix rendered in the footer, in the same
  // order they had when all rows shared one array.
  const suffixRows = useMemo(() => {
    const built: Row[] = liveRow ? [liveRow] : []
    for (const turn of pendingTurns ?? []) {
      built.push({
        key: `pending:${turn.id}`,
        kind: 'pending',
        item: {
          id: turn.id,
          role: 'user',
          text: turn.text,
          ...(turn.files && turn.files.length > 0
            ? { toolPaths: turn.files.map((file) => file.path) }
            : {}),
        } as TranscriptItem,
        blockIndices: [],
        turn: 'open',
        pendingText: turn.text,
        pendingTurn: turn,
      })
    }
    // The question Claude Code has not written down yet, after the optimistic
    // turns because that is where its own item will arrive. It leaves on answer,
    // when the session drops out of `needs_user` and the caller stops passing it.
    if (pendingAsk && !hidePendingQuestion) {
      built.push({
        key: transcriptItemKey(pendingAsk),
        kind: 'question',
        item: pendingAsk,
        blockIndices: [],
        turn: 'open',
      })
    }
    return built
  }, [hidePendingQuestion, liveRow, pendingAsk, pendingTurns])
  const rows = visibleModel.rows
  const search = useMemo(
    () => searchMobileTranscript(visibleModel, findOpen ? query : '', cursor),
    [cursor, findOpen, query, visibleModel],
  )
  const listRef = useRef<FlatList<Row>>(null)
  const seenKeys = useRef<Set<string> | null>(null)
  const previousKeys = useRef<string[]>([])
  const seenSuffixKeys = useRef(new Set<string>())
  const suffixCommitted = useRef(false)
  const lastFindRequest = useRef(findRequest)

  useEffect(() => {
    if (findRequest === lastFindRequest.current) return
    lastFindRequest.current = findRequest
    setFindOpen(true)
  }, [findRequest])
  const arrivedKeys = useMemo(() => {
    const ordered = rows.map((row) => row.key)
    const keys = new Set(ordered)
    if (seenKeys.current === null) {
      seenKeys.current = keys
      previousKeys.current = ordered
      return new Set<string>()
    }
    if (previousKeys.current.length === 0) {
      for (const key of keys) seenKeys.current.add(key)
      previousKeys.current = ordered
      return new Set<string>()
    }

    const arrived = appendedTranscriptArrivals(previousKeys.current, seenKeys.current, ordered)
    for (const key of keys) seenKeys.current.add(key)
    previousKeys.current = ordered
    return arrived
  }, [rows])
  const suffixArrivedKeys = useMemo(() => {
    const keys = suffixRows.map((row) => row.key)
    return suffixCommitted.current
      ? new Set(keys.filter((key) => !seenSuffixKeys.current.has(key)))
      : new Set<string>()
  }, [suffixRows])
  useLayoutEffect(() => {
    suffixCommitted.current = true
    for (const row of suffixRows) seenSuffixKeys.current.add(row.key)
  }, [suffixRows])
  const latestAssistantKey = useMemo(
    () => [...rows].reverse().find((row) => row.kind === 'prose' || row.kind === 'answer')?.key,
    [rows],
  )
  // Chronological (not inverted). Bottom-pinning is done by hand: scrollToEnd
  // on growth while the user sits at the tail.
  //
  // `pinned` is a MEASUREMENT and `operatorMoved` is an INTENT, and the split is
  // what makes opening at the newest message deterministic (POD-724). The
  // measurement cannot be trusted while the transcript is still laying out:
  // content height climbs for several frames as markdown, images and tool rows
  // resolve, and each settling scroll reported on the way reads as "not at the
  // bottom". So until a real gesture moves the feed, every content-size change
  // goes back to the end no matter what the measurement currently says. After a
  // gesture the measurement is the whole answer — a reader who scrolled up to
  // find something must never be yanked back down. See ../lib/transcript-tail.
  const pinned = useRef(true)
  const operatorMoved = useRef(false)
  // Last measured content height. Used to ignore the echo the pin sends back
  // through onContentSizeChange — that loop froze the phone for minutes.
  const contentHeight = useRef(0)
  // The feed's own height, from its onLayout. The pin subtracts it rather than
  // asking the list where its end is (POD-1251).
  const viewportHeight = useRef(0)
  // A different session is a different conversation, and it opens at ITS tail
  // even if the previous one was left scrolled up.
  const transcriptId = assetContext?.sessionId ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: the transcript's identity is the trigger, not a value the reset reads.
  useEffect(() => {
    operatorMoved.current = false
    pinned.current = true
    contentHeight.current = 0
    setAtTail(true)
    setUnread(0)
  }, [transcriptId])

  const markOperatorMoved = useCallback(() => {
    operatorMoved.current = true
  }, [])

  /**
   * Back to the tail as an INTENT, not just a scroll: the same regime the
   * transcript opens in. Clearing `operatorMoved` matters as much as the scroll
   * itself — while the travel animates (and while streaming keeps growing the
   * content under it), every settling frame measures as "not at the bottom",
   * and leaving the gesture flag up would let those frames drop the pin the
   * press just declared. With the flag down, growth re-anchors until the
   * operator's next real gesture.
   */
  const pinToNewest = useCallback((animated: boolean) => {
    operatorMoved.current = false
    pinned.current = true
    setAtTail(true)
    setUnread(0)
    const jump = newestJump(contentHeight.current, viewportHeight.current, !animated)
    listRef.current?.scrollToOffset(jump)
  }, [])

  const lastPinRequest = useRef(pinRequest)
  useEffect(() => {
    if (pinRequest === lastPinRequest.current) return
    lastPinRequest.current = pinRequest
    // A send re-pins without travel: the optimistic row is about to grow the
    // content, and the follow-on growth pin lands the exact final offset.
    pinToNewest(false)
  }, [pinRequest, pinToNewest])

  // What landed while the operator was reading further up. `arrivedKeys` is
  // already derived for the row entrance, so the count costs nothing extra.
  useEffect(() => {
    if (atTail) {
      setUnread(0)
      return
    }
    const arrivals = arrivedKeys.size + suffixArrivedKeys.size
    if (arrivals > 0) setUnread((count) => count + arrivals)
  }, [arrivedKeys, atTail, suffixArrivedKeys])

  useEffect(() => {
    if (search.activeRow === undefined) return
    // Jumping to a match IS the operator moving the feed. Without this the
    // opening pin outlives the jump and every page the search loads snaps the
    // reader back to the tail (POD-724).
    operatorMoved.current = true
    listRef.current?.scrollToIndex({
      index: search.activeRow,
      animated: !reduceMotion,
      viewPosition: 0.35,
    })
  }, [reduceMotion, search.activeRow])

  // biome-ignore lint/correctness/useExhaustiveDependencies: each newly loaded page should request the next one while a transcript search is deepening.
  useEffect(() => {
    if (!findOpen || !query.trim()) return
    onLoadOlder?.()
  }, [findOpen, items.length, onLoadOlder, query])

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
      const nextPinned = atTailRule({
        operatorMoved: operatorMoved.current,
        measuredAtTail: measureAtTail(
          contentOffset.y,
          layoutMeasurement.height,
          contentSize.height,
        ),
      })
      if (nextPinned !== pinned.current) {
        pinned.current = nextPinned
        setAtTail(nextPinned)
      }
      if (contentOffset.y < 200) onLoadOlder?.()
    },
    [onLoadOlder],
  )

  const messageActions = useMemo<SheetAction[]>(() => {
    if (!actionText) return []
    const actions: SheetAction[] = [
      {
        label: 'Copy text',
        onPress: () => {
          void Clipboard.setStringAsync(actionText)
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
        },
      },
    ]
    if (onQuote) {
      actions.push({
        label: 'Quote in reply',
        onPress: () => onQuote(quoteTranscriptText(actionText)),
      })
    }
    return actions
  }, [actionText, onQuote])

  return (
    <View style={styles.listFrame}>
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={[styles.content, { paddingBottom: space.md + bottomInset }]}
        refreshControl={refreshControl}
        {...refreshAccessibilityProps}
        ListEmptyComponent={suffixRows.length === 0 ? emptyComponent : undefined}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        // The iOS chat convention: dragging the transcript down slides the
        // keyboard away with the finger (Messages, Mail, Slack). Android and
        // web get the discrete on-drag dismissal. `handled` keeps a tap on a
        // message/ref chip from being swallowed by keyboard dismissal while
        // typing — taps outside interactive children still dismiss.
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        // Four ways to learn that the OPERATOR moved, because no single one
        // covers both targets: native fires the drag/momentum pair, and
        // react-native-web's ScrollView forwards only touch and wheel — which
        // is the phone web app, so a missing wheel handler would let a settling
        // scroll speak for the reader on the surface that actually ships.
        // `onTouchMove` rather than `onTouchStart`: tapping a ref chip is not
        // leaving the tail.
        onScrollBeginDrag={markOperatorMoved}
        onMomentumScrollBegin={markOperatorMoved}
        onTouchMove={markOperatorMoved}
        {...({ onWheel: markOperatorMoved } as object)}
        scrollEventThrottle={32}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          listRef.current?.scrollToOffset({
            offset: Math.max(0, index * averageItemLength),
            animated: false,
          })
        }}
        onLayout={(event) => {
          viewportHeight.current = event.nativeEvent.layout.height
        }}
        onContentSizeChange={(_width, height) => {
          const previous = contentHeight.current
          contentHeight.current = height
          if (
            shouldFollowContentGrowth({
              previousHeight: previous,
              nextHeight: height,
              pinning: !operatorMoved.current || pinned.current,
            })
          ) {
            // scrollToOffset, NOT scrollToEnd: the end this list computes for
            // itself is 0 until a cell has been measured, which is exactly the
            // frame the opening pin runs in. See `tailOffset`.
            listRef.current?.scrollToOffset({
              offset: tailOffset(height, viewportHeight.current),
              animated: false,
            })
          }
        }}
        ListFooterComponent={
          <>
            {suffixRows.map((row) => (
              <TranscriptFeedRow
                key={row.key}
                row={row}
                arrived={suffixArrivedKeys.has(row.key)}
                highlighted={false}
                dimmed={query.trim().length > 0}
                reduceMotion={reduceMotion}
                liveQuestion={
                  statePendingKey === row.key ||
                  (live && pendingKey !== null && pendingKey === row.key)
                }
                streaming={streaming && row.key === liveRow?.key}
                assetContext={assetContext}
                onAnswer={answerRow}
                onRefPress={onRefPress ? pressRowRef : undefined}
                onRetryPending={onRetryPending ? retryPendingRow : undefined}
                onRetractPending={onRetractPending ? retractPendingRow : undefined}
                onHold={setActionText}
              />
            ))}
            <TranscriptTail state={tail} />
            {footer ? <View style={styles.footer}>{footer}</View> : null}
          </>
        }
        renderItem={({ item: row, index }) => (
          <TranscriptFeedRow
            row={row}
            arrived={arrivedKeys.has(row.key)}
            highlighted={search.activeRow === index}
            dimmed={query.trim().length > 0 && !search.matchingRows.has(index)}
            reduceMotion={reduceMotion}
            liveQuestion={
              statePendingKey === row.key || (live && pendingKey !== null && pendingKey === row.key)
            }
            streaming={streaming && liveRow === undefined && row.key === latestAssistantKey}
            assetContext={assetContext}
            onAnswer={answerRow}
            onRefPress={onRefPress ? pressRowRef : undefined}
            onRetryPending={onRetryPending ? retryPendingRow : undefined}
            onRetractPending={onRetractPending ? retractPendingRow : undefined}
            onHold={setActionText}
          />
        )}
      />

      {findOpen ? (
        <View style={styles.findBar}>
          <TextInput
            autoFocus
            accessibilityLabel="Find in transcript"
            value={query}
            onChangeText={(value) => {
              setQuery(value)
              setCursor(0)
            }}
            placeholder="Find in transcript…"
            placeholderTextColor={color.textFaint}
            style={styles.findInput}
            returnKeyType="search"
            onSubmitEditing={() => search.total > 0 && setCursor((value) => value + 1)}
          />
          <Text style={styles.findCount}>
            {query.trim() ? (search.total ? `${search.position}/${search.total}` : 'none') : ''}
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Previous match"
            disabled={search.total === 0}
            onPress={() => setCursor((value) => value - 1)}
            style={styles.findButton}
          >
            <Icon as={ChevronUp} size={15} color={color.textDim} />
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Next match"
            disabled={search.total === 0}
            onPress={() => setCursor((value) => value + 1)}
            style={styles.findButton}
          >
            <Icon as={ChevronDown} size={15} color={color.textDim} />
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Close transcript search"
            onPress={() => {
              setFindOpen(false)
              setQuery('')
            }}
            style={styles.findButton}
          >
            <Icon as={X} size={15} color={color.textDim} />
          </PressableScale>
        </View>
      ) : null}

      <JumpToNewest
        visible={!atTail}
        unread={unread}
        lift={bottomInset + space.md}
        reduceMotion={reduceMotion}
        // NOT scrollToEnd: without getItemLayout its end is approximated from
        // average cell lengths and omits the content container's paddingBottom
        // (the composer's room), so it reliably stopped short of the last
        // message. `pinToNewest` aims at the height the list itself reported.
        onPress={() => pinToNewest(!reduceMotion)}
      />

      <ActionSheet
        visible={actionText !== null}
        title="Message"
        actions={messageActions}
        onClose={() => setActionText(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  listFrame: {
    flex: 1,
    minHeight: 0,
    backgroundColor: color.engraved,
  },
  footer: {
    marginTop: space.xs,
    marginBottom: space.sm,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.md,
    // A short conversation rests on the composer instead of hanging from the
    // header — the desktop chat's bottom-anchored feel (POD-338).
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  rowWrap: {
    marginBottom: space.lg,
  },
  feedRow: {
    minWidth: 0,
  },
  turnOpen: {
    marginTop: space.lg,
    marginBottom: space.md,
  },
  turnBeat: {
    marginBottom: space.lg,
  },
  turnBind: {
    marginTop: -space.xs,
    marginBottom: space.sm,
  },
  searchHit: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.accentBorder,
    backgroundColor: color.accentSoft,
  },
  searchDim: {
    opacity: 0.28,
  },
  envelope: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.border,
    borderLeftWidth: 3,
    borderLeftColor: color.info,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  envelopeHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  envelopeKind: { ...monoLabel(font.micro), color: color.info },
  envelopeRoute: {
    ...sans(500),
    flex: 1,
    minWidth: 130,
    color: color.textDim,
    fontSize: font.tiny,
  },
  envelopeRef: { color: color.accentTint, textDecorationLine: 'underline' },
  envelopeQuestion: {
    ...monoLabel(),
    color: color.accentTint,
    backgroundColor: color.accentSoft,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.xs,
  },
  envelopeReply: {
    ...monoLabel(),
    color: color.info,
    backgroundColor: color.workingSoft,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.xs,
  },
  envelopeId: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
    marginTop: 3,
  },
  envelopeBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    marginTop: space.sm,
    paddingTop: space.xs,
  },
  envelopeMachine: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
    lineHeight: leading(font.micro),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    marginTop: space.sm,
    paddingTop: space.xs,
  },
  contextToggle: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 4,
  },
  contextPressed: {
    opacity: 0.6,
  },
  contextGlyph: {
    ...mono(400),
    width: 12,
    color: color.textMicro,
    fontSize: 10,
  },
  contextLabel: {
    ...sans(600),
    color: color.text,
    fontSize: font.tiny,
  },
  contextScroll: {
    maxHeight: 280,
    marginTop: 4,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.bg,
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.sm,
  },
  contextBody: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  // Operator turn — the ONLY elevated surface on the field.
  userWrap: {
    alignItems: 'flex-end',
    gap: 4,
    paddingVertical: space.xs,
    backgroundColor: color.engraved,
  },
  userCard: {
    maxWidth: '80%',
    backgroundColor: color.surfaceHigh,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 5,
    borderBottomLeftRadius: 14,
    paddingHorizontal: space.lg - 1,
    paddingVertical: space.sm + 2,
  },
  userCardPending: {
    opacity: 0.7,
    borderStyle: 'dashed',
  },
  userCardFailed: {
    borderColor: color.danger,
  },
  pendingError: {
    ...mono(400),
    marginTop: space.sm,
    color: color.dangerText,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  retry: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.danger,
  },
  retryPressed: {
    opacity: 0.6,
  },
  retryText: {
    ...sans(700),
    color: color.dangerText,
    fontSize: font.tiny,
  },
  userMetaOutside: {
    ...mono(400),
    paddingRight: 2,
    color: color.textMicro,
    fontSize: font.micro,
  },
  userTimeFailed: {
    ...mono(700),
    color: color.dangerText,
  },
  userText: {
    ...sans(500),
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
  },
  // Agent prose — flat on the chassis, no bubble.
  proseText: {
    ...sans(400),
    color: color.body,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
  },
  // Tool run — a surfaced 34px fold control; details stay quiet beneath it.
  tools: {
    gap: 4,
  },
  workLine: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  workLinePressed: {
    backgroundColor: color.elevated,
  },
  workDisclosure: {
    ...mono(500),
    width: 12,
    color: color.textMicro,
    fontSize: font.tiny,
  },
  workDisclosureFailed: {
    color: color.dangerText,
  },
  workTitle: {
    ...mono(500),
    flex: 1,
    color: color.textDim,
    fontSize: font.tiny,
  },
  workCount: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
  },
  trow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm + 1,
    minWidth: 0,
  },
  toolGlyph: {
    ...mono(400),
    width: 12,
    textAlign: 'center',
    color: color.textMicro,
    fontSize: font.tiny,
  },
  toolGlyphOk: {
    color: color.successText,
  },
  toolGlyphErr: {
    color: color.dangerText,
  },
  toolName: {
    ...mono(500),
    color: color.textDim,
    fontSize: font.tiny,
  },
  toolDesc: {
    ...mono(400),
    flex: 1,
    color: color.textFaint,
    fontSize: font.tiny,
  },
  toolMag: {
    ...mono(400),
    marginLeft: 'auto',
    color: color.textMicro,
    fontSize: font.tiny,
  },
  toolFail: {
    ...mono(400),
    marginLeft: 21,
    marginTop: 1,
    paddingLeft: space.sm + 1,
    borderLeftWidth: 2,
    borderLeftColor: color.hairline,
    color: color.textMicro,
    fontSize: font.tiny,
  },
  toolPreview: {
    ...mono(400),
    marginLeft: 21,
    marginTop: 1,
    paddingLeft: space.sm + 1,
    borderLeftWidth: 2,
    borderLeftColor: color.hairline,
    color: color.textMicro,
    fontSize: font.micro,
  },
  toolsMore: {
    ...mono(400),
    paddingLeft: 21,
    color: color.textMicro,
    fontSize: font.tiny,
  },
  // System/interrupt/churn — quiet mono line.
  quiet: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.tiny,
  },
  recap: {
    borderTopWidth: 2,
    borderTopColor: color.accentBorder,
    paddingTop: space.md,
  },
  // Final answer — flat, marked by the page's only accent: a keyline.
  answer: {
    borderTopWidth: 2,
    borderTopColor: color.accentBorder,
    paddingTop: space.md,
  },
  answerLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: space.xs + 2,
  },
  answerLabel: {
    ...monoLabel(),
    color: color.accentTint,
  },
  answerMeta: {
    ...mono(400),
    marginLeft: 'auto',
    color: color.textMicro,
    fontSize: font.micro,
  },
  // Answered ask — one-line receipt.
  receipt: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm + 1,
  },
  receiptGlyph: {
    ...mono(500),
    color: color.textMicro,
    fontSize: font.small,
  },
  receiptQ: {
    ...sans(400),
    flexShrink: 1,
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  receiptPick: {
    ...sans(500),
    color: color.body,
    fontSize: font.tiny,
    borderColor: color.hairline,
    borderWidth: 1,
    borderRadius: radius.xs,
    paddingHorizontal: 7,
    paddingVertical: 1,
    overflow: 'hidden',
    maxWidth: '40%',
  },
  streamingCaret: {
    ...mono(700),
    color: color.accentTint,
    fontSize: font.small,
    marginTop: 2,
  },
  tailWrap: {
    gap: space.md,
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  tail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 28,
  },
  tailMark: {
    ...mono(500),
    color: color.textMicro,
    fontSize: font.tiny,
  },
  tailAttention: {
    color: color.needsYouText,
  },
  tailLabel: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.tiny,
  },
  tailElapsed: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
  },
  tailRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  utilityPressed: {
    opacity: 0.55,
  },
  findBar: {
    position: 'absolute',
    top: space.sm,
    left: space.sm,
    right: space.sm,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.surfaceHigh,
    paddingLeft: space.md,
    paddingRight: 2,
  },
  findInput: {
    ...sans(400),
    flex: 1,
    minWidth: 0,
    color: color.text,
    // Mobile Safari zooms focused form controls below 16px. The body/input
    // token stays above that threshold without disabling user page zoom.
    fontSize: font.body,
    paddingVertical: 0,
  },
  findCount: {
    ...mono(400),
    minWidth: 34,
    textAlign: 'right',
    color: color.textMicro,
    fontSize: font.micro,
  },
  findButton: {
    width: 32,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Full-width so the pill centres itself; `bottom` is set per render from the
   *  composer's measured height. `box-none` keeps the feed tappable around it. */
  newestLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  newest: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 38,
    paddingLeft: space.sm + 2,
    paddingRight: space.md,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.surfaceHigh,
  },
  newestText: {
    ...sans(600),
    color: color.text,
    fontSize: font.tiny,
  },
})
