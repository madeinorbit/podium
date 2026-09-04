import {
  type ChatBlock,
  type ChatRow,
  computeTranscript,
  envelopePrincipal,
  formatChurn,
  isAskUserQuestion,
  isChosenOption,
  MACHINE_CONTEXT_RE,
  machineContextLabel,
  type ParsedEnvelope,
  parseAskQuestions,
  parseEnvelopeBatch,
  searchBlocks,
} from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'

export type MobileTurnPosition = 'open' | 'bind' | 'beat'

/**
 * The mobile rendering model for one visible transcript row. It deliberately
 * keeps the source block indices: phone search, just like web search, matches
 * the complete tool result even when the work run is folded to one line.
 */
export interface MobileTranscriptRow {
  key: string
  kind:
    | 'user'
    | 'prose'
    | 'answer'
    | 'tools'
    | 'question'
    | 'receipt'
    | 'quiet'
    | 'envelope'
    | 'shared'
    | 'recap'
    | 'context'
  item: TranscriptItem
  blocks?: ChatBlock[]
  blockIndices: number[]
  envelope?: ParsedEnvelope
  quietText?: string
  turn: MobileTurnPosition
}

export interface MobileTranscriptModel {
  blocks: ChatBlock[]
  rows: MobileTranscriptRow[]
}

interface MobileTranscriptIndex {
  blocks: ChatBlock[]
  rows: ChatRow[]
}

// Search changes frequently while the transcript snapshot usually does not.
// Keep the paired/row-shaped graph per immutable item array so a query does not
// repeat the same shaping work on the React Native JS thread.
const transcriptIndexCache = new WeakMap<object, MobileTranscriptIndex>()

function indexedTranscript(items: TranscriptItem[]): MobileTranscriptIndex {
  const cached = transcriptIndexCache.get(items)
  if (cached) return cached
  const result = computeTranscript({ items, verbosity: 'normal', query: '', cursor: 0 })
  const index = { blocks: result.blocks, rows: result.rows }
  transcriptIndexCache.set(items, index)
  return index
}

export function transcriptItemKey(item: TranscriptItem): string {
  return item.cursor ?? item.id
}

/** Build phone rows from the same normal-detail paired blocks as web. */
export function buildMobileTranscript(
  items: TranscriptItem[],
  options: {
    collapseContext?: boolean
  } = {},
): MobileTranscriptModel {
  const rows: MobileTranscriptRow[] = []
  const index = indexedTranscript(items)
  const { blocks, rows: chatRows } = index

  for (const chatRow of chatRows) {
    const blockIndices = chatRow.kind === 'tools' ? chatRow.blockIndices : [chatRow.blockIndex]

    if (chatRow.kind === 'tools') {
      const first = chatRow.blocks[0]
      if (!first) continue
      rows.push({
        key: transcriptItemKey(first.item),
        kind: 'tools',
        item: first.item,
        blocks: chatRow.blocks,
        blockIndices,
        turn: 'bind',
      })
      continue
    }

    const { item } = chatRow.block
    if (isAskUserQuestion(item)) {
      rows.push({
        key: transcriptItemKey(item),
        kind: item.toolResult ? 'receipt' : 'question',
        item,
        blockIndices,
        turn: 'beat',
      })
      continue
    }
    if (item.role === 'tool' && item.toolName === 'SendUserFile') {
      rows.push({
        key: transcriptItemKey(item),
        kind: 'shared',
        item,
        blockIndices,
        turn: 'beat',
      })
      continue
    }
    if (item.role === 'tool') {
      rows.push({
        key: transcriptItemKey(item),
        kind: 'tools',
        item,
        blocks: [chatRow.block],
        blockIndices,
        turn: 'bind',
      })
      continue
    }
    if (item.role === 'system') {
      if (item.systemKind === 'recap' && item.text.trim()) {
        rows.push({
          key: transcriptItemKey(item),
          kind: 'recap',
          item,
          blockIndices,
          turn: 'beat',
        })
        continue
      }
      const quietText =
        item.systemKind === 'duration' && item.durationMs !== undefined
          ? `churned ${formatChurn(item.durationMs)}`
          : item.text.trim()
      if (quietText) {
        rows.push({
          key: transcriptItemKey(item),
          kind: 'quiet',
          item,
          quietText,
          blockIndices,
          turn: item.systemKind === 'duration' ? 'bind' : 'beat',
        })
      }
      continue
    }
    if (item.event === 'interrupt') {
      rows.push({
        key: transcriptItemKey(item),
        kind: 'quiet',
        item,
        quietText: '⏹ interrupted',
        blockIndices,
        turn: 'bind',
      })
      continue
    }
    if (!item.text.trim()) continue
    if (options.collapseContext && item.role === 'user' && MACHINE_CONTEXT_RE.test(item.text)) {
      rows.push({
        key: transcriptItemKey(item),
        kind: 'context',
        item,
        blockIndices,
        turn: 'beat',
      })
      continue
    }
    if (item.role === 'user') {
      const batch = parseEnvelopeBatch(item.text)
      if (batch) {
        batch.envelopes.forEach((envelope, index) => {
          rows.push({
            key: `${transcriptItemKey(item)}:message:${envelope.id}`,
            kind: 'envelope',
            item,
            envelope,
            blockIndices,
            turn: index === 0 ? 'open' : 'bind',
          })
        })
        if (batch.operatorText) {
          rows.push({
            key: `${transcriptItemKey(item)}:operator`,
            kind: 'user',
            item: { ...item, text: batch.operatorText },
            blockIndices,
            turn: 'open',
          })
        }
        continue
      }
      rows.push({
        key: transcriptItemKey(item),
        kind: 'user',
        item,
        blockIndices,
        turn: 'open',
      })
      continue
    }
    rows.push({
      key: transcriptItemKey(item),
      kind: item.answer ? 'answer' : 'prose',
      item,
      blockIndices,
      turn: 'beat',
    })
  }

  return { blocks, rows }
}

/** Shape the one in-progress assistant row without touching settled history. */
export function liveAssistantRow(
  item: TranscriptItem | undefined,
  blockIndex: number,
): MobileTranscriptRow | undefined {
  if (!item) return undefined
  return {
    key: transcriptItemKey(item),
    kind: item.answer ? 'answer' : 'prose',
    item,
    blockIndices: [blockIndex],
    turn: 'beat',
  }
}

export interface MobileTranscriptSearch {
  matches: number[]
  matchingRows: Set<number>
  activeRow: number | undefined
  position: number
  total: number
}

export function searchMobileTranscript(
  model: MobileTranscriptModel,
  query: string,
  cursor: number,
): MobileTranscriptSearch {
  const matches = searchBlocks(model.blocks, query)
  const matchingRows = new Set<number>()
  let activeRow: number | undefined
  const activeMatch =
    matches.length > 0
      ? matches[((cursor % matches.length) + matches.length) % matches.length]
      : undefined

  model.rows.forEach((row, index) => {
    if (row.blockIndices.some((blockIndex) => matches.includes(blockIndex))) matchingRows.add(index)
    if (
      activeMatch !== undefined &&
      row.blockIndices.includes(activeMatch) &&
      activeRow === undefined
    )
      activeRow = index
  })

  return {
    matches,
    matchingRows,
    activeRow,
    position:
      matches.length > 0 ? (((cursor % matches.length) + matches.length) % matches.length) + 1 : 0,
    total: matches.length,
  }
}

export function quoteTranscriptText(text: string): string {
  return `${text.trim().replace(/^/gm, '> ')}\n\n`
}

/**
 * License one-shot arrival motion only for unseen rows appended after the
 * newest row shared with the previous render. A scroll-back page prepends
 * history and therefore returns no arrivals.
 */
export function appendedTranscriptArrivals(
  previous: readonly string[],
  seen: ReadonlySet<string>,
  current: readonly string[],
): Set<string> {
  if (previous.length === 0) return new Set()
  let anchor = -1
  for (let index = previous.length - 1; index >= 0; index--) {
    const key = previous[index]
    if (!key) continue
    const currentIndex = current.indexOf(key)
    if (currentIndex >= 0) {
      anchor = currentIndex
      break
    }
  }
  if (anchor < 0) return new Set()
  return new Set(current.filter((key, index) => index > anchor && !seen.has(key)))
}

// Re-exported for the presentational rows, keeping transcript parsing in one module.
export { envelopePrincipal, isChosenOption, machineContextLabel, parseAskQuestions }
