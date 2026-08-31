import type { ChatRow } from '@podium/client-core/viewmodels'
import {
  freshOlderTranscriptPage,
  mergeTranscriptFrame,
  reconcileTranscriptSnapshot,
  sameTranscriptItem,
} from '@podium/client-core/transcript'
import {
  type ConversationPendingTurn,
  pairPendingWithConversationQueue,
  projectConversationQueue,
  queuedConversationMessages,
  reconcileConversationPending,
  reconcileConversationQueue,
} from '@podium/client-core/conversation'
import type { SessionId, TranscriptItem, TranscriptTag } from '@podium/model/browser'
import { decodeCursor, streamIdOfCursor } from '@podium/transcript/browser'
import { deadLetterDeliveryLine } from '../messages/message-ledger'

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
  isInteractiveTool,
  mcpLabel,
  mcpParts,
  pairToolResults,
  resultPreview,
  type SingleRow,
  type ToolBatchRow,
  type ToolVerdict,
  toolBatchTitle,
  toolCallPhrase,
  toolRunElapsedMs,
  toolRunFailures,
  toolSubject,
  toolVerdict,
} from '@podium/client-core/viewmodels'

/**
 * Maximum number of transcript paths retained for terminal link matching.
 *
 * The transcript window can be paged much deeper than the rendered chat, and a
 * long-running session may mention an unbounded number of files. Keeping a
 * bounded recent index prevents path metadata from becoming a second, hidden
 * transcript. Keep more entries than the terminal's 5,000-line scrollback can
 * display so a path still visible in the buffer is not evicted merely because
 * the transcript mentioned more than 4,096 unique paths.
 */
export const FILE_LINK_PATH_CAP = 8_192

/**
 * Incrementally owns the path set consumed by the terminal file-link provider.
 *
 * `knownPaths` deliberately exposes a read-only view with stable identity. The
 * provider only performs membership/iteration reads, so handing it this set
 * avoids copying the full history for every transcript delta. Repeated paths
 * are moved to the newest end before the oldest entries are evicted.
 */
export class FileLinkPathIndex {
  private readonly paths = new Set<string>()

  constructor(private readonly cap = FILE_LINK_PATH_CAP) {
    if (!Number.isInteger(cap) || cap < 1)
      throw new RangeError('file-link path cap must be positive')
  }

  get knownPaths(): ReadonlySet<string> {
    return this.paths
  }

  reset(): void {
    this.paths.clear()
  }

  add(delta: readonly TranscriptItem[]): void {
    for (const item of delta) {
      for (const path of item.toolPaths ?? []) {
        if (path.length === 0) continue
        // Set insertion order is our cheap LRU: refreshing a path keeps a
        // frequently mentioned file alive while the cap is under pressure.
        this.paths.delete(path)
        this.paths.add(path)
      }
    }
    while (this.paths.size > this.cap) {
      const oldest = this.paths.values().next().value
      if (oldest === undefined) break
      this.paths.delete(oldest)
    }
  }
}

/** Identity key for dedup/merge: the transcript contract's stream identity.
 *
 * A full cursor is a POSITION, not always an item identity: OpenCode stamps its
 * mutable `timeUpdated` into the offset, so the same provider part has a new
 * cursor when hydration and the live subscription observe it at different
 * moments. The shared contract zeros that mutable offset while retaining the
 * provider part/sub-item identity; cursor-less families keep using `id`. */
export function itemKey(item: TranscriptItem): string {
  if (item.cursor === undefined) return item.id
  return cursorKey(item.cursor)
}

/** Offset-zeroed identity is safe only when the provider supplied a stable UUID.
 * A null UUID means the cursor is purely positional, so its full offset remains
 * part of the identity or distinct records at the same file/sub-index collapse. */
function cursorKey(cursor: string): string {
  const parts = decodeCursor(cursor)
  return parts?.uuid != null ? (streamIdOfCursor(cursor) ?? cursor) : cursor
}

/**
 * Merge live-delta items into the held list, keyed by cursor (or id). A delta item
 * whose key is already present REPLACES the held one in place (preserving its
 * position); a new key lands at its CURSOR POSITION — normally the tail, since
 * deltas are normally newer. Order preserved.
 * Returns `prev` unchanged (referentially) when nothing actually changed, so a
 * no-op delta doesn't trigger a re-render.
 *
 * Replace-not-skip is load-bearing: the live tailer flushes an unterminated
 * trailing record immediately (so a final message surfaces promptly), then
 * re-emits it at the SAME cursor once its newline lands with the complete content.
 * A skip-on-seen (first-wins) merge would pin the earlier, possibly truncated
 * version; replacing lets the completed record supersede it.
 *
 * Position-not-append is load-bearing too [POD-341]: a delta is NOT always newer
 * than the held window. The server replays its whole per-session transcript cache
 * when a (re)subscribing client's `since` cursor isn't in it — after a transcript
 * file roll or a socket drop that is the common case — so a frame can carry items
 * OLDER than the tail we already hold. Appending those put the superagent's answer
 * ABOVE the prompt that produced it. `insertInCursorOrder` (shared with the mobile
 * merge) keeps the held window in transcript order however the frames arrive.
 */
export function mergeByCursor(prev: TranscriptItem[], delta: TranscriptItem[]): TranscriptItem[] {
  return mergeTranscriptFrame(prev, delta)
}

/**
 * Whether two held windows are the same transcript, item for item — the guard
 * that makes a REFRESH free (POD-701).
 *
 * `reconcileReset` returns a fresh array on every disk re-read even when the
 * bytes are identical, and a fresh array re-derives blocks, re-derives rows and
 * re-renders every mounted block view. That was affordable while re-reads only
 * happened on session switch; it is not affordable now that the window also
 * refreshes on a liveness signal, so the caller compares first and keeps the
 * old array when nothing moved. Same identity key + same mutable content is
 * exactly the equality `mergeByCursor` already treats as "no change".
 */
export function sameItems(a: readonly TranscriptItem[], b: readonly TranscriptItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!x || !y) return false
    if (itemKey(x) !== itemKey(y) || !sameTranscriptItem(x, y)) return false
  }
  return true
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
  const tailKey = snapshotTail !== undefined ? cursorKey(snapshotTail) : undefined
  const tailIdx = tailKey !== undefined ? prev.findIndex((it) => itemKey(it) === tailKey) : -1
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

/**
 * The genuinely-older part of a back-page, ready to PREPEND [POD-341].
 *
 * An anchored `before` read can come back as the NEWEST window instead of an
 * older page: the disk reader falls back to the default window when the anchor's
 * cursor names a transcript file that has rolled away (packages/transcript
 * slice.ts — "losing the position is safe"), which is exactly what a client
 * holding a pre-roll head cursor asks for. Prepending that window put newer items
 * above older ones. Items the window already holds can never be "earlier", so
 * filtering against them keeps the legitimate one-item paging seam working and
 * turns the fallback window into an empty page (the caller then stops paging).
 */
export function freshOlderPage(page: TranscriptItem[], held: TranscriptItem[]): TranscriptItem[] {
  return freshOlderTranscriptPage(page, held)
}

// Transcript SEARCH moved to the chat slice (`blockMatches` / `searchBlocks` in
// @podium/client-core/viewmodels): it is pure, it is the same question mobile
// asks, and the row that renders a hit is derived beside it, so the counter, the
// scroll jump and the dimming cannot disagree about what a match is.

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
 *  State: 'sending' (in flight) → 'sent' (accepted; echo just has not tailed back
 *  yet, so render it as a plain bubble) or 'failed' (the send or provider rejected it). */
export interface PendingItem {
  id: string
  /** Client-minted idempotency key; queued ledger rows use this as their id. */
  deliveryId?: string
  text: string
  at: number
  state: 'sending' | 'queued' | 'sent' | 'failed' | 'interrupted'
  /** 1-based position returned by the authority when this send enters its FIFO. */
  queuePosition?: number
  /** The server/provider reason for a failed optimistic send. */
  failure?: string
  tags?: TranscriptTag[]
  /** Uploaded paths encoded into the submitted prompt. Transcript providers
   * normalize those paths out of `text`, so they are the stable identity used
   * to reconcile attachment-bearing turns. */
  toolPaths?: string[]
  /** The issue-start contract may append its technical brief to the human's
   * description before the first turn reaches the transcript. Only that seeded
   * first-turn bubble may accept the longer authoritative echo. */
  acceptsAppendedBrief?: boolean
}

/** Mark only an optimistic send that is still in flight as failed. A `sent`
 * bubble has already crossed the send boundary and must not be rewritten as
 * "not delivered" merely because a later turn failed. */
export function markPendingSendingFailed(pending: PendingItem[], failure: string): PendingItem[] {
  let changed = false
  const next = pending.map((item) => {
    if (item.state !== 'sending') return item
    changed = true
    return { ...item, state: 'failed' as const, failure }
  })
  return changed ? next : pending
}

/** Mark the exact optimistic send delivered synchronously by the authority.
 * This closes the window where a provider failure could arrive after the bytes
 * reached the agent but before a transcript echo changed `sending` to `sent`. */
export function markPendingSendingDelivered(pending: PendingItem[], id: string): PendingItem[] {
  let changed = false
  const next = pending.map((item) => {
    if (item.id !== id || item.state !== 'sending') return item
    changed = true
    return { ...item, state: 'sent' as const }
  })
  return changed ? next : pending
}

/** A human chat message durably held in the unified message ledger until the
 * agent reaches its next turn boundary. These rows are separate from the
 * sessions queued_messages outbox, so ChatView must restore them explicitly. */
export interface QueuedChatMessage {
  id: string
  text: string
  at: number
  /** Current 1-based position in the recipient session FIFO at reload time. */
  queuePosition?: number
  /** THE CLI HAS IT (POD-1242). The ledger stamps this when the bytes cross into
   * the harness, which is BEFORE the agent takes them: a busy Claude Code parks
   * typed input in its own composer queue until the running turn ends, and shows
   * it to that turn on the way. So an injected row is no longer waiting on us
   * unless the harness reports an explicit interrupt. Null while the row is
   * still only promised. */
  injectedAt: number | null
}

/** A terminal operator send that never reached this session. Unlike an
 * optimistic failure, this row survives navigation and reload in the message
 * ledger, so the transcript must restore it explicitly. */
export interface DeadLetteredChatMessage {
  id: string
  text: string
  at: number
  failure: string
}

/** A local row promoted with its durable ledger identity without changing the
 * presentation key that React mounted when the operator pressed Send. */
export interface ProjectedPendingItem extends PendingItem {
  durable?: QueuedChatMessage
}

function conversationPending(item: PendingItem): ConversationPendingTurn {
  return {
    ...item,
    deliveryId: item.deliveryId ?? item.id,
    wire: item.text,
    kind: 'message',
  }
}

function attachDurableQueueRow(
  item: PendingItem,
  durable: QueuedChatMessage,
): ProjectedPendingItem {
  const projected: ProjectedPendingItem = { ...item, durable }
  if (durable.queuePosition === undefined) delete projected.queuePosition
  else projected.queuePosition = durable.queuePosition
  return projected
}

/** Pair local bubbles with ledger rows once, using content plus the send-time
 * window. An older identical queued prompt is not the durable identity of a new
 * send and must remain independently retractable. */
export function pairPendingWithQueued(
  pending: PendingItem[],
  queued: QueuedChatMessage[],
): { pending: ProjectedPendingItem[]; queued: QueuedChatMessage[] } {
  const projected = pairPendingWithConversationQueue(pending.map(conversationPending), queued)
  const original = new Map(pending.map((item) => [item.id, item]))
  return {
    pending: projected.pending.map((item) =>
      item.durable
        ? attachDurableQueueRow(original.get(item.id) ?? (item as PendingItem), item.durable)
        : ((original.get(item.id) ?? item) as ProjectedPendingItem),
    ),
    queued: projected.queued,
  }
}

export function queuedOperatorMessages(rows: unknown, sessionId: SessionId): QueuedChatMessage[] {
  return queuedConversationMessages(rows, sessionId)
}

export function deadLetteredOperatorMessages(
  rows: unknown,
  sessionId: SessionId,
): DeadLetteredChatMessage[] {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .filter(
      (row) =>
        row.from === 'operator' &&
        row.to === `session:${sessionId}` &&
        row.status === 'dead_letter' &&
        typeof row.id === 'string' &&
        typeof row.body === 'string' &&
        typeof row.createdAt === 'string',
    )
    .map((row) => ({
      id: row.id as string,
      text: row.body as string,
      at: Date.parse(row.createdAt as string) || 0,
      failure: deadLetterDeliveryLine(
        typeof row.deliveryDeferredReason === 'string' ? row.deliveryDeferredReason : null,
      ),
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

/** Collapse the optimistic bubble, durable ledger row, and transcript echo into
 * one visible message. Reconciliation effects can lag a paint; this projection
 * is synchronous so that lag never becomes a duplicate frame. */
export function projectOptimisticMessages(
  pending: PendingItem[],
  queued: QueuedChatMessage[],
  transcript: TranscriptItem[],
): { pending: ProjectedPendingItem[]; queued: QueuedChatMessage[] } {
  const projected = projectConversationQueue(pending.map(conversationPending), queued, transcript)
  const original = new Map(pending.map((item) => [item.id, item]))
  return {
    pending: projected.pending.map((item) => ({
      ...(original.get(item.id) ?? item),
      ...(item.durable ? { durable: item.durable } : {}),
    })),
    queued: projected.queued,
  }
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
  const remaining = new Set(
    reconcileConversationPending(pending.map(conversationPending), newUserItems).map(
      (item) => item.id,
    ),
  )
  return remaining.size === pending.length
    ? pending
    : pending.filter((item) => remaining.has(item.id))
}

/** Newly observed transcript ids are sufficient freshness proof even when a
 * provider omitted its timestamp. Remove their matching durable ledger rows so
 * an unknown timestamp never creates a long-lived duplicate after reload. */
export function reconcileQueued(
  queued: QueuedChatMessage[],
  newUserItems: TranscriptItem[],
): QueuedChatMessage[] {
  return reconcileConversationQueue(queued, newUserItems)
}

/** Return only user rows appended after the previously observed live tail.
 * Unseen ids before that boundary came from history paging, not delivery. */
export function tailAppendedUserItems(
  userItems: TranscriptItem[],
  previousTailId: string | null,
  baselineReady: boolean,
): TranscriptItem[] {
  if (!baselineReady) return []
  if (previousTailId === null) return userItems
  const previousTailIndex = userItems.findIndex((item) => item.id === previousTailId)
  return previousTailIndex === -1 ? [] : userItems.slice(previousTailIndex + 1)
}
