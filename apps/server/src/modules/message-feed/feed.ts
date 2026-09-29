/**
 * THE CHAT MESSAGE FEED (POD-4764, POD-4720 §6.2) — a person's chat messages
 * and their delivery status onto the metadata feed, so every device shows the
 * same status by id and nothing polls the ledger.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CARRIES
 * ---------------------------------------------------------------------------
 * A message a user sent into a session (`from_kind = 'operator'`, `to_kind =
 * 'session'`, a user actor), while it is one of:
 *
 *  - OPEN: on its way (`stored` … `typed`), or needing its sender's attention
 *    (`failed`, `expired`, `unknown`) and not yet dismissed;
 *  - RECENTLY CONFIRMED: one of the last {@link CONFIRMED_WINDOW} to be
 *    confirmed. The chat drops a bubble when the history entry the machine
 *    named (`transcriptItem`) is on screen, so a device has to receive the
 *    confirmed record carrying that name. Removing it in the commit that
 *    confirms it would coalesce away in the funnel (per `(kind, id)`, the
 *    replica would see only the removal) and no device would ever learn the
 *    name. The window is bounded by count, not by time: a newer confirmation
 *    pushes the oldest out.
 *
 * Everything else leaves the feed — cancelled, dismissed, or pushed out of the
 * window — and the table keeps every row. The transcript is the history.
 *
 * ---------------------------------------------------------------------------
 * IT RUNS INSIDE THE WRITE
 * ---------------------------------------------------------------------------
 * `capture` is installed on the messages repository and runs inside the
 * transaction of every write to the table, with the rows the write returned.
 * The feed and the table commit or roll back together, so a status the table
 * never held never reaches a device, and no move escapes the feed — whichever
 * module made it. The publisher's own memory (which rows it carries open, the
 * window's order) changes only once that transaction commits.
 *
 * ---------------------------------------------------------------------------
 * BOOT
 * ---------------------------------------------------------------------------
 * `resolve` reconciles the full truth once, before the server listens: the
 * open set read from the table, plus the window as the feed already holds it.
 * Writes before then only note which rows they touched; `resolve` reads those
 * again in the same transaction and publishes them, so nothing written during
 * boot is missed or published stale.
 */

import {
  isMessageRecordAttention,
  type MessageRecordWire,
  messageRecordRowId,
} from '@podium/model'
import type { EntityChangeSpec, Ledger } from '@podium/sync'
import { applyAfterCommit } from '../../store/executor/executor'
import type { MessageFeedCapture } from '../../store/messages'
import type { MessageRow } from '../../store/types'

/** How many confirmed messages the feed keeps, installation-wide. Enough that
 *  every device connected when one is confirmed receives it, whatever else is
 *  confirmed in the same moment; small enough that a bootstrap stays cheap. */
export const CONFIRMED_WINDOW = 100

export interface MessageFeedDeps {
  readonly ledger: Pick<Ledger, 'capture' | 'reconcile'>
  /** What the feed already carries for kind `message` (the Authority's values). */
  readonly snapshot: () => Promise<readonly unknown[]>
  /** The open set, from the table ({@link MessagesRepository.listOpenChat}). */
  readonly listOpen: () => Promise<readonly MessageRow[]>
  /** Read rows by id (boot only: the rows touched before the feed went live). */
  readonly getMessages: (ids: readonly string[]) => Promise<readonly MessageRow[]>
  /** One transaction on the store the messages table lives in. */
  readonly transact: <T>(fn: () => Promise<T>) => Promise<T>
  /** Defaults to {@link CONFIRMED_WINDOW}. */
  readonly confirmedWindow?: number
}

/** The feed record for a row, or null when the row is not a person's chat message. */
export function messageRecordOf(row: MessageRow): MessageRecordWire | null {
  if (row.fromKind !== 'operator' || row.toKind !== 'session' || !row.toId) return null
  // The person it was sent for — the same half of the attribution pair the
  // mail commands' sender check reads.
  const actor = row.attribution?.actor
  const senderUserId = row.attribution?.onBehalfOf ?? (actor?.kind === 'user' ? actor.id : null)
  if (!senderUserId) return null
  return {
    id: row.id,
    // RETAINED BRAND CAST: `toId` is a SessionId whenever `toKind` is 'session'.
    sessionId: row.toId as MessageRecordWire['sessionId'],
    senderUserId,
    body: row.body,
    ...(row.attachments?.length
      ? {
          attachments: row.attachments.map(({ filename, mediaType, kind }) => ({
            filename,
            mediaType,
            kind,
          })),
        }
      : {}),
    createdAt: row.createdAt,
    status: row.deliveryStatus,
    ...(row.deliveryStatus === 'failed' && row.deliveryDeferredReason
      ? { reason: row.deliveryDeferredReason }
      : {}),
    ...(row.transcriptItem ? { transcriptItem: row.transcriptItem } : {}),
  }
}

const rowIdOf = (record: MessageRecordWire): string =>
  messageRecordRowId({
    sessionId: record.sessionId,
    senderUserId: record.senderUserId,
    messageId: record.id,
  })

/** On its way, or waiting for its sender to look at it. */
function isOpen(row: MessageRow): boolean {
  if (row.deliveryStatus === 'confirmed' || row.deliveryStatus === 'cancelled') return false
  if (isMessageRecordAttention(row.deliveryStatus) && row.noticeDismissedAt) return false
  return true
}

const isRecord = (value: unknown): value is MessageRecordWire =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
  typeof (value as { senderUserId?: unknown }).senderUserId === 'string'

export class MessageFeedPublisher {
  /** Row ids carried as open. */
  private open = new Set<string>()
  /** Row ids carried as confirmed, oldest first. */
  private window: string[] = []
  private live = false
  /** Message ids written before the feed went live. */
  private readonly touchedBeforeLive = new Set<string>()
  private resolving: Promise<void> | undefined
  private readonly windowSize: number

  constructor(private readonly deps: MessageFeedDeps) {
    this.windowSize = deps.confirmedWindow ?? CONFIRMED_WINDOW
  }

  /** The repository's capture port. Runs inside the write's transaction. */
  readonly capture: MessageFeedCapture = async (rows) => {
    if (!this.live) {
      for (const row of rows) this.touchedBeforeLive.add(row.id)
      return
    }
    await this.publish(rows)
  }

  /** Reconcile the full truth once, then go live. */
  async resolve(): Promise<void> {
    this.resolving ??= this.reconcile()
    await this.resolving
  }

  private async reconcile(): Promise<void> {
    const carried = (await this.deps.snapshot()).filter(isRecord)
    await this.deps.transact(async () => {
      const truth = new Map<string, MessageRecordWire>()
      const open = new Set<string>()
      for (const row of await this.deps.listOpen()) {
        const record = messageRecordOf(row)
        if (record === null) continue
        const id = rowIdOf(record)
        truth.set(id, record)
        open.add(id)
      }
      const window = carried
        .filter((record) => record.status === 'confirmed' && !open.has(rowIdOf(record)))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .slice(-this.windowSize)
      for (const record of window) truth.set(rowIdOf(record), record)
      await this.deps.ledger.reconcile(
        'message',
        [...truth].map(([id, value]) => ({ id, value })),
      )
      this.open = open
      this.window = window.map(rowIdOf)
      this.live = true
      const touched = [...this.touchedBeforeLive]
      this.touchedBeforeLive.clear()
      if (touched.length > 0) await this.publish(await this.deps.getMessages(touched))
    })
  }

  /** The changes one write makes to the feed; memory follows on commit. */
  private async publish(rows: readonly MessageRow[]): Promise<void> {
    const specs: EntityChangeSpec[] = []
    const opened: string[] = []
    const closed: string[] = []
    const confirmed: string[] = []
    // Within one write, what this write has already decided counts as carried.
    const openNow = new Set(this.open)
    const windowNow = [...this.window]
    for (const row of rows) {
      const record = messageRecordOf(row)
      if (record === null) continue
      const id = rowIdOf(record)
      if (isOpen(row)) {
        specs.push({ entity: 'message', id, op: 'upsert', value: record })
        openNow.add(id)
        opened.push(id)
        continue
      }
      const wasOpen = openNow.delete(id)
      if (wasOpen) closed.push(id)
      const inWindow = windowNow.includes(id)
      // Confirmed now, having been carried open: it enters the window. A row
      // confirmed long ago that a later stamp touches (a read, an ack) is
      // history and stays out; one still in the window keeps its place and
      // gains what the stamp added (the history entry's name).
      if (record.status === 'confirmed' && (inWindow || wasOpen)) {
        specs.push({ entity: 'message', id, op: 'upsert', value: record })
        if (!inWindow) {
          windowNow.push(id)
          confirmed.push(id)
        }
        continue
      }
      // Cancelled, dismissed, or confirmed out of sight: it leaves the feed. A
      // removal of a row the feed never carried is dropped by the log.
      if (wasOpen) specs.push({ entity: 'message', id, op: 'remove' })
    }
    const evicted = windowNow.length > this.windowSize
      ? windowNow.slice(0, windowNow.length - this.windowSize)
      : []
    for (const id of evicted) specs.push({ entity: 'message', id, op: 'remove' })
    if (specs.length === 0) return
    await this.deps.ledger.capture(specs)
    applyAfterCommit(() => {
      for (const id of opened) this.open.add(id)
      for (const id of closed) this.open.delete(id)
      for (const id of confirmed) if (!this.window.includes(id)) this.window.push(id)
      if (evicted.length > 0) {
        const gone = new Set(evicted)
        this.window = this.window.filter((id) => !gone.has(id))
      }
    }, 'message-feed')
  }
}
