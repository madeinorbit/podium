/**
 * MY NOTICE INBOX IN THE POOL (POD-6881, credential management spec §13): the
 * reads the web tray and the phone's inbox screen share.
 *
 * Notices are synced records the feed delivers to their recipient only, and
 * only while open, so every `inboxNotice` row in the pool is mine and still
 * needs me. A notice raised or read on my other device moves these reads
 * without a request; a resolved one leaves on its own.
 */

import { type SyncSubmitTransport, submitNow } from '@podium/protocol'
import { compareShallow, computed, type IComputedValue } from 'mobx'
import type { MobxPool, PoolRows } from './pool'

const NONE: readonly string[] = Object.freeze([])

interface InboxReads {
  readonly ids: IComputedValue<readonly string[]>
  readonly unread: IComputedValue<number>
}

type InboxPool = Pick<MobxPool, 'tables' | 'sources'>

function inboxReads(pool: InboxPool): InboxReads {
  return pool.sources.view('notice-inbox', () => {
    const rows = (): PoolRows['inboxNotice'][] =>
      // A pool without the table (a screen's stand-in in a test) holds none.
      [...(pool.tables.inboxNotice?.values() ?? [])] as PoolRows['inboxNotice'][]
    return {
      ids: computed(
        (): readonly string[] => {
          const all = rows()
          if (all.length === 0) return NONE
          all.sort((a, b) =>
            a.createdAt === b.createdAt
              ? b.id.localeCompare(a.id)
              : a.createdAt < b.createdAt
                ? 1
                : -1,
          )
          return all.map((row) => row.id)
        },
        { equals: compareShallow },
      ),
      unread: computed(() => rows().filter((row) => row.readAt === undefined).length),
    }
  })
}

/** My open notices, newest first, as pool ids (`pool.model('inboxNotice', id)`). */
export function inboxNoticeIds(pool: InboxPool): readonly string[] {
  if (pool.sources === undefined) return NONE
  return inboxReads(pool).ids.get()
}

/** How many of my open notices I have not read: the number on the tray. */
export function unreadNoticeCount(pool: InboxPool): number {
  if (pool.sources === undefined) return 0
  return inboxReads(pool).unread.get()
}

/** Where opening a notice goes. */
export type NoticeDestination =
  | { readonly kind: 'issue'; readonly issueId: string; readonly commentId?: string }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'credential'; readonly credentialId: string }
  | { readonly kind: 'none' }

/** The subject a notice opens; a subject this build does not know opens nothing. */
export function noticeDestination(notice: {
  readonly subjectKind: string
  readonly subjectId: string
  readonly subjectAnchor?: string
}): NoticeDestination {
  switch (notice.subjectKind) {
    case 'issue':
      return notice.subjectAnchor === undefined
        ? { kind: 'issue', issueId: notice.subjectId }
        : { kind: 'issue', issueId: notice.subjectId, commentId: notice.subjectAnchor }
    case 'session':
      return { kind: 'session', sessionId: notice.subjectId }
    case 'credential':
      return { kind: 'credential', credentialId: notice.subjectId }
    default:
      return { kind: 'none' }
  }
}

/** Mark one of my notices read (`notices.markRead`). */
export async function markNoticeRead(
  transport: SyncSubmitTransport,
  noticeId: string,
): Promise<void> {
  await submitNow(transport, 'notices.markRead', { id: noticeId })
}

/** Mark all my notices read (`notices.markAllRead`). */
export async function markAllNoticesRead(transport: SyncSubmitTransport): Promise<void> {
  await submitNow(transport, 'notices.markAllRead', {})
}
