import type { TranscriptItem } from '@podium/protocol'

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

export interface MinimapSegment {
  index: number
  role: TranscriptItem['role']
  /** Relative height weight — longer content draws taller. */
  weight: number
}

/** Minimap geometry: one segment per block, log-weighted by content length. */
export function minimapSegments(blocks: ChatBlock[]): MinimapSegment[] {
  return blocks.map((b, index) => {
    const len = b.item.text.length + (b.item.toolInput?.length ?? 0) + (b.result?.length ?? 0) / 4
    return {
      index,
      role: b.item.role,
      weight: 1 + Math.log2(1 + len / 80),
    }
  })
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
