/**
 * NOTICES AS SYNCED RECORDS (POD-6881, credential management spec §13).
 *
 * The record is built from the stored row (`sync/record-builders.ts`, declared
 * in `sync/record-sources.ts`): an open notice is an `inboxNotice` record; a
 * resolved one is none, so it leaves as a `remove` and a person's devices hold
 * exactly the notices that still need them. The feed id names the recipient
 * first, and the class is `per-user-state` (`feed-visibility.ts`), so a notice
 * reaches its recipient's devices and nobody else's.
 */

import { asUserId, type NoticeWire } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'
import { changeLogCommit } from '../../store/change-log-commit'
import type { NoticeFeedCapture, NoticeRow } from '../../store/notices'

export function noticeWireOf(row: NoticeRow): NoticeWire {
  return {
    noticeId: row.id,
    recipientUserId: asUserId(row.recipientUserId),
    kind: row.kind,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    ...(row.subjectAnchor !== null ? { subjectAnchor: row.subjectAnchor } : {}),
    title: row.title,
    ...(row.body !== null ? { body: row.body } : {}),
    createdAt: row.createdAt,
    ...(row.readAt !== null ? { readAt: row.readAt } : {}),
  }
}

/**
 * The hook installed on the repository: every notice write runs as one
 * change-log commit through the Ledger, which drains the database's change
 * capture and appends the `inboxNotice` records the write reached (POD-6920).
 * An open notice is built as an upsert; a resolved one is no record, so it
 * leaves its recipient's devices as a remove.
 */
export function makeNoticeFeedCapture(ledger: Pick<LedgerWriter, 'commit'>): NoticeFeedCapture {
  return changeLogCommit(ledger)
}
