import type { ChatRow } from '@podium/client-core/viewmodels'
import {
  type ConversationPendingTurn,
  pairPendingWithConversationQueue,
  projectConversationQueue,
  queuedConversationMessages,
  reconcileConversationPending,
  reconcileConversationQueue,
} from '@podium/client-core/conversation'
import type { SessionId, TranscriptItem, TranscriptTag } from '@podium/model/browser'
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
