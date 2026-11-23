/**
 * CONCERTMASTER ENTRIES AS SYNCED RECORDS (POD-7211).
 *
 * The record is built from the stored row (`sync/row-records.ts`, declared in
 * `sync/record-sources.ts`): every entry of a conversation is a
 * `concertmasterEntry` record, a settled ask included, so the chat shows what
 * was asked and what it was settled with. Its class is the session's
 * (`feed-visibility.ts`): an entry reaches the people who may see its session,
 * and a device holds one session's entries while it shows that conversation
 * (the `ofSession` collection).
 */

import type { ConcertmasterEntryWire } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'
import { changeLogCommit } from '../../store/change-log-commit'
import type { ConcertmasterEntryRow, ConcertmasterFeedCapture } from '../../store/concertmaster'

export function concertmasterEntryWireOf(row: ConcertmasterEntryRow): ConcertmasterEntryWire {
  return {
    entryId: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    body: row.body,
    createdAt: row.createdAt,
    ...(row.artifacts !== null && row.artifacts.length > 0
      ? { artifacts: [...row.artifacts] }
      : {}),
    ...(row.senderUserId !== null ? { senderUserId: row.senderUserId } : {}),
    ...(row.attachments !== null && row.attachments.length > 0
      ? { attachments: row.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(row.number !== null ? { number: row.number } : {}),
    ...(row.askKind !== null ? { askKind: row.askKind } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    ...(row.options !== null && row.options.length > 0 ? { options: [...row.options] } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.answer !== null ? { answer: row.answer } : {}),
    ...(row.settledAt !== null ? { settledAt: row.settledAt } : {}),
    ...(row.settledBy !== null ? { settledBy: row.settledBy } : {}),
  }
}

/**
 * The hook installed on the repository: every write to the conversation runs
 * as one change-log commit through the Ledger, which drains the database's
 * change capture and appends the `concertmasterEntry` records the write
 * reached (POD-6920).
 */
export function makeConcertmasterFeedCapture(
  ledger: Pick<LedgerWriter, 'commit'>,
): ConcertmasterFeedCapture {
  return changeLogCommit(ledger)
}
