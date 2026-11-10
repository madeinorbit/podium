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
 *  - RECENTLY CONFIRMED: one of the newest {@link CONFIRMED_PER_SESSION}
 *    confirmed in ITS SESSION (by `created_at`, then id), while that session
 *    is a LIVE CONVERSATION. The chat drops a bubble when the history entry
 *    the machine named (`transcriptItem`) is on screen, so a device has to
 *    receive the confirmed record carrying that name. Removing it in the
 *    commit that confirms it would coalesce away in the funnel (per `(kind,
 *    id)`, the replica would see only the removal) and no device would ever
 *    learn the name. Each session has its own window, bounded by count, not by
 *    time: a newer confirmation in the same session pushes that session's
 *    oldest out, and a busy session never pushes out another's (POD-4811).
 *
 * THE WINDOW IS A QUERY ON THE TABLES (POD-6766, design POD-6253 §1), and the
 * publisher keeps no copy of it: the start-up load (`messageWindow`, which
 * the record builder streams too), every write and every session change
 * decide what is carried from `messages` and `sessions` as they stand. So
 * what the feed carries is exactly what the builder builds.
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
 * at all. When one comes back (unarchived, continued), its window returns.
 * Without this, every session ever messaged would keep its window forever and
 * what each device replicates would grow with the whole history. With it, the
 * feed carries at most LIVE sessions × {@link CONFIRMED_PER_SESSION}
 * confirmed records, plus the open set.
 *
 * Open records STAY, whatever their session does. One still on its way settles
 * by its own lifecycle (the daemon, expiry, a resume); one waiting for its
 * sender's attention (`failed`, `expired`, `unknown`) is a notice the sender
 * must be able to see and dismiss, and an ended session is exactly where one
 * is likely. Each leaves when it settles or is dismissed, as anywhere else.
 *
 * The trigger is the feed's own record of the session: every committed
 * `session` change passes {@link MessageFeedPublisher.watchSessions} (the
 * ledger's `onAppended`, after the outermost commit) and schedules a settle,
 * which re-reads the session and its newest confirmed messages in its own
 * transaction: carried while it is live, removed while it is not. Upserts the
 * feed already holds and removals of rows it never carried are dropped by the
 * log, so a settle of an unchanged session appends nothing. A crash before
 * the settle is healed by the next boot's reconcile. A device that held a
 * record a settle removes sees the removal; one that was still showing that
 * message's bubble settles it by id (`mail.records`) when it next starts or
 * reconnects.
 *
 * ---------------------------------------------------------------------------
 * IT RUNS INSIDE THE WRITE
 * ---------------------------------------------------------------------------
 * `capture` is installed on the messages repository and runs inside the
 * transaction of every write to the table, with the rows the write returned.
 * The feed and the table commit or roll back together, so a status the table
 * never held never reaches a device, and no move escapes the feed — whichever
 * module made it. The window is read inside that transaction, so it is the
 * window the write leaves: each row the write touched is carried when it is
 * open or in its session's window and removed otherwise, and what the write's
 * confirmations pushed past the window is removed.
 *
 * ---------------------------------------------------------------------------
 * BOOT
 * ---------------------------------------------------------------------------
 * `resolve` reconciles the full truth once, before the server listens: the
 * window read from the tables ({@link messageWindow}), in one transaction that
 * then turns the capture on. A write before that is already in the table the
 * reconcile reads, so the capture ignores it, and whatever the feed held that
 * the window no longer has (a record of an older shape, a window a crash left
 * behind) is corrected or removed.
 */

import { createLogger } from '@podium/logger'
import { type MessageRecordWire, messageRecordRowId } from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import type { EntityChangeSpec, Ledger, LedgerWriter } from '@podium/sync'
import { spawnPromptMessageId } from '../../message-ids'
import type { MessageFeedCapture, MessagesRepository } from '../../store/messages'
import type { SessionsRepository } from '../../store/sessions'
import type { MessageRow, SessionRow } from '../../store/types'

const log = createLogger('server:message-feed')

/** How many confirmed messages the feed keeps per session. Enough that every
 *  device connected when one is confirmed receives it, whatever else that
 *  session confirms in the same moment; small enough that a bootstrap stays
 *  cheap. A device away for longer catches up by id. */
export const CONFIRMED_PER_SESSION = 20

export interface MessageFeedDeps {
  readonly ledger: Pick<LedgerWriter, 'capture' | 'reconcile'> & Pick<Ledger, 'onAppended'>
  /** Which sessions are still live conversations ({@link isLiveConversation}). */
  readonly sessions: Pick<SessionsRepository, 'getSessions'>
  /** The window's reads ({@link messageWindow}, {@link MessagesRepository.confirmedChatTail}). */
  readonly messages: Pick<
    MessagesRepository,
    'listOpenChat' | 'confirmedChatWindow' | 'confirmedChatTail'
  >
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
    ...(row.id === spawnPromptMessageId(row.toId as MessageRecordWire['sessionId'])
      ? { initialPrompt: true as const }
      : {}),
    ...(row.attachments?.length
      ? {
          attachments: row.attachments.map(({ id, filename, mediaType, kind }) => ({
            id,
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

/**
 * The open half of the window: a person's chat message on its way or waiting
 * for its sender, not yet dismissed. The same terms as `listOpenChat` (and
 * the partial index under it), so a write and the start-up read agree.
 */
export function isOpenChat(row: MessageRow): boolean {
  return (
    row.fromKind === 'operator' &&
    row.toKind === 'session' &&
    !row.noticeDismissedAt &&
    row.deliveryStatus !== 'confirmed' &&
    row.deliveryStatus !== 'cancelled'
  )
}

const rowIdOf = (record: MessageRecordWire): string =>
  messageRecordRowId({
    sessionId: record.sessionId,
    senderUserId: record.senderUserId,
    messageId: record.id,
  })

/** The feed rows for these table rows, keyed by row id (a later row wins). */
export function messageRecords(rows: Iterable<MessageRow>): Map<string, MessageRecordWire> {
  const out = new Map<string, MessageRecordWire>()
  for (const row of rows) {
    const record = messageRecordOf(row)
    if (record !== null) out.set(rowIdOf(record), record)
  }
  return out
}

/** The whole window, read from the tables: the open set, then every live
 *  session's newest {@link CONFIRMED_PER_SESSION} confirmed. */
export async function messageWindow(
  messages: Pick<MessagesRepository, 'listOpenChat' | 'confirmedChatWindow'>,
  perSession = CONFIRMED_PER_SESSION,
): Promise<Map<string, MessageRecordWire>> {
  const open = await messages.listOpenChat()
  const confirmed = await messages.confirmedChatWindow(perSession)
  return messageRecords([...open, ...confirmed])
}

/** Group a tail read (newest first within a session) by session. */
function tailsBySession(rows: readonly MessageRow[]): Map<string, MessageRow[]> {
  const out = new Map<string, MessageRow[]>()
  for (const row of rows) {
    if (row.toId === null) continue
    const tail = out.get(row.toId) ?? []
    tail.push(row)
    out.set(row.toId, tail)
  }
  return out
}

export class MessageFeedPublisher {
  /** Retires and revivals run one after another, each in its own transaction. */
  private settling: Promise<void> = Promise.resolve()
  /** Sessions whose committed change is waiting for the next settle. */
  private readonly pendingSessions = new Set<string>()
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

  /** Wait until every settle scheduled so far has run (tests, store close). */
  async settled(): Promise<void> {
    while (true) {
      const current = this.settling
      await current
      if (current === this.settling && this.pendingSessions.size === 0) return
    }
  }

  private async reconcile(): Promise<void> {
    await this.deps.transact(async () => {
      const truth = await messageWindow(this.deps.messages, this.perSession)
      await this.deps.ledger.reconcile(
        'message',
        [...truth].map(([id, value]) => ({ id, value })),
      )
      this.live = true
    })
  }

  /**
   * The changes one write makes to the feed, decided from the tables as the
   * write left them. Every row it wrote is carried if it is open or in its
   * session's window, and removed otherwise; and each session it confirmed
   * into pushes out what now ranks just past the window. A removal of a row
   * the feed never carried is dropped by the log, so nothing here has to
   * remember what the feed holds.
   */
  private async publish(rows: readonly MessageRow[]): Promise<void> {
    const written = new Map<string, { row: MessageRow; record: MessageRecordWire }>()
    for (const row of rows) {
      const record = messageRecordOf(row)
      if (record !== null) written.set(rowIdOf(record), { row, record })
    }
    if (written.size === 0) return
    /** Per session: how many of its rows this write settled (not open). */
    const settledIn = new Map<string, number>()
    for (const { row, record } of written.values()) {
      if (isOpenChat(row)) continue
      settledIn.set(record.sessionId, (settledIn.get(record.sessionId) ?? 0) + 1)
    }
    const inWindow = new Set<string>()
    const pushedOut: MessageRecordWire[] = []
    if (settledIn.size > 0) {
      // A row can only have been pushed out by a row this write confirmed
      // above it, so what left ranks at most that many places past the window.
      const reach = this.perSession + Math.max(...settledIn.values())
      const tails = tailsBySession(
        await this.deps.messages.confirmedChatTail(reach, [...settledIn.keys()], 'live'),
      )
      for (const [sessionId, tail] of tails) {
        const extra = settledIn.get(sessionId) ?? 0
        for (const [rank, row] of tail.entries()) {
          if (rank >= this.perSession + extra) break
          const record = messageRecordOf(row)
          if (record === null) continue
          if (rank < this.perSession) inWindow.add(rowIdOf(record))
          else pushedOut.push(record)
        }
      }
    }
    const specs: EntityChangeSpec[] = []
    for (const [id, { row, record }] of written) {
      specs.push(
        isOpenChat(row) || inWindow.has(id)
          ? { entity: 'message', id, op: 'upsert', value: record }
          : { entity: 'message', id, op: 'remove' },
      )
    }
    for (const record of pushedOut) {
      const id = rowIdOf(record)
      if (!written.has(id)) specs.push({ entity: 'message', id, op: 'remove' })
    }
    await this.deps.ledger.capture(specs)
  }

  /**
   * Every committed feed change passes here (the ledger's `onAppended`, after
   * the outermost commit). A `session` change may have ended a conversation
   * or brought one back, so the session's window is settled against the
   * table; everything else is ignored, and nothing here writes.
   */
  private readonly watchSessions = (changes: readonly MetadataChange[]): void => {
    if (!this.live) return
    let added = false
    for (const change of changes) {
      if (change.entity !== 'session') continue
      if (!this.pendingSessions.has(change.id)) added = true
      this.pendingSessions.add(change.id)
    }
    if (!added) return
    this.settling = this.settling
      .then(async () => {
        const sessionIds = [...this.pendingSessions]
        this.pendingSessions.clear()
        if (sessionIds.length > 0) await this.settleSessions(sessionIds)
      })
      .catch((err: unknown) => {
        // The next boot's reconcile carries exactly the window again.
        log.warn('could not settle the confirmed messages of changed sessions', { err })
      })
  }

  /**
   * Carry the confirmed window of each of these sessions that is a live
   * conversation, and remove it from each that is not. Read in its own
   * transaction, so a session that changed again in between is settled as
   * the table now says. Upserts the feed already holds are dropped by the log.
   */
  private async settleSessions(sessionIds: readonly string[]): Promise<void> {
    await this.deps.transact(async () => {
      const tails = tailsBySession(
        await this.deps.messages.confirmedChatTail(this.perSession, sessionIds, 'any'),
      )
      if (tails.size === 0) return
      const sessions = await this.deps.sessions.getSessions([...tails.keys()])
      const specs: EntityChangeSpec[] = []
      for (const [sessionId, tail] of tails) {
        const live = isLiveConversation(sessions.get(sessionId))
        for (const [id, value] of messageRecords(tail)) {
          specs.push(
            live
              ? { entity: 'message', id, op: 'upsert', value }
              : { entity: 'message', id, op: 'remove' },
          )
        }
      }
      if (specs.length > 0) await this.deps.ledger.capture(specs)
    })
  }
}
