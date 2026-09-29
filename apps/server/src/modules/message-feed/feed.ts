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
 *  - RECENTLY CONFIRMED: one of the last {@link CONFIRMED_PER_SESSION}
 *    confirmed in ITS SESSION, while that session is a LIVE CONVERSATION. The
 *    chat drops a bubble when the history entry the machine named
 *    (`transcriptItem`) is on screen, so a device has to receive the confirmed
 *    record carrying that name. Removing it in the commit that confirms it
 *    would coalesce away in the funnel (per `(kind, id)`, the replica would see
 *    only the removal) and no device would ever learn the name. Each session
 *    has its own window, bounded by count, not by time: a newer confirmation in
 *    the same session pushes that session's oldest out, and a busy session
 *    never pushes out another's (POD-4811).
 *
 * Everything else leaves the feed — cancelled, dismissed, or pushed out of its
 * window — and the table keeps every row. The transcript is the history. A
 * device that was away while its message was confirmed and pushed out never
 * sees it on the feed; it asks for its own messages by id instead
 * (`mail.records`), which reads the table.
 *
 * ---------------------------------------------------------------------------
 * A SESSION THAT ENDS TAKES ITS WINDOW WITH IT (POD-4814)
 * ---------------------------------------------------------------------------
 * A window exists for the bubbles of a conversation someone may be typing
 * into. A session stops being one when it EXITS, is ARCHIVED, is DELETED
 * (tombstoned; its feed row is removed) or is PURGED (its row is gone) —
 * {@link isLiveConversation}, read from the sessions table. Hibernated and
 * reconnecting sessions are still conversations: a message resumes them.
 * When one ends, every confirmed record of its window leaves the feed, and a
 * confirmation arriving for a session that is not live does not open a window
 * at all — it leaves like one pushed out. Without this, every session ever
 * messaged would keep its window forever and what each device replicates
 * would grow with the whole history. With it, the feed carries at most
 * LIVE sessions × {@link CONFIRMED_PER_SESSION} confirmed records, plus the
 * open set.
 *
 * Open records STAY, whatever their session does. One still on its way settles
 * by its own lifecycle (the daemon, expiry, a resume); one waiting for its
 * sender's attention (`failed`, `expired`, `unknown`) is a notice the sender
 * must be able to see and dismiss, and an ended session is exactly where one
 * is likely. Each leaves when it settles or is dismissed, as anywhere else.
 *
 * The trigger is the feed's own record of the session: every committed
 * `session` change passes {@link MessageFeedPublisher.watchSessions} (the
 * ledger's `onAppended`, after the outermost commit). One that says the
 * session ended schedules a retire, which re-reads the table in its own
 * transaction, so a session resumed in between keeps its window, and a crash
 * before the retire is healed by the next boot, whose reconcile keeps windows
 * only for live sessions. A device that held a record the retire removes sees
 * the removal; one that was still showing that message's bubble settles it by
 * id (`mail.records`) when it next starts or reconnects.
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
 * open set read from the table, plus the windows as the feed already holds them
 * for sessions that are still live conversations, in one transaction that then
 * turns the capture on. A write before that is
 * already in the table the reconcile reads, so the capture ignores it — and
 * rows that predate the feed altogether (an upgrade) are carried the same way.
 */

import { createLogger } from '@podium/logger'
import { isMessageRecordAttention, type MessageRecordWire, messageRecordRowId } from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import type { EntityChangeSpec, Ledger } from '@podium/sync'
import { applyAfterCommit } from '../../store/executor/executor'
import type { MessageFeedCapture } from '../../store/messages'
import type { SessionsRepository } from '../../store/sessions'
import type { MessageRow, SessionRow } from '../../store/types'

const log = createLogger('server:message-feed')

/** How many confirmed messages the feed keeps per session. Enough that every
 *  device connected when one is confirmed receives it, whatever else that
 *  session confirms in the same moment; small enough that a bootstrap stays
 *  cheap. A device away for longer catches up by id. */
export const CONFIRMED_PER_SESSION = 20

export interface MessageFeedDeps {
  readonly ledger: Pick<Ledger, 'capture' | 'reconcile' | 'onAppended'>
  /** Which sessions are still live conversations ({@link isLiveConversation}). */
  readonly sessions: Pick<SessionsRepository, 'getSessions'>
  /** What the feed already carries for kind `message` (the Authority's values). */
  readonly snapshot: () => Promise<readonly unknown[]>
  /** The open set, from the table ({@link MessagesRepository.listOpenChat}). */
  readonly listOpen: () => Promise<readonly MessageRow[]>
  /** One transaction on the store the messages table lives in. */
  readonly transact: <T>(fn: () => Promise<T>) => Promise<T>
  /** Defaults to {@link CONFIRMED_PER_SESSION}. */
  readonly confirmedPerSession?: number
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
    ...(row.retractRequestedAt ? { retractRequestedAt: row.retractRequestedAt } : {}),
    ...(row.noticeDismissedAt ? { noticeDismissedAt: row.noticeDismissedAt } : {}),
  }
}

/** Someone may still be typing into it: not exited, archived, deleted or purged. */
export function isLiveConversation(
  session: Pick<SessionRow, 'status' | 'archived' | 'deletedAt'> | undefined,
): boolean {
  return (
    session !== undefined && session.status !== 'exited' && !session.archived && !session.deletedAt
  )
}

/** A committed `session` change that says the session is no longer one. */
function endsConversation(change: MetadataChange): boolean {
  if (change.entity !== 'session') return false
  if (change.op === 'remove') return true
  return change.op === 'upsert' && !isLiveConversation(change.value)
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

const byCreatedAt = (a: MessageRecordWire, b: MessageRecordWire): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0

export class MessageFeedPublisher {
  /** Row ids carried as open. */
  private open = new Set<string>()
  /** Row ids carried as confirmed, per LIVE session, oldest first. A session
   *  with an entry here was live when it got one; one that ends loses it. */
  private windows = new Map<string, string[]>()
  /** Retires run one after another, each in its own transaction. */
  private retiring: Promise<void> = Promise.resolve()
  private live = false
  private resolving: Promise<void> | undefined
  private readonly perSession: number

  constructor(private readonly deps: MessageFeedDeps) {
    this.perSession = deps.confirmedPerSession ?? CONFIRMED_PER_SESSION
    deps.ledger.onAppended(this.watchSessions)
  }

  /** The repository's capture port. Runs inside the write's transaction. */
  readonly capture: MessageFeedCapture = async (rows) => {
    // Before `resolve`, the reconcile's read of the table will carry it.
    if (this.live) await this.publish(rows)
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
      const confirmed = new Map<string, MessageRecordWire[]>()
      for (const record of carried) {
        if (record.status !== 'confirmed' || open.has(rowIdOf(record))) continue
        const session = confirmed.get(record.sessionId) ?? []
        session.push(record)
        confirmed.set(record.sessionId, session)
      }
      const live = await this.liveOf([...confirmed.keys()])
      const windows = new Map<string, string[]>()
      for (const [sessionId, records] of confirmed) {
        // An ended session's window stays out, and the reconcile removes it.
        if (!live.has(sessionId)) continue
        const window = records.sort(byCreatedAt).slice(-this.perSession)
        for (const record of window) truth.set(rowIdOf(record), record)
        windows.set(sessionId, window.map(rowIdOf))
      }
      await this.deps.ledger.reconcile(
        'message',
        [...truth].map(([id, value]) => ({ id, value })),
      )
      this.open = open
      this.windows = windows
      this.live = true
    })
  }

  /** The changes one write makes to the feed; memory follows on commit. */
  private async publish(rows: readonly MessageRow[]): Promise<void> {
    const specs: EntityChangeSpec[] = []
    const opened: string[] = []
    const closed: string[] = []
    /** Per session touched: the ids confirming into its window, in order. */
    const confirmed = new Map<string, string[]>()
    // Within one write, what this write has already decided counts as carried.
    const openNow = new Set(this.open)
    const windowsNow = new Map<string, string[]>()
    /** Asked once per write, only of a session with no window yet. */
    const liveNow = new Map<string, boolean>()
    const isLive = async (sessionId: string): Promise<boolean> => {
      if (this.windows.has(sessionId)) return true
      let live = liveNow.get(sessionId)
      if (live === undefined) {
        live = (await this.liveOf([sessionId])).has(sessionId)
        liveNow.set(sessionId, live)
      }
      return live
    }
    const windowOf = (sessionId: string): string[] => {
      let window = windowsNow.get(sessionId)
      if (window === undefined) {
        window = [...(this.windows.get(sessionId) ?? [])]
        windowsNow.set(sessionId, window)
      }
      return window
    }
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
      const window = windowOf(record.sessionId)
      const inWindow = window.includes(id)
      // Confirmed now, having been carried open, in a live conversation: it
      // enters its session's window. A row confirmed long ago that a later
      // stamp touches (a read, an ack) is history and stays out; one still in
      // the window keeps its place and gains what the stamp added (the history
      // entry's name). A session that has ended opens no window.
      if (
        record.status === 'confirmed' &&
        (inWindow || (wasOpen && (await isLive(record.sessionId))))
      ) {
        specs.push({ entity: 'message', id, op: 'upsert', value: record })
        if (!inWindow) {
          window.push(id)
          confirmed.set(record.sessionId, [...(confirmed.get(record.sessionId) ?? []), id])
        }
        continue
      }
      // Cancelled, dismissed, confirmed out of sight or in a session that has
      // ended: it leaves the feed. A
      // removal of a row the feed never carried is dropped by the log.
      if (wasOpen) specs.push({ entity: 'message', id, op: 'remove' })
    }
    /** Per session: the oldest pushed out by this write's confirmations. */
    const evicted = new Map<string, string[]>()
    for (const [sessionId, window] of windowsNow) {
      if (window.length <= this.perSession) continue
      const gone = window.slice(0, window.length - this.perSession)
      evicted.set(sessionId, gone)
      for (const id of gone) specs.push({ entity: 'message', id, op: 'remove' })
    }
    if (specs.length === 0) return
    await this.deps.ledger.capture(specs)
    applyAfterCommit(() => {
      for (const id of opened) this.open.add(id)
      for (const id of closed) this.open.delete(id)
      for (const [sessionId, ids] of confirmed) {
        const window = this.windows.get(sessionId) ?? []
        for (const id of ids) if (!window.includes(id)) window.push(id)
        this.windows.set(sessionId, window)
      }
      for (const [sessionId, ids] of evicted) {
        const gone = new Set(ids)
        this.windows.set(
          sessionId,
          (this.windows.get(sessionId) ?? []).filter((id) => !gone.has(id)),
        )
      }
    }, 'message-feed')
  }

  /**
   * Every committed feed change passes here (the ledger's `onAppended`, after
   * the outermost commit). A `session` change that says a session holding a
   * window has ended schedules its retire; everything else is ignored, and
   * nothing here writes.
   */
  private readonly watchSessions = (changes: readonly MetadataChange[]): void => {
    if (!this.live) return
    const ended = new Set<string>()
    for (const change of changes) {
      if (this.windows.has(change.id) && endsConversation(change)) ended.add(change.id)
    }
    if (ended.size === 0) return
    this.retiring = this.retiring
      .then(async () => await this.retire([...ended]))
      .catch((err: unknown) => {
        // The next boot's reconcile keeps windows only for live sessions.
        log.warn('could not drop an ended session’s confirmed messages from the feed', { err })
      })
  }

  /** Remove the windows of these sessions that the table says have ended. */
  private async retire(sessionIds: readonly string[]): Promise<void> {
    await this.deps.transact(async () => {
      const live = await this.liveOf(sessionIds)
      const specs: EntityChangeSpec[] = []
      const gone: string[] = []
      for (const sessionId of sessionIds) {
        const window = this.windows.get(sessionId)
        if (window === undefined || live.has(sessionId)) continue
        gone.push(sessionId)
        for (const id of window) specs.push({ entity: 'message', id, op: 'remove' })
      }
      if (gone.length === 0) return
      await this.deps.ledger.capture(specs)
      applyAfterCommit(() => {
        for (const sessionId of gone) this.windows.delete(sessionId)
      }, 'message-feed')
    })
  }

  /** Which of these sessions are live conversations, read from the table. */
  private async liveOf(sessionIds: readonly string[]): Promise<Set<string>> {
    if (sessionIds.length === 0) return new Set()
    const rows = await this.deps.sessions.getSessions(sessionIds)
    return new Set(sessionIds.filter((id) => isLiveConversation(rows.get(id))))
  }
}
