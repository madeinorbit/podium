import {
  buildChatRows,
  type ChatBlock,
  failLine,
  formatChurn,
  isAskUserQuestion,
  isChosenOption,
  latestPendingQuestion,
  pairToolResults,
  parseAskQuestions,
  toolVerdict,
} from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/protocol'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { AskQuestionCard } from './AskQuestionCard'

function itemKey(item: TranscriptItem): string {
  return item.cursor ?? item.id
}

/**
 * Flat Field rows (POD-159, adapted for mobile in POD-176): the agent's work
 * lies flat on the chassis; the operator's turns are the only elevated surface.
 * They do NOT stick to the top (POD-338) — a phone viewport is too short to
 * spend a permanent band on a message you already read. Tool runs are muted mono
 * one-liners with per-call ✓/✕ verdicts; the final answer gets the page's only
 * yellow (a keyline, not a box); an answered ask collapses to a one-line receipt.
 */
interface Row {
  key: string
  kind: 'user' | 'prose' | 'answer' | 'tools' | 'question' | 'receipt' | 'quiet' | 'pending'
  item: TranscriptItem
  blocks?: ChatBlock[]
  /** Pre-formatted text for 'quiet' rows (system lines, churn durations). */
  quietText?: string
  /** Optimistic turn text for 'pending' rows (not yet echoed by the server). */
  pendingText?: string
  /** The optimistic turn itself, so a failed row can offer a retry. */
  pendingTurn?: PendingTurn
}

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

function buildRows(items: TranscriptItem[]): Row[] {
  const rows: Row[] = []
  for (const chatRow of buildChatRows(pairToolResults(items))) {
    if (chatRow.kind === 'tools') {
      const first = chatRow.blocks[0]
      if (!first) continue
      rows.push({
        key: itemKey(first.item),
        kind: 'tools',
        item: first.item,
        blocks: chatRow.blocks,
      })
      continue
    }
    const { item } = chatRow.block
    if (isAskUserQuestion(item)) {
      // Answered asks collapse to a one-line receipt; open ones stay a card.
      rows.push({
        key: itemKey(item),
        kind: item.toolResult ? 'receipt' : 'question',
        item,
      })
      continue
    }
    if (item.role === 'tool') {
      // Non-batchable tool without rich mobile rendering (SendUserFile): a quiet row.
      rows.push({ key: itemKey(item), kind: 'tools', item, blocks: [chatRow.block] })
      continue
    }
    if (item.role === 'system') {
      const quietText =
        item.systemKind === 'duration' && item.durationMs !== undefined
          ? `churned ${formatChurn(item.durationMs)}`
          : item.text.trim()
      if (!quietText) continue
      rows.push({ key: itemKey(item), kind: 'quiet', item, quietText })
      continue
    }
    if (item.event === 'interrupt') {
      rows.push({ key: itemKey(item), kind: 'quiet', item, quietText: '⏹ interrupted' })
      continue
    }
    if (!item.text.trim()) continue
    if (item.role === 'user') {
      rows.push({ key: itemKey(item), kind: 'user', item })
      continue
    }
    rows.push({ key: itemKey(item), kind: item.answer ? 'answer' : 'prose', item })
  }
  return rows
}

/** POD-refs in message text become tappable (→ the task peek sheet). */
const REF_RE = /\b(POD-\d+)\b/g

function MessageText({
  text,
  style,
  onRefPress,
}: {
  text: string
  style: object
  onRefPress?: ((ref: string) => void) | undefined
}) {
  if (!onRefPress || !REF_RE.test(text)) {
    return (
      <Text style={style} selectable>
        {text}
      </Text>
    )
  }
  const parts = text.split(REF_RE)
  return (
    <Text style={style} selectable>
      {parts.map((part, i) =>
        /^POD-\d+$/.test(part) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: split parts are positional
          <Text key={`${part}:${i}`} style={styles.refLink} onPress={() => onRefPress(part)}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  )
}

const TOOLS_COLLAPSED_MAX = 6

/** A run of tool calls: one muted mono line per call — verdict glyph, name,
 *  the agent's own description, right-aligned magnitude — with a failed call's
 *  first result line surfaced beneath it. Long runs fold behind "▸ n more". */
function ToolsRun({ blocks }: { blocks: ChatBlock[] }) {
  const [expanded, setExpanded] = useState(false)
  const hidden = blocks.length - TOOLS_COLLAPSED_MAX
  const shown = expanded || hidden <= 1 ? blocks : blocks.slice(0, TOOLS_COLLAPSED_MAX)
  return (
    <View style={styles.tools}>
      {shown.map((b) => {
        const { item } = b
        const result = b.result ?? item.toolResult
        const verdict = toolVerdict(result)
        const desc = item.toolTitle ?? item.toolInput ?? ''
        const files = item.toolPaths?.length ?? 0
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
            ) : null}
          </View>
        )
      })}
      {!expanded && hidden > 1 ? (
        <Text style={styles.toolsMore} onPress={() => setExpanded(true)} suppressHighlighting>
          ▸ {hidden} more calls
        </Text>
      ) : null}
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

export function TranscriptList({
  items,
  live,
  onAnswer,
  onLoadOlder,
  onRefPress,
  pendingTurns,
  onRetryPending,
}: {
  items: TranscriptItem[]
  live: boolean
  onAnswer: (choices: { optionIndices: number[] }[]) => Promise<void>
  /** Called when the user scrolls back to the oldest loaded item (paging). */
  onLoadOlder?: () => void
  /** Tap handler for POD-refs in message text (opens the task peek sheet). */
  onRefPress?: (ref: string) => void
  /** Turns sent but not yet echoed by the server, appended at the tail. */
  pendingTurns?: readonly PendingTurn[]
  /** Send a rejected turn again (only failed rows expose the affordance). */
  onRetryPending?: (turn: PendingTurn) => void
}) {
  const rows = useMemo(() => {
    const built = buildRows(items)
    for (const turn of pendingTurns ?? []) {
      built.push({
        key: `pending:${turn.id}`,
        kind: 'pending',
        item: { id: turn.id, role: 'user', text: turn.text } as TranscriptItem,
        pendingText: turn.text,
        pendingTurn: turn,
      })
    }
    return built
  }, [items, pendingTurns])
  const pending = useMemo(() => latestPendingQuestion(items), [items])
  const listRef = useRef<FlatList<Row>>(null)
  // Chronological (not inverted). Bottom-pinning is done by hand: scrollToEnd
  // on growth while the user sits at the tail.
  const pinned = useRef(true)

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
      pinned.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48
      if (contentOffset.y < 200) onLoadOlder?.()
    },
    [onLoadOlder],
  )

  return (
    <FlatList
      ref={listRef}
      data={rows}
      keyExtractor={(row) => row.key}
      contentContainerStyle={styles.content}
      // Keeps the viewport steady when older pages prepend above.
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      onScroll={onScroll}
      scrollEventThrottle={64}
      onContentSizeChange={() => {
        if (pinned.current) listRef.current?.scrollToEnd({ animated: false })
      }}
      renderItem={({ item: row }) => {
        switch (row.kind) {
          case 'user': {
            const time = shortTime(row.item.ts)
            return (
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
                </View>
              </View>
            )
          }
          case 'pending': {
            const turn = row.pendingTurn
            const failed = turn?.failed
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
                  <MessageText
                    text={row.pendingText ?? ''}
                    style={styles.userText}
                    onRefPress={onRefPress}
                  />
                  {failed ? (
                    <>
                      <Text style={styles.pendingError}>{failed}</Text>
                      {onRetryPending && turn ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Send this message again"
                          onPress={() => onRetryPending(turn)}
                          hitSlop={8}
                          style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
                        >
                          <Text style={styles.retryText}>Try again</Text>
                        </Pressable>
                      ) : null}
                    </>
                  ) : null}
                </View>
              </View>
            )
          }
          case 'question': {
            const isLivePending = live && pending != null && itemKey(pending) === row.key
            return (
              <View style={styles.rowWrap}>
                <AskQuestionCard item={row.item} live={isLivePending} onAnswer={onAnswer} />
              </View>
            )
          }
          case 'receipt':
            return (
              <View style={styles.rowWrap}>
                <AskReceipt item={row.item} />
              </View>
            )
          case 'tools':
            return (
              <View style={styles.rowWrap}>
                <ToolsRun blocks={row.blocks ?? []} />
              </View>
            )
          case 'quiet':
            return (
              <View style={styles.rowWrap}>
                <Text style={styles.quiet} numberOfLines={2}>
                  {row.quietText}
                </Text>
              </View>
            )
          case 'answer': {
            const time = shortTime(row.item.ts)
            return (
              <View style={styles.rowWrap}>
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
                </View>
              </View>
            )
          }
          default:
            return (
              <View style={styles.rowWrap}>
                <MessageText
                  text={row.item.text.trim()}
                  style={styles.proseText}
                  onRefPress={onRefPress}
                />
              </View>
            )
        }
      }}
    />
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    // A short conversation rests on the composer instead of hanging from the
    // header — the desktop chat's bottom-anchored feel (POD-338).
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  rowWrap: {
    marginBottom: space.lg,
  },
  // Operator turn — the ONLY elevated surface on the field.
  userWrap: {
    paddingVertical: space.xs,
    marginBottom: space.md,
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
    lineHeight: 16,
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
    ...monoLabel(font.micro - 0.5),
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
    lineHeight: 19,
  },
  // Agent prose — flat on the chassis, no bubble.
  proseText: {
    ...sans(400),
    color: color.body,
    fontSize: font.body,
    lineHeight: 21,
  },
  refLink: {
    color: color.accentTint,
    textDecorationLine: 'underline',
  },
  // Tool run — muted mono one-liners.
  tools: {
    gap: 4,
    paddingLeft: 2,
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
    fontSize: 11,
  },
  toolDesc: {
    ...mono(400),
    flex: 1,
    color: color.textFaint,
    fontSize: 11,
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
    fontSize: 10.5,
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
    ...monoLabel(font.micro - 0.5),
    color: color.accent,
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
    lineHeight: 16,
  },
  receiptPick: {
    ...sans(500),
    color: color.body,
    fontSize: 11,
    borderColor: color.hairline,
    borderWidth: 1,
    borderRadius: radius.xs,
    paddingHorizontal: 7,
    paddingVertical: 1,
    overflow: 'hidden',
    maxWidth: '40%',
  },
})
