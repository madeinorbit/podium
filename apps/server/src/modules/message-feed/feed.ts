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
 * the record builder streams too), every message write and every session write
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
 * Session row writes pass {@link MessageFeedPublisher.writeSessions}. Before
 * the write, it names the confirmed tail, and the Authority compares those
 * records around the write. A liveness change and its window changes commit
 * together. An unchanged conversation appends nothing. A device still showing
 * a removed bubble settles it by id (`mail.records`) when it next reconnects.
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

import { type MessageRecordWire, messageRecordRowId } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'
import { spawnPromptMessageId } from '../../message-ids'
import type { MessageFeedCapture, MessagesRepository } from '../../store/messages'
import type { SessionMessageWindowWrite } from '../../store/sessions'
import type { MessageRow, SessionRow } from '../../store/types'

/** How many confirmed messages the feed keeps per session. Enough that every
 *  device connected when one is confirmed receives it, whatever else that
 *  session confirms in the same moment; small enough that a bootstrap stays
 *  cheap. A device away for longer catches up by id. */
export const CONFIRMED_PER_SESSION = 20

export interface MessageFeedDeps {
  readonly ledger: Pick<LedgerWriter, 'commit'>
  readonly messages: Pick<MessagesRepository, 'confirmedChatTail'>
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
  private readonly perSession: number

  constructor(private readonly deps: MessageFeedDeps) {
    this.perSession = deps.confirmedPerSession ?? CONFIRMED_PER_SESSION
  }

  /** The repository's capture port. Runs inside the write's transaction. */
  readonly capture: MessageFeedCapture = async (rows, confirms) => {
    await this.publish(rows, confirms)
  }

  /** Session writes know their ids first. Compare their existing confirmed
   *  tails around the row write, including tails a revival will admit. */
  readonly writeSessions: SessionMessageWindowWrite = async (ids, write) => {
    await this.deps.ledger.commit({
      affects: async () =>
        [
          ...messageRecords(
            await this.deps.messages.confirmedChatTail(this.perSession, ids, 'any'),
          ),
        ].map(([id]) => ({ entity: 'message' as const, id })),
      write,
    })
  }

  /**
   * The changes one write makes to the feed, decided from the tables as the
   * write left them. Every row it wrote is carried if it is open or in its
   * session's window, and removed otherwise; and each session it confirmed
   * into pushes out the oldest previously confirmed records. Stamps preserve
   * the window. The Authority builds every named value from the tables inside
   * the source write's transaction.
   */
  private async publish(rows: readonly MessageRow[], confirms: boolean): Promise<void> {
    const written = new Map<string, { row: MessageRow; record: MessageRecordWire }>()
    for (const row of rows) {
      const record = messageRecordOf(row)
      if (record !== null) written.set(rowIdOf(record), { row, record })
    }
    if (written.size === 0) return
    /** Per session, the confirmed rows this write returned. */
    const confirmedIn = new Map<string, number>()
    for (const { row, record } of written.values()) {
      if (row.deliveryStatus !== 'confirmed') continue
      confirmedIn.set(record.sessionId, (confirmedIn.get(record.sessionId) ?? 0) + 1)
    }
    const inWindow = new Set<string>()
    const pushedOut: MessageRecordWire[] = []
    if (confirmedIn.size > 0) {
      // A row can only have been pushed out by a row this write confirmed
      // above it, so what left ranks at most that many places past the window.
      const reach = this.perSession + (confirms ? Math.max(...confirmedIn.values()) : 0)
      const tails = tailsBySession(
        await this.deps.messages.confirmedChatTail(reach, [...confirmedIn.keys()], 'live'),
      )
      const confirmedIds = new Set(rows.map((row) => row.id))
      for (const tail of tails.values()) {
        const current = messageRecords(tail.slice(0, this.perSession))
        for (const id of current.keys()) inWindow.add(id)
        if (!confirms) continue
        // New confirmations were absent from the previous tail. A late
        // confirmation below the window displaces no carried record.
        const previous = messageRecords(
          tail.filter((row) => !confirmedIds.has(row.id)).slice(0, this.perSession),
        )
        for (const [id, record] of previous) {
          if (!current.has(id)) pushedOut.push(record)
        }
      }
    }
    const named = [...written]
      .filter(([id, { row }]) => row.deliveryStatus !== 'confirmed' || confirms || inWindow.has(id))
      .map(([id]) => ({ entity: 'message' as const, id, removed: true }))
    for (const record of pushedOut) {
      const id = rowIdOf(record)
      if (!written.has(id)) named.push({ entity: 'message', id, removed: true })
    }
    await this.deps.ledger.commit({
      write: async () => {},
      wrote: () => named,
    })
  }
}
