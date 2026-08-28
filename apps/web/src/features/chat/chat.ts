import { type ChatRow, insertInCursorOrder } from '@podium/client-core/viewmodels'
import type { SessionId, TranscriptItem, TranscriptTag } from '@podium/model/browser'

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

/** Identity key for dedup/merge: the opaque cursor when present (stable across
 *  re-reads), else the synthesized `id` (a few items have no cursor). */
export function itemKey(item: TranscriptItem): string {
  return item.cursor ?? item.id
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
    if (at === -1) continue // a duplicate WITHIN this delta — already taken as an addition
    if (at !== undefined) {
      const existing = (next ?? prev)[at]
      if (existing !== undefined && !sameItemContent(existing, it)) {
        if (!next) next = [...prev]
        next[at] = it
      }
    } else {
      indexByKey.set(key, -1)
      additions.push(it)
    }
  }
  if (!next && additions.length === 0) return prev
  if (additions.length === 0) return next ?? prev
  const out = [...(next ?? prev)]
  for (const item of additions) insertInCursorOrder(out, item)
  return out
}

/** Cheap content equality for the fields a re-emitted (growing) record changes —
 *  lets mergeByCursor skip a re-render when a same-cursor re-emit is identical. */
function sameItemContent(a: TranscriptItem, b: TranscriptItem): boolean {
  return a.text === b.text && a.toolResult === b.toolResult && a.toolInput === b.toolInput
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
    if (itemKey(x) !== itemKey(y) || !sameItemContent(x, y)) return false
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
  if (page.length === 0) return page
  const heldKeys = new Set(held.map(itemKey))
  return page.filter((it) => !heldKeys.has(itemKey(it)))
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
 *  State: 'sending' (in flight) → 'sent' (delivered; echo just hasn't tailed back
 *  yet, so render it as a plain bubble) or 'failed' (the send itself rejected). */
export interface PendingItem {
  id: string
  /** Client-minted idempotency key; queued ledger rows use this as their id. */
  deliveryId?: string
  text: string
  at: number
  state: 'sending' | 'queued' | 'sent' | 'failed' | 'interrupted'
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

/** A human chat message durably held in the unified message ledger until the
 * agent reaches its next turn boundary. These rows are separate from the
 * sessions queued_messages outbox, so ChatView must restore them explicitly. */
export interface QueuedChatMessage {
  id: string
  text: string
  at: number
  /** THE CLI HAS IT (POD-1242). The ledger stamps this when the bytes cross into
   * the harness, which is BEFORE the agent takes them: a busy Claude Code parks
   * typed input in its own composer queue until the running turn ends, and shows
   * it to that turn on the way. So an injected row is no longer waiting on us
   * unless the harness reports an explicit interrupt. Null while the row is
   * still only promised. */
  injectedAt: number | null
}

/** A local row promoted with its durable ledger identity without changing the
 * presentation key that React mounted when the operator pressed Send. */
export interface ProjectedPendingItem extends PendingItem {
  durable?: QueuedChatMessage
}

const QUEUE_CLOCK_SKEW_MS = 5_000
const QUEUE_ACK_WINDOW_MS = 60_000

/** Pair local bubbles with ledger rows once, using content plus the send-time
 * window. An older identical queued prompt is not the durable identity of a new
 * send and must remain independently retractable. */
export function pairPendingWithQueued(
  pending: PendingItem[],
  queued: QueuedChatMessage[],
): { pending: ProjectedPendingItem[]; queued: QueuedChatMessage[] } {
  const unmatched = [...queued]
  const projected = pending.map((item): ProjectedPendingItem => {
    if (item.state === 'failed') return item
    if (item.deliveryId) {
      const exactIndex = unmatched.findIndex((message) => message.id === item.deliveryId)
      if (exactIndex === -1) return item
      const [durable] = unmatched.splice(exactIndex, 1)
      return durable ? { ...item, durable } : item
    }
    let bestIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (const [index, message] of unmatched.entries()) {
      if (message.text.trim() !== item.text.trim()) continue
      if (message.at < item.at - QUEUE_CLOCK_SKEW_MS) continue
      if (message.at > item.at + QUEUE_ACK_WINDOW_MS) continue
      const distance = Math.abs(message.at - item.at)
      if (distance < bestDistance) {
        bestIndex = index
        bestDistance = distance
      }
    }
    if (bestIndex === -1) return item
    const [durable] = unmatched.splice(bestIndex, 1)
    return durable ? { ...item, durable } : item
  })
  return { pending: projected, queued: unmatched }
}

export function queuedOperatorMessages(rows: unknown, sessionId: SessionId): QueuedChatMessage[] {
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
      injectedAt: typeof row.injectedAt === 'string' ? Date.parse(row.injectedAt) || null : null,
    }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

/** Collapse the optimistic bubble, durable ledger row, and transcript echo into
 * one visible message. Reconciliation effects can lag a paint; this projection
 * is synchronous so that lag never becomes a duplicate frame. */
export function projectOptimisticMessages(
  pending: PendingItem[],
  queued: QueuedChatMessage[],
  transcript: TranscriptItem[],
): { pending: ProjectedPendingItem[]; queued: QueuedChatMessage[] } {
  const paired = pairPendingWithQueued(pending, queued)
  const logical: Array<{
    pending?: ProjectedPendingItem
    queued?: QueuedChatMessage
    text: string
    at: number
    toolPaths?: string[]
  }> = []

  for (const item of paired.pending) {
    logical.push({
      pending: item,
      queued: item.durable,
      text: item.text.trim(),
      at: item.at,
      ...(item.toolPaths ? { toolPaths: item.toolPaths } : {}),
    })
  }
  for (const message of paired.queued) {
    logical.push({ queued: message, text: message.text.trim(), at: message.at })
  }
  logical.sort((a, b) => a.at - b.at)

  const available = transcript.filter((item) => item.role === 'user')
  const visible = logical.filter((message) => {
    const index = available.findIndex((item) => {
      const at = item.ts ? Date.parse(item.ts) : Number.NaN
      // Unknown time cannot prove that a historical identical prompt is this
      // send. Newly arrived ids are reconciled separately by useChatSend.
      return Number.isFinite(at) && at >= message.at - 5_000 && messageMatchesItem(message, item)
    })
    if (index === -1) return true
    available.splice(index, 1)
    return false
  })

  return {
    pending: visible.flatMap((message) => (message.pending ? [message.pending] : [])),
    queued: visible.flatMap((message) =>
      !message.pending && message.queued ? [message.queued] : [],
    ),
  }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

function textCarriesPaths(text: string, paths: readonly string[]): boolean {
  if (paths.length === 0) return false
  const lines = new Set(text.split('\n').map((line) => line.trim()))
  return paths.every((path) => lines.has(path))
}

/** One content matcher for local, ledger, and provider-normalized turns. */
function messageMatchesItem(
  message: Pick<PendingItem, 'text' | 'toolPaths' | 'acceptsAppendedBrief'>,
  item: TranscriptItem,
): boolean {
  const itemText = item.text.trim()
  const messageText = message.text.trim()
  if (
    message.acceptsAppendedBrief === true &&
    (itemText === messageText || itemText.startsWith(`${messageText}\n\n`))
  ) {
    return true
  }
  const messagePaths = message.toolPaths ?? []
  const itemPaths = item.toolPaths ?? []
  if (messagePaths.length > 0) {
    if (itemPaths.length > 0) return samePaths(messagePaths, itemPaths)
    return textCarriesPaths(item.text, messagePaths)
  }
  if (itemPaths.length > 0) return textCarriesPaths(message.text, itemPaths)
  return itemText === messageText
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
    const i = remaining.findIndex((item) => messageMatchesItem(p, item))
    if (i === -1) return true
    remaining.splice(i, 1)
    return false
  })
}

/** Newly observed transcript ids are sufficient freshness proof even when a
 * provider omitted its timestamp. Remove their matching durable ledger rows so
 * an unknown timestamp never creates a long-lived duplicate after reload. */
export function reconcileQueued(
  queued: QueuedChatMessage[],
  newUserItems: TranscriptItem[],
): QueuedChatMessage[] {
  if (queued.length === 0) return queued
  const remaining = [...newUserItems]
  return queued.filter((message) => {
    const i = remaining.findIndex((item) => messageMatchesItem(message, item))
    if (i === -1) return true
    remaining.splice(i, 1)
    return false
  })
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
