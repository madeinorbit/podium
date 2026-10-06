import type { TranscriptToolRun } from '@podium/client-core/conversation'
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
} from '@podium/client-core/values'
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
  readonly run?: TranscriptToolRun
  blockIndices: number[]
  envelope?: ParsedEnvelope
  quietText?: string
  turn: MobileTurnPosition
}

export interface MobileTranscriptModel {
  blocks: ChatBlock[]
  rows: MobileTranscriptRow[]
  latestAssistantKey: string | undefined
  positionOfKey(key: string): number | undefined
  rowsForBlock(blockIndex: number): readonly number[]
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
  return item.id
}

export interface MobileRowOptions {
  collapseContext?: boolean
  hiddenQuestionId?: string | null
  includeEmpty?: boolean
}

/** Shape one addressed paired row, including its envelope slots. */
export function shapeMobileChatRow(chatRow: ChatRow, options: MobileRowOptions = {}): MobileTranscriptRow[] {
  const rows: MobileTranscriptRow[] = []
  const append = (row: MobileTranscriptRow) => rows.push(row)
  const blockIndices = chatRow.kind === 'tools' ? chatRow.blockIndices : [chatRow.blockIndex]

  if (chatRow.kind === 'tools') {
    const first = chatRow.blocks[0]
    if (!first) return rows
    append({
      key: transcriptItemKey(first.item),
      kind: 'tools',
      item: first.item,
      blocks: chatRow.blocks,
      blockIndices,
      turn: 'bind',
    })
    return rows
  }

  const { item } = chatRow.block
  if (isAskUserQuestion(item)) {
    if (!item.toolResult && item.id === options.hiddenQuestionId) return rows
    append({
      key: transcriptItemKey(item),
      kind: item.toolResult ? 'receipt' : 'question',
      item,
      blockIndices,
      turn: 'beat',
    })
    return rows
  }
  if (item.role === 'tool' && item.toolName === 'SendUserFile') {
    append({
      key: transcriptItemKey(item),
      kind: 'shared',
      item,
      blockIndices,
      turn: 'beat',
    })
    return rows
  }
  if (item.role === 'tool') {
    append({
      key: transcriptItemKey(item),
      kind: 'tools',
      item,
      blocks: [chatRow.block],
      blockIndices,
      turn: 'bind',
    })
    return rows
  }
  if (item.role === 'system') {
    if (item.systemKind === 'recap' && item.text.trim()) {
      append({
        key: transcriptItemKey(item),
        kind: 'recap',
        item,
        blockIndices,
        turn: 'beat',
      })
      return rows
    }
    const quietText =
      item.systemKind === 'duration' && item.durationMs !== undefined
        ? `churned ${formatChurn(item.durationMs)}`
        : item.text.trim()
    if (quietText) {
      append({
        key: transcriptItemKey(item),
        kind: 'quiet',
        item,
        quietText,
        blockIndices,
        turn: item.systemKind === 'duration' ? 'bind' : 'beat',
      })
    }
    return rows
  }
  if (item.event === 'interrupt') {
    append({
      key: transcriptItemKey(item),
      kind: 'quiet',
      item,
      quietText: '⏹ interrupted',
      blockIndices,
      turn: 'bind',
    })
    return rows
  }
  if (!item.text.trim() && !options.includeEmpty) return rows
  if (options.collapseContext && item.role === 'user' && MACHINE_CONTEXT_RE.test(item.text)) {
    append({
      key: transcriptItemKey(item),
      kind: 'context',
      item,
      blockIndices,
      turn: 'beat',
    })
    return rows
  }
  if (item.role === 'user') {
    const batch = parseEnvelopeBatch(item.text)
    if (batch) {
      batch.envelopes.forEach((envelope, index) => {
        append({
          key: `${transcriptItemKey(item)}:message:${envelope.id}`,
          kind: 'envelope',
          item,
          envelope,
          blockIndices,
          turn: index === 0 ? 'open' : 'bind',
        })
      })
      if (batch.operatorText) {
        append({
          key: `${transcriptItemKey(item)}:operator`,
          kind: 'user',
          item: { ...item, text: batch.operatorText },
          blockIndices,
          turn: 'open',
        })
      }
      return rows
    }
    append({
      key: transcriptItemKey(item),
      kind: 'user',
      item,
      blockIndices,
      turn: 'open',
    })
    return rows
  }
  append({
    key: transcriptItemKey(item),
    kind: item.answer ? 'answer' : 'prose',
    item,
    blockIndices,
    turn: 'beat',
  })
  return rows
}

/** Build phone rows from the same normal-detail paired blocks as web. */
export function buildMobileTranscript(
  items: TranscriptItem[],
  options: {
    collapseContext?: boolean
    hiddenQuestionId?: string | null
    /** Keep a structural slot whose observer can reveal the first streamed text. */
    includeEmpty?: boolean
  } = {},
): MobileTranscriptModel {
  const rows: MobileTranscriptRow[] = []
  const positions = new Map<string, number>()
  const blockRows = new Map<number, number[]>()
  const append = (row: MobileTranscriptRow) => {
    const position = rows.length
    rows.push(row)
    if (!positions.has(row.key)) positions.set(row.key, position)
    for (const blockIndex of row.blockIndices) {
      const members = blockRows.get(blockIndex)
      if (members) members.push(position)
      else blockRows.set(blockIndex, [position])
    }
    if (row.kind === 'tools')
      for (const block of row.blocks ?? [])
        if (!positions.has(block.item.id)) positions.set(block.item.id, position)
  }
  const index = indexedTranscript(items)
  const { blocks, rows: chatRows } = index
  let latestAssistantKey: string | undefined

  for (const chatRow of chatRows) {
    for (const row of shapeMobileChatRow(chatRow, options)) {
      append(row)
      if (row.kind === 'answer' || row.kind === 'prose') latestAssistantKey = row.item.id
    }
  }

  return {
    blocks,
    rows,
    latestAssistantKey,
    positionOfKey: (key) => positions.get(key),
    rowsForBlock: (blockIndex) => blockRows.get(blockIndex) ?? [],
  }
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

export interface MobileTranscriptMatches {
  matches: number[]
  matchingRows: Set<number>
  firstRowByBlock: ReadonlyMap<number, number>
}

/** The demanded search answer; cursor movement does not repeat this work. */
export function matchMobileTranscript(
  model: MobileTranscriptModel,
  query: string,
): MobileTranscriptMatches {
  if (!query.trim()) return { matches: [], matchingRows: new Set(), firstRowByBlock: new Map() }
  const matches = searchBlocks(model.blocks, query)
  return projectMobileTranscriptMatches(model, matches)
}

/** A matched block names its presentation rows through the model's identity
 * relation. Folded tool runs and split envelopes can name more than one row. */
export function projectMobileTranscriptMatches(
  model: MobileTranscriptModel,
  matches: number[],
): MobileTranscriptMatches {
  const matchingRows = new Set<number>()
  const firstRowByBlock = new Map<number, number>()
  for (const blockIndex of matches) {
    for (const position of model.rowsForBlock(blockIndex)) {
      if (position >= model.rows.length) continue
      matchingRows.add(position)
      if (!firstRowByBlock.has(blockIndex)) firstRowByBlock.set(blockIndex, position)
    }
  }
  return {
    matches,
    matchingRows: new Set([...matchingRows].sort((a, b) => a - b)),
    firstRowByBlock,
  }
}

/** Answer which matched row is selected through the demanded match relation. */
export function positionMobileTranscriptSearch(
  answer: MobileTranscriptMatches,
  cursor: number,
): MobileTranscriptSearch {
  const { matches, matchingRows, firstRowByBlock } = answer
  const position =
    matches.length > 0 ? (((cursor % matches.length) + matches.length) % matches.length) + 1 : 0
  const activeMatch = matches[position - 1]
  return {
    matches,
    matchingRows,
    activeRow: activeMatch === undefined ? undefined : firstRowByBlock.get(activeMatch),
    position,
    total: matches.length,
  }
}

export function searchMobileTranscript(
  model: MobileTranscriptModel,
  query: string,
  cursor: number,
): MobileTranscriptSearch {
  return positionMobileTranscriptSearch(matchMobileTranscript(model, query), cursor)
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
