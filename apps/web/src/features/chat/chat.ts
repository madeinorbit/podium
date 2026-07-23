import type { ChatBlock, ChatRow } from '@podium/client-core/viewmodels'
import type { TranscriptItem, TranscriptTag } from '@podium/protocol'

/**
 * Pure helpers for the chat view: transcript search and the birds-eye minimap
 * geometry. Rendering stays in ChatView.tsx. The presentation-pure tool-call
 * helpers (pairing, batching, verdicts) moved to @podium/client-core/viewmodels
 * so the mobile TranscriptList shares them (POD-176); re-exported here so web
 * call sites keep their import path.
 */
export {
  buildChatRows,
  type ChatBlock,
  type ChatRow,
  failLine,
  isBatchableTool,
  pairToolResults,
  type SingleRow,
  type ToolBatchRow,
  type ToolVerdict,
  toolBatchTitle,
  toolVerdict,
} from '@podium/client-core/viewmodels'

/** Identity key for dedup/merge: the opaque cursor when present (stable across
 *  re-reads), else the synthesized `id` (a few items have no cursor). */
function itemKey(item: TranscriptItem): string {
  return item.cursor ?? item.id
}

/**
 * Merge live-delta items into the held list, keyed by cursor (or id). A delta item
 * whose key is already present REPLACES the held one in place (preserving its
 * position); a new key is appended (deltas are newer → appended). Order preserved.
 * Returns `prev` unchanged (referentially) when nothing actually changed, so a
 * no-op delta doesn't trigger a re-render.
 *
 * Replace-not-skip is load-bearing: the live tailer flushes an unterminated
 * trailing record immediately (so a final message surfaces promptly), then
 * re-emits it at the SAME cursor once its newline lands with the complete content.
 * A skip-on-seen (first-wins) merge would pin the earlier, possibly truncated
 * version; replacing lets the completed record supersede it.
 */
export function mergeByCursor(prev: TranscriptItem[], delta: TranscriptItem[]): TranscriptItem[] {
  if (delta.length === 0) return prev
  const indexByKey = new Map<string, number>()
  prev.forEach((it, i) => {
    indexByKey.set(itemKey(it), i)
  })
  let next: TranscriptItem[] | null = null // cloned lazily on the first real change
  const additions: TranscriptItem[] = []
  for (const it of delta) {
    const key = itemKey(it)
    const at = indexByKey.get(key)
    if (at !== undefined) {
      const existing = (next ?? prev)[at]
      if (existing !== undefined && !sameItemContent(existing, it)) {
        if (!next) next = [...prev]
        next[at] = it
      }
    } else {
      indexByKey.set(key, prev.length + additions.length)
      additions.push(it)
    }
  }
  if (!next && additions.length === 0) return prev
  return [...(next ?? prev), ...additions]
}

/** Cheap content equality for the fields a re-emitted (growing) record changes —
 *  lets mergeByCursor skip a re-render when a same-cursor re-emit is identical. */
function sameItemContent(a: TranscriptItem, b: TranscriptItem): boolean {
  return a.text === b.text && a.toolResult === b.toolResult && a.toolInput === b.toolInput
}

/**
 * Accumulate the file paths a transcript references (for the terminal file-link
 * provider) across the hub's per-frame DELTAS. Each non-reset frame folds its
 * items' `toolPaths` into the growing set; a `reset` frame (file roll / reattach
 * re-seed) starts the set over from empty. Returns a FRESH `Set` every call (never
 * the `prev` identity) so callers can hand it straight to React state / a view
 * setter without aliasing the accumulator they keep.
 */
export function accumulateFileLinkPaths(
  prev: ReadonlySet<string>,
  delta: TranscriptItem[],
  reset: boolean,
): Set<string> {
  const set = reset ? new Set<string>() : new Set(prev)
  for (const it of delta) for (const p of it.toolPaths ?? []) set.add(p)
  return set
}

/**
 * Reconcile a held window against a fresh `reset` snapshot WITHOUT ever dropping
 * messages already on screen. A `reset` (reattach re-seed / file roll / server
 * cache rebuild after a redeploy) used to replace the window outright with a disk
 * re-read — which silently lost (a) a live-tailed but not-yet-newline-terminated
 * trailing record that the disk reader drops, and (b) the WHOLE view when the
 * re-read came back empty (a session with no resume value, or a transient read
 * failure). Both presented as "the newest messages appear, then vanish".
 *
 * Rules, in order:
 *   - Empty snapshot → keep `prev` as-is (referentially). An empty re-read is never
 *     authoritative enough to wipe a populated view; the live tail refills it.
 *   - `snapshotTail` still present in `prev` → SAME conversation continuing: adopt
 *     the snapshot, then re-append any held items that sat AFTER the snapshot's tail
 *     (newer in-flight records the re-read dropped). Order-based, so it needs no
 *     cursor decoding. `mergeByCursor` dedups, so a superset snapshot is a no-op.
 *   - `snapshotTail` absent from `prev` (or undefined) → genuine roll/replacement:
 *     the held cursors are stale, so replace wholesale with the snapshot.
 */
export function reconcileReset(
  prev: TranscriptItem[],
  snapshot: TranscriptItem[],
  snapshotTail: string | undefined,
): TranscriptItem[] {
  if (snapshot.length === 0) return prev
  const tailIdx =
    snapshotTail !== undefined ? prev.findIndex((it) => itemKey(it) === snapshotTail) : -1
  // Roll/replacement (tail not in the held window): adopt the snapshot verbatim.
  if (tailIdx < 0) return snapshot
  // Same conversation: keep items the held window has beyond the snapshot's tail.
  const newerHeld = prev.slice(tailIdx + 1)
  return newerHeld.length > 0 ? mergeByCursor(snapshot, newerHeld) : snapshot
}

/**
 * Drop later items that share a cursor (or id) with an earlier one — keeps the
 * first occurrence, preserving order. Used at the `[...older, ...items]` seam to
 * guard a one-item paging/live overlap.
 */
export function dedupeByCursor(items: TranscriptItem[]): TranscriptItem[] {
  const seen = new Set<string>()
  const out: TranscriptItem[] = []
  for (const it of items) {
    const key = itemKey(it)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
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
  state: 'sending' | 'queued' | 'sent' | 'failed'
  tags?: TranscriptTag[]
  /** Uploaded paths encoded into the submitted prompt. Transcript providers
   * normalize those paths out of `text`, so they are the stable identity used
   * to reconcile attachment-bearing turns. */
  toolPaths?: string[]
}

/** A human chat message durably held in the unified message ledger until the
 * agent reaches its next turn boundary. These rows are separate from the
 * sessions queued_messages outbox, so ChatView must restore them explicitly. */
export interface QueuedChatMessage {
  id: string
  text: string
  at: number
}

export function queuedOperatorMessages(rows: unknown, sessionId: string): QueuedChatMessage[] {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .filter(
      (row) =>
        row.from === 'operator' &&
        row.to === `session:${sessionId}` &&
        row.status === 'queued' &&
        typeof row.id === 'string' &&
        typeof row.body === 'string' &&
        typeof row.createdAt === 'string',
    )
    .map((row) => ({
      id: row.id as string,
      text: row.body as string,
      at: Date.parse(row.createdAt as string) || 0,
    }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

/** Hide server-restored rows already represented by an optimistic bubble.
 * Duplicate prompt text is consumed FIFO so two identical queued sends still
 * render twice after refresh and only once each before it. */
export function withoutOptimisticDuplicates(
  queued: QueuedChatMessage[],
  pending: PendingItem[],
): QueuedChatMessage[] {
  const optimisticTexts = pending
    .filter((item) => item.state !== 'failed')
    .map((item) => item.text.trim())
  return queued.filter((item) => {
    const index = optimisticTexts.indexOf(item.text.trim())
    if (index === -1) return true
    optimisticTexts.splice(index, 1)
    return false
  })
}

/**
 * Remove pending bubbles that the real transcript has now caught up with.
 * `newUserItems` are user blocks that appeared *this* render (caller diffs by
 * block id). Each new occurrence consumes the oldest matching pending entry
 * (FIFO), so duplicate prompts reconcile one-by-one. Plain turns match by text;
 * attachment turns match by their canonical upload paths because transcript
 * providers normalize raw path-prefixed prompts into image/document blocks.
 */
export function reconcilePending(
  pending: PendingItem[],
  newUserItems: TranscriptItem[],
): PendingItem[] {
  if (pending.length === 0) return pending
  const remaining = [...newUserItems]
  return pending.filter((p) => {
    const pendingPaths = p.toolPaths ?? []
    const i = remaining.findIndex((item) => {
      const itemPaths = item.toolPaths ?? []
      if (pendingPaths.length > 0) {
        return (
          itemPaths.length === pendingPaths.length &&
          pendingPaths.every((path, index) => itemPaths[index] === path)
        )
      }
      return item.text.trim() === p.text.trim()
    })
    if (i === -1) return true
    remaining.splice(i, 1)
    return false
  })
}
