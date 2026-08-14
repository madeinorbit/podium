import { CHAT_VERBOSITY_KEY } from '@podium/client-core/ui-state'
import {
  type ChatBlock,
  type ChatVerbosity,
  failLine,
  latestPendingQuestion,
  type ParsedEnvelope,
  parseChatVerbosity,
  resultPreview,
  toolBatchTitle,
  toolRunFailures,
  toolVerdict,
} from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react-native'
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  Animated,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  type RefreshControlProps,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useUiState } from '../client/hooks'
import { useReduceMotion } from '../hooks/useReduceMotion'
import type { RefreshAccessibilityProps } from '../hooks/useRefreshableTab'
import type { TranscriptAssetContext } from '../lib/transcript-assets'
import {
  appendedTranscriptArrivals,
  buildMobileTranscript,
  envelopePrincipal,
  isChosenOption,
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
  shouldFollowContentGrowth,
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
import { PressableScale } from './PressableScale'
import { RichMarkdown } from './RichMarkdown'
import { SharedFiles } from './SharedFiles'

/**
 * Flat Field rows (POD-159, adapted for mobile in POD-176): the agent's work
 * lies flat on the chassis; the operator's turns are the only elevated surface.
 * They do NOT stick to the top (POD-338) — a phone viewport is too short to
 * spend a permanent band on a message you already read. Tool runs are muted mono
 * one-liners with per-call ✓/✕ verdicts; the final answer gets the page's only
 * yellow (a keyline, not a box); an answered ask collapses to a one-line receipt.
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
  text: string
  /** Set when the send itself was REJECTED (POD-346). A rejected turn that
   *  keeps saying "sending…" is the worst possible outcome — the phone reads as
   *  broken and the words are lost. The row goes red, names the reason, and
   *  offers the send again. */
  failed?: string
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
        accessibilityState={{ expanded: open }}
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
 * A phone-native work line. Normal mode spends one line on the run and a tap
 * unfolds a useful result preview; verbose opens every call immediately.
 */
function ToolsRun({ blocks, verbose }: { blocks: ChatBlock[]; verbose: boolean }) {
  const [expanded, setExpanded] = useState(verbose)
  useEffect(() => setExpanded(verbose), [verbose])
  const failures = toolRunFailures(blocks)

  return (
    <View style={styles.tools}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} work run: ${toolBatchTitle(blocks)}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.workLine, pressed && styles.workLinePressed]}
      >
        <Text style={styles.workDisclosure}>{expanded ? '▾' : '▸'}</Text>
        <Text style={styles.workTitle} numberOfLines={1}>
          {toolBatchTitle(blocks)}
        </Text>
        <Text style={[styles.workCount, failures > 0 && styles.workCountFailed]}>
          {failures > 0 ? `${failures} failed` : `${blocks.length}`}
        </Text>
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
  useEffect(() => {
    if (!state?.since) return
    const timer = setInterval(() => setNow(Date.now()), state.tone === 'working' ? 1000 : 20_000)
    return () => clearInterval(timer)
  }, [state?.since, state?.tone])

  if (!state) return null
  const elapsed = elapsedSince(state.since, now)
  return (
    <View style={styles.tailWrap}>
      <View style={styles.tail} accessibilityRole="text">
        <Text
          style={[
            styles.tailMark,
            state.tone === 'working' && styles.tailWorking,
            state.tone === 'attention' && styles.tailAttention,
          ]}
        >
          {state.tone === 'working' ? '⠿' : '●'}
        </Text>
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
  live,
  onAnswer,
  onLoadOlder,
  onRefPress,
  assetContext,
  collapseContext = false,
  pendingTurns,
  onRetryPending,
  onQuote,
  tail,
  streaming = false,
  refreshControl,
  refreshAccessibilityProps,
  emptyComponent,
  footer,
  bottomInset = 0,
}: {
  items: TranscriptItem[]
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
  /** Send a rejected turn again (only failed rows expose the affordance). */
  onRetryPending?: (turn: PendingTurn) => void
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
}) {
  const reduceMotion = useReduceMotion()
  const uiState = useUiState()
  const storedVerbosity = useSyncExternalStore(
    (notify) => uiState.subscribe(notify),
    () => uiState.get(CHAT_VERBOSITY_KEY),
    () => null,
  )
  const verbosity = parseChatVerbosity(storedVerbosity)
  const [detailOpen, setDetailOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [actionText, setActionText] = useState<string | null>(null)
  const [atTail, setAtTail] = useState(true)
  /** Rows that arrived while the operator was reading further up. */
  const [unread, setUnread] = useState(0)

  const searching = findOpen && query.trim().length > 0

  const setVerbosity = useCallback(
    (value: ChatVerbosity) => uiState.set(CHAT_VERBOSITY_KEY, value === 'normal' ? null : value),
    [uiState],
  )

  const model = useMemo(
    () =>
      buildMobileTranscript(items, {
        collapseContext,
        verbosity,
        searching,
      }),
    [collapseContext, items, searching, verbosity],
  )
  const rows = useMemo(() => {
    const built: Row[] = [...model.rows]
    for (const turn of pendingTurns ?? []) {
      built.push({
        key: `pending:${turn.id}`,
        kind: 'pending',
        item: { id: turn.id, role: 'user', text: turn.text } as TranscriptItem,
        blockIndices: [],
        turn: 'open',
        pendingText: turn.text,
        pendingTurn: turn,
      })
    }
    return built
  }, [model.rows, pendingTurns])
  const search = useMemo(
    () => searchMobileTranscript(model, findOpen ? query : '', cursor),
    [cursor, findOpen, model, query],
  )
  const pending = useMemo(() => latestPendingQuestion(items), [items])
  const listRef = useRef<FlatList<Row>>(null)
  const seenKeys = useRef<Set<string> | null>(null)
  const previousKeys = useRef<string[]>([])
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
  // Last measured content height. Used to ignore the echo `scrollToEnd` sends
  // back through onContentSizeChange — that loop froze the phone for minutes.
  const contentHeight = useRef(0)
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

  // What landed while the operator was reading further up. `arrivedKeys` is
  // already derived for the row entrance, so the count costs nothing extra.
  useEffect(() => {
    if (atTail) {
      setUnread(0)
      return
    }
    if (arrivedKeys.size > 0) setUnread((count) => count + arrivedKeys.size)
  }, [arrivedKeys, atTail])

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
      pinned.current = atTailRule({
        operatorMoved: operatorMoved.current,
        measuredAtTail: measureAtTail(
          contentOffset.y,
          layoutMeasurement.height,
          contentSize.height,
        ),
      })
      setAtTail(pinned.current)
      if (contentOffset.y < 200) onLoadOlder?.()
    },
    [onLoadOlder],
  )

  const detailActions = useMemo<SheetAction[]>(
    () =>
      (['summary', 'normal', 'verbose'] as const).map((value) => ({
        label: `${verbosity === value ? '✓ ' : ''}${value[0].toUpperCase()}${value.slice(1)}`,
        hint:
          value === 'summary'
            ? 'Prompts, answers, questions and failures'
            : value === 'verbose'
              ? 'Every tool call and result preview'
              : 'Prose and one folded line per work run',
        onPress: () => setVerbosity(value),
      })),
    [setVerbosity, verbosity],
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

  const renderMessage = (text: string, child: React.ReactNode) => (
    <HoldableMessage text={text} onHold={setActionText}>
      {child}
    </HoldableMessage>
  )

  const renderRow = (row: Row): React.ReactNode => {
    switch (row.kind) {
      case 'user': {
        const time = shortTime(row.item.ts)
        return renderMessage(
          row.item.text,
          <View style={styles.userWrap}>
            <View style={styles.userCard}>
              <View style={styles.userLabelRow}>
                <Text style={styles.userLabel}>You</Text>
                {time ? <Text style={styles.userTime}>{time}</Text> : null}
              </View>
              <MessageText
                text={row.item.text.trim()}
                style={styles.userText}
                onRefPress={onRefPress}
              />
              <SharedFiles item={row.item} context={assetContext} showHeader={false} />
            </View>
          </View>,
        )
      }
      case 'pending': {
        const turn = row.pendingTurn
        const failed = turn.failed
        return (
          <View style={styles.userWrap}>
            <View
              style={[styles.userCard, failed ? styles.userCardFailed : styles.userCardPending]}
            >
              <View style={styles.userLabelRow}>
                <Text style={styles.userLabel}>You</Text>
                <Text style={[styles.userTime, failed && styles.userTimeFailed]}>
                  {failed ? 'not sent' : 'sending…'}
                </Text>
              </View>
              <MessageText text={row.pendingText} style={styles.userText} onRefPress={onRefPress} />
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
              ) : null}
            </View>
          </View>
        )
      }
      case 'question': {
        const isLivePending = live && pending != null && transcriptItemKey(pending) === row.key
        return <AskQuestionCard item={row.item} live={isLivePending} onAnswer={onAnswer} />
      }
      case 'receipt':
        return <AskReceipt item={row.item} />
      case 'tools':
        return <ToolsRun blocks={row.blocks ?? []} verbose={verbosity === 'verbose'} />
      case 'shared':
        return <SharedFiles item={row.item} context={assetContext} />
      case 'envelope':
        return row.envelope
          ? renderMessage(
              row.envelope.body,
              <EnvelopeRow envelope={row.envelope} onRefPress={onRefPress} />,
            )
          : null
      case 'context':
        return <MachineContextDisclosure item={row.item} />
      case 'recap': {
        const time = shortTime(row.item.ts)
        return renderMessage(
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
      }
      case 'quiet':
        return (
          <Text style={styles.quiet} numberOfLines={2}>
            {row.quietText}
          </Text>
        )
      case 'answer': {
        const time = shortTime(row.item.ts)
        return renderMessage(
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
              {streaming && row.key === latestAssistantKey ? (
                <StreamingCaret reduceMotion={reduceMotion} />
              ) : null}
            </View>
            <SharedFiles item={row.item} context={assetContext} showHeader={false} />
          </>,
        )
      }
      default:
        return renderMessage(
          row.item.text,
          <>
            <MessageText
              text={row.item.text.trim()}
              style={styles.proseText}
              onRefPress={onRefPress}
            />
            {streaming && row.key === latestAssistantKey ? (
              <StreamingCaret reduceMotion={reduceMotion} />
            ) : null}
            <SharedFiles item={row.item} context={assetContext} showHeader={false} />
          </>,
        )
    }
  }

  return (
    <View style={styles.listFrame}>
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={[styles.content, { paddingBottom: space.md + bottomInset }]}
        refreshControl={refreshControl}
        {...refreshAccessibilityProps}
        ListEmptyComponent={emptyComponent}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
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
            listRef.current?.scrollToEnd({ animated: false })
          }
        }}
        ListFooterComponent={
          <>
            <TranscriptTail state={tail} />
            {footer ? <View style={styles.footer}>{footer}</View> : null}
          </>
        }
        renderItem={({ item: row, index }) => (
          <FeedRowFrame
            row={row}
            arrived={arrivedKeys.has(row.key)}
            highlighted={search.activeRow === index}
            dimmed={query.trim().length > 0 && !search.matchingRows.has(index)}
            reduceMotion={reduceMotion}
          >
            {renderRow(row)}
          </FeedRowFrame>
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
      ) : (
        <View style={styles.readingTools}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Find in transcript"
            onPress={() => setFindOpen(true)}
            style={({ pressed }) => [styles.utilityButton, pressed && styles.utilityPressed]}
          >
            <Icon as={Search} size={15} color={color.textDim} />
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Transcript detail: ${verbosity}`}
            onPress={() => setDetailOpen(true)}
            style={({ pressed }) => [styles.utilityButton, pressed && styles.utilityPressed]}
          >
            <Text style={styles.detailBars}>
              {verbosity === 'summary' ? '▂' : verbosity === 'normal' ? '▂▄' : '▂▄▆'}
            </Text>
          </PressableScale>
        </View>
      )}

      <JumpToNewest
        visible={!atTail}
        unread={unread}
        lift={bottomInset + space.md}
        reduceMotion={reduceMotion}
        onPress={() => {
          pinned.current = true
          setAtTail(true)
          setUnread(0)
          listRef.current?.scrollToEnd({ animated: !reduceMotion })
        }}
      />

      <ActionSheet
        visible={detailOpen}
        title="Transcript detail"
        actions={detailActions}
        onClose={() => setDetailOpen(false)}
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
    paddingVertical: space.xs,
    backgroundColor: color.bg,
  },
  userCard: {
    backgroundColor: color.surfaceHigh,
    borderColor: color.borderStrong,
    borderWidth: 1,
    borderRadius: radius.lg - 1,
    paddingHorizontal: space.lg - 1,
    paddingVertical: space.sm + 2,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
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
    color: color.danger,
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
    color: color.danger,
    fontSize: font.tiny,
  },
  userLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  userLabel: {
    ...monoLabel(),
    color: color.info,
  },
  userTime: {
    ...mono(400),
    marginLeft: 'auto',
    color: color.textMicro,
    fontSize: font.micro,
  },
  userTimeFailed: {
    ...mono(700),
    color: color.danger,
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
  // Tool run — muted mono one-liners.
  tools: {
    gap: 4,
    paddingLeft: 2,
  },
  workLine: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: 3,
    borderRadius: radius.sm,
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
  workCountFailed: {
    color: color.danger,
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
    color: color.success,
  },
  toolGlyphErr: {
    color: color.danger,
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
  // Final answer — flat, marked by the page's only yellow: a keyline.
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
  tailWorking: {
    color: color.working,
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
  readingTools: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    padding: 2,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.glass,
  },
  utilityButton: {
    minWidth: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  detailBars: {
    ...mono(600),
    color: color.textDim,
    fontSize: font.micro,
    letterSpacing: -1,
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
    fontSize: font.small,
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
