import type { TranscriptItem } from '@podium/protocol'
import { useMemo, useRef } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import { color, font, radius, space } from '../theme/theme'
import { isAskUserQuestion, latestPendingQuestion } from '../viewModels/askQuestion'
import { AskQuestionCard } from './AskQuestionCard'

function itemKey(item: TranscriptItem): string {
  return item.cursor ?? item.id
}

/** Consecutive tool calls/results collapse into one quiet activity row. */
interface Row {
  key: string
  kind: 'message' | 'question' | 'tools'
  item: TranscriptItem
  toolCount?: number
}

function buildRows(items: TranscriptItem[]): Row[] {
  const rows: Row[] = []
  for (const item of items) {
    if (isAskUserQuestion(item)) {
      rows.push({ key: itemKey(item), kind: 'question', item })
      continue
    }
    const isTool = item.role === 'tool' || (!item.text.trim() && item.toolName)
    if (isTool) {
      const last = rows[rows.length - 1]
      if (last?.kind === 'tools') {
        last.toolCount = (last.toolCount ?? 1) + 1
        last.item = item
        continue
      }
      rows.push({ key: itemKey(item), kind: 'tools', item, toolCount: 1 })
      continue
    }
    if (!item.text.trim()) continue
    rows.push({ key: itemKey(item), kind: 'message', item })
  }
  return rows
}

export function TranscriptList({
  items,
  live,
  onAnswer,
  onLoadOlder,
}: {
  items: TranscriptItem[]
  live: boolean
  onAnswer: (choices: { optionIndices: number[] }[]) => Promise<void>
  /** Called when the user scrolls back to the oldest loaded item (paging). */
  onLoadOlder?: () => void
}) {
  const rows = useMemo(() => buildRows(items), [items])
  const pending = useMemo(() => latestPendingQuestion(items), [items])
  const listRef = useRef<FlatList<Row>>(null)

  // Inverted list: newest at the bottom without scroll bookkeeping.
  const data = useMemo(() => [...rows].reverse(), [rows])

  return (
    <FlatList
      ref={listRef}
      inverted
      data={data}
      keyExtractor={(row) => row.key}
      contentContainerStyle={styles.content}
      onEndReached={onLoadOlder ? () => onLoadOlder() : undefined}
      onEndReachedThreshold={0.2}
      renderItem={({ item: row }) => {
        if (row.kind === 'question') {
          const isLivePending = live && pending != null && itemKey(pending) === row.key
          return (
            <View style={styles.rowWrap}>
              <AskQuestionCard item={row.item} live={isLivePending} onAnswer={onAnswer} />
            </View>
          )
        }
        if (row.kind === 'tools') {
          const label =
            row.toolCount && row.toolCount > 1
              ? `${row.toolCount} tool calls`
              : (row.item.toolTitle ?? row.item.toolName ?? 'Tool call')
          return (
            <View style={styles.rowWrap}>
              <Text style={styles.toolRow} numberOfLines={1}>
                {label}
              </Text>
            </View>
          )
        }
        const { item } = row
        const isUser = item.role === 'user'
        return (
          <View style={[styles.rowWrap, isUser ? styles.userAlign : null]}>
            <View
              style={[
                styles.bubble,
                isUser ? styles.userBubble : styles.assistantBubble,
                item.answer ? styles.answerBubble : null,
              ]}
            >
              {item.role === 'system' ? <Text style={styles.systemLabel}>system</Text> : null}
              <Text style={styles.bubbleText} selectable>
                {item.text.trim()}
              </Text>
            </View>
          </View>
        )
      }}
    />
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  rowWrap: {
    marginBottom: space.sm + 2,
  },
  userAlign: {
    alignItems: 'flex-end',
  },
  bubble: {
    maxWidth: '90%',
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 3,
  },
  userBubble: {
    backgroundColor: color.userBubble,
    borderBottomRightRadius: radius.sm - 6,
    alignSelf: 'flex-end',
  },
  assistantBubble: {
    backgroundColor: color.assistantBubble,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: radius.sm - 6,
    alignSelf: 'flex-start',
  },
  answerBubble: {
    borderColor: color.accentBorder,
  },
  bubbleText: {
    color: color.text,
    fontSize: font.body,
    lineHeight: 22,
  },
  systemLabel: {
    color: color.textFaint,
    fontSize: font.tiny,
    marginBottom: 2,
  },
  toolRow: {
    color: color.toolText,
    fontSize: font.tiny,
    fontWeight: '600',
    alignSelf: 'center',
    backgroundColor: color.idleSoft,
    borderRadius: radius.full,
    paddingHorizontal: space.md,
    paddingVertical: 3,
    overflow: 'hidden',
  },
})
