import type { TranscriptItem, TranscriptTag } from '@podium/protocol'

/**
 * Pure helpers for the chat view: tool-call/result pairing, transcript search,
 * and the birds-eye minimap geometry. Rendering stays in ChatView.tsx.
 */

export interface ChatBlock {
  item: TranscriptItem
  /** Result text paired onto a tool-call block (toolUseId match). */
  result?: string
}

/**
 * Collapse the raw item stream into renderable blocks: tool results fold into
 * their originating tool call; everything else passes through in order.
 */
export function pairToolResults(items: TranscriptItem[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  const callByToolUseId = new Map<string, ChatBlock>()
  for (const item of items) {
    if (item.role === 'tool' && item.toolResult !== undefined && item.toolUseId) {
      const call = callByToolUseId.get(item.toolUseId)
      if (call) {
        call.result = item.toolResult
        continue
      }
      // Orphan result (call scrolled out of the buffer) — show it standalone.
      blocks.push({ item })
      continue
    }
    const block: ChatBlock = { item }
    if (item.role === 'tool' && item.toolUseId) callByToolUseId.set(item.toolUseId, block)
    blocks.push(block)
  }
  return blocks
}

/**
 * A tool call quiet enough to fold into a batch. AskUserQuestion (the agent
 * prompting the human → interactive card) and SendUserFile (the agent surfacing
 * images/files → inline previews + lightbox) both render richly, so they break a
 * run like any text output instead of collapsing into a summary line.
 */
export function isBatchableTool(item: TranscriptItem): boolean {
  return (
    item.role === 'tool' &&
    item.toolName !== 'AskUserQuestion' &&
    item.toolName !== 'SendUserFile'
  )
}

/** A run of consecutive tool calls, shown collapsed under one summary title. */
export interface ToolBatchRow {
  kind: 'tools'
  blocks: ChatBlock[]
  /** Each child's index in the flat ChatBlock[] — lets search map a hit to its row. */
  blockIndices: number[]
  title: string
}
/** Anything that isn't a quiet tool call: prose, prompts, the AskUserQuestion card. */
export interface SingleRow {
  kind: 'block'
  block: ChatBlock
  blockIndex: number
}
export type ChatRow = SingleRow | ToolBatchRow

/**
 * Group the flat block stream into renderable rows. Maximal runs of consecutive
 * quiet tool calls (no intervening text/prompt) collapse into one summarized
 * batch; every other block stays its own row and breaks a run. Mirrors how the
 * agent works in bursts of tools between bits of narration.
 */
export function buildChatRows(blocks: ChatBlock[]): ChatRow[] {
  const rows: ChatRow[] = []
  let run: { blocks: ChatBlock[]; indices: number[] } | null = null
  const flush = (): void => {
    if (!run) return
    rows.push({ kind: 'tools', blocks: run.blocks, blockIndices: run.indices, title: toolBatchTitle(run.blocks) })
    run = null
  }
  blocks.forEach((block, i) => {
    if (isBatchableTool(block.item)) {
      run ??= { blocks: [], indices: [] }
      run.blocks.push(block)
      run.indices.push(i)
    } else {
      flush()
      rows.push({ kind: 'block', block, blockIndex: i })
    }
  })
  flush()
  return rows
}

// Tool → the verb/noun the summary counts it under. Past tense to read as a log
// of what happened ("Read 3 files", "Created 4 files", "Ran 5 commands").
function toolCategory(item: TranscriptItem): { verb: string; noun: string } {
  switch (item.toolName) {
    case 'Read':
      return { verb: 'Read', noun: 'file' }
    case 'Write':
      return { verb: 'Created', noun: 'file' }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'Edited', noun: 'file' }
    case 'Bash':
      return { verb: 'Ran', noun: 'command' }
    case 'Task':
      return { verb: 'Ran', noun: 'agent' }
    case 'Grep':
    case 'Glob':
      return { verb: 'Ran', noun: 'search' }
    default:
      return { verb: 'Ran', noun: 'tool' }
  }
}

const pluralizeNoun = (noun: string): string => (/(?:s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`)
const articleFor = (noun: string): string => (/^[aeiou]/i.test(noun) ? 'an' : 'a')
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)
const clauseFor = (verb: string, noun: string, count: number): string =>
  count === 1 ? `${verb} ${articleFor(noun)} ${noun}` : `${verb} ${count} ${pluralizeNoun(noun)}`

/**
 * Smart one-line summary for a tool batch: clauses per tool kind in first-
 * appearance order, the first capitalized and the rest lowercased
 * ("Read 2 files, ran a command"). A lone command quotes the agent's own intent
 * (the Bash `description`, falling back to the shell) rather than counting it:
 * `Ran "Render the three chat-view mockups to PNG"`.
 */
export function toolBatchTitle(blocks: ChatBlock[]): string {
  const only = blocks.length === 1 ? blocks[0] : undefined
  if (only && only.item.toolName === 'Bash') {
    const label = (only.item.toolTitle ?? only.item.toolInput ?? '').trim()
    return label ? `Ran "${label}"` : 'Ran a command'
  }
  const order: string[] = []
  const tally = new Map<string, { verb: string; noun: string; count: number }>()
  for (const b of blocks) {
    const { verb, noun } = toolCategory(b.item)
    const key = `${verb}|${noun}`
    const entry = tally.get(key)
    if (entry) entry.count++
    else {
      tally.set(key, { verb, noun, count: 1 })
      order.push(key)
    }
  }
  return order
    .map((key, i) => {
      const { verb, noun, count } = tally.get(key)!
      const clause = clauseFor(verb, noun, count)
      return i === 0 ? clause : lowerFirst(clause)
    })
    .join(', ')
}

/** Case-insensitive keyword match over everything a block shows. */
export function blockMatches(block: ChatBlock, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  const hay = [
    block.item.text,
    block.item.toolName ?? '',
    block.item.toolInput ?? '',
    block.result ?? block.item.toolResult ?? '',
  ]
    .join('\n')
    .toLowerCase()
  return hay.includes(q)
}

export function searchBlocks(blocks: ChatBlock[], query: string): number[] {
  if (!query.trim()) return []
  const hits: number[] = []
  blocks.forEach((b, i) => {
    if (blockMatches(b, query)) hits.push(i)
  })
  return hits
}

/** DOM-measured position of one [data-block] child as ratios of scrollHeight. */
export interface BlockOffset {
  index: number
  /** offsetTop / scrollHeight */
  top: number
  /** offsetHeight / scrollHeight */
  height: number
}

/** One tick rendered in the minimap, positioned in the same linear scroll space
 *  as the viewport box and scrubTo. */
export interface MinimapTick {
  index: number
  role: TranscriptItem['role']
  answer: boolean
  /** Ratio of scroller.scrollHeight — pass directly to `top: X%`. */
  top: number
  /** Ratio of scroller.scrollHeight — pass directly to `height: X%`. */
  height: number
}

/**
 * Read the real DOM positions of every [data-block] child of `scroller` and
 * return them as ratios of scrollHeight so they live in the same coordinate
 * space as scrollTop/scrollHeight.
 */
export function measureBlockOffsets(scroller: HTMLElement): BlockOffset[] {
  const total = scroller.scrollHeight || 1
  const scrollerTop = scroller.getBoundingClientRect().top
  const offsets: BlockOffset[] = []
  const children = scroller.querySelectorAll<HTMLElement>('[data-block]')
  children.forEach((el) => {
    const indexAttr = el.getAttribute('data-block')
    if (indexAttr === null) return
    const index = Number(indexAttr)
    const top = (el.getBoundingClientRect().top - scrollerTop + scroller.scrollTop) / total
    offsets.push({
      index,
      top,
      height: el.offsetHeight / total,
    })
  })
  return offsets
}

/** Minimap colour inputs for one rendered row. A tool batch reads as 'tool'
 *  (faint) regardless of how many calls it folds. */
export function rowTickMeta(row: ChatRow): { role: TranscriptItem['role']; answer: boolean } {
  if (row.kind === 'tools') return { role: 'tool', answer: false }
  return { role: row.block.item.role, answer: row.block.item.answer === true }
}

/**
 * Zip per-row metadata (role, answer) with DOM-measured offsets to produce ticks
 * for the minimap. Both arrays are indexed by ROW position (one tick per rendered
 * [data-block] row); entries with no matching offset are skipped.
 */
export function ticksFromOffsets(
  metas: Array<{ role: TranscriptItem['role']; answer: boolean }>,
  offsets: BlockOffset[],
): MinimapTick[] {
  const offsetByIndex = new Map<number, BlockOffset>()
  for (const o of offsets) offsetByIndex.set(o.index, o)
  const ticks: MinimapTick[] = []
  metas.forEach((m, i) => {
    const o = offsetByIndex.get(i)
    if (!o) return
    ticks.push({ index: i, role: m.role, answer: m.answer, top: o.top, height: o.height })
  })
  return ticks
}

/** An optimistic "You" bubble shown immediately on send, before the transcript
 *  tail echoes the real user turn back. `at` = creation time (ms), used to drop
 *  the "sending" affordance after a timeout.
 *  State: 'sending' (in flight) → 'sent' (delivered; echo just hasn't tailed back
 *  yet, so render it as a plain bubble) or 'failed' (the send itself rejected). */
export interface PendingItem {
  id: string
  text: string
  at: number
  state: 'sending' | 'sent' | 'failed'
  tags?: TranscriptTag[]
}

/**
 * Remove pending bubbles that the real transcript has now caught up with.
 * `newUserTexts` are the trimmed texts of user blocks that appeared *this* render
 * (caller diffs by block id). Each new occurrence consumes the oldest pending
 * entry with equal trimmed text (FIFO), so duplicate prompts reconcile one-by-one.
 */
export function reconcilePending(pending: PendingItem[], newUserTexts: string[]): PendingItem[] {
  if (pending.length === 0) return pending
  const remaining = [...newUserTexts.map((t) => t.trim())]
  return pending.filter((p) => {
    const i = remaining.indexOf(p.text.trim())
    if (i === -1) return true
    remaining.splice(i, 1)
    return false
  })
}
