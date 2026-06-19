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
  const offsets: BlockOffset[] = []
  const children = scroller.querySelectorAll<HTMLElement>('[data-block]')
  children.forEach((el) => {
    const indexAttr = el.getAttribute('data-block')
    if (indexAttr === null) return
    const index = Number(indexAttr)
    offsets.push({
      index,
      top: el.offsetTop / total,
      height: el.offsetHeight / total,
    })
  })
  return offsets
}

/**
 * Zip block metadata (role, answer) with DOM-measured offsets to produce ticks
 * for the minimap. Both arrays are indexed by block position; entries with no
 * matching offset are skipped.
 */
export function ticksFromOffsets(blocks: ChatBlock[], offsets: BlockOffset[]): MinimapTick[] {
  const offsetByIndex = new Map<number, BlockOffset>()
  for (const o of offsets) offsetByIndex.set(o.index, o)
  const ticks: MinimapTick[] = []
  blocks.forEach((b, i) => {
    const o = offsetByIndex.get(i)
    if (!o) return
    ticks.push({
      index: i,
      role: b.item.role,
      answer: b.item.answer === true,
      top: o.top,
      height: o.height,
    })
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
