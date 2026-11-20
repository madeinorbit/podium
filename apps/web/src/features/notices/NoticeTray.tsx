/**
 * THE NOTICE TRAY (POD-6881, credential management spec §13): a bell in the
 * web and desktop header with the number of notices I have not read, and a
 * list behind it. Opening a notice marks it read and goes to what it is
 * about; "Mark all read" clears the count. The rows are my synced
 * `inboxNotice` records, so a notice raised, read or resolved anywhere moves
 * this without a request.
 */

import { Popover } from '@base-ui/react/popover'
import { here } from '@podium/client-graph/lookup'
import type { InboxNoticeModel } from '@podium/client-graph/models'
import {
  inboxNoticeIds,
  markAllNoticesRead,
  markNoticeRead,
  noticeDestination,
  unreadNoticeCount,
} from '@podium/client-graph/notice-inbox'
import { observer } from '@podium/client-graph/react'
import { createLogger } from '@podium/logger'
import { asIssueId } from '@podium/model/browser'
import { AtSign, Bell, DatabaseBackup, KeyRound, PackageX, Share2 } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { useShellActions } from '@/app/shell-data'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { CardAge } from '@/features/issues/CardAge'
import { cn } from '@/lib/utils'
import { revealComment } from './reveal-comment'

const log = createLogger('web:notices')

type Actions = ReturnType<typeof useShellActions>

/** What opening a notice does: mark it read, then go to its subject. */
export function openNotice(notice: InboxNoticeModel, actions: Actions): void {
  if (notice.unread) {
    void markNoticeRead(actions.trpc, notice.noticeId).catch((error: unknown) => {
      log.warn('could not mark a notice read', { err: error })
    })
  }
  const to = noticeDestination(notice)
  switch (to.kind) {
    case 'issue':
      actions.setOpenIssueId(asIssueId(to.issueId))
      if (to.commentId !== undefined) revealComment(to.commentId)
      return
    case 'session':
      actions.navigateToSession(to.sessionId)
      return
    case 'credential':
      actions.setView('settings')
      return
    case 'none':
      return
  }
}

const countLabel = (count: number): string => (count > 99 ? '99+' : String(count))

export const NoticeTray = observer(function NoticeTray(): JSX.Element {
  const pool = useWorklistPool()
  const actions = useShellActions()
  const [open, setOpen] = useState(false)
  const unread = pool ? unreadNoticeCount(pool) : 0
  const label = unread === 0 ? 'Notices' : `Notices, ${unread} unread`

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-pressable
        className={cn(
          'notice-tray-trigger relative flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
          open && 'bg-secondary text-foreground',
        )}
        data-testid="notice-tray"
        aria-label={label}
        title={label}
      >
        <Bell size={16} aria-hidden="true" />
        {unread > 0 && (
          <span className="notice-count" data-testid="notice-count" aria-hidden="true">
            {countLabel(unread)}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup className="notice-panel" data-testid="notice-panel">
            <div className="notice-panel-head">
              <h2>For you</h2>
              <button
                type="button"
                data-pressable
                className="notice-mark-all"
                data-testid="notice-mark-all"
                disabled={unread === 0}
                onClick={() => {
                  void markAllNoticesRead(actions.trpc).catch((error: unknown) => {
                    log.warn('could not mark notices read', { err: error })
                  })
                }}
              >
                Mark all read
              </button>
            </div>
            {pool && <NoticeList pool={pool} actions={actions} onOpened={() => setOpen(false)} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
})

type Pool = NonNullable<ReturnType<typeof useWorklistPool>>

const NoticeList = observer(function NoticeList({
  pool,
  actions,
  onOpened,
}: {
  pool: Pool
  actions: Actions
  onOpened: () => void
}): JSX.Element {
  const ids = inboxNoticeIds(pool)
  if (ids.length === 0) {
    return (
      <p className="notice-empty" data-testid="notice-empty">
        Nothing needs you.
      </p>
    )
  }
  return (
    <ul className="notice-list">
      {ids.map((id) => (
        <NoticeRow key={id} pool={pool} id={id} actions={actions} onOpened={onOpened} />
      ))}
    </ul>
  )
})

const KIND_ICON: Record<string, typeof AtSign> = {
  mention: AtSign,
  'credential-attention': KeyRound,
  'credential-shared': Share2,
  'harness-install-failing': PackageX,
  'harness-ledger-rebuilt': DatabaseBackup,
}

const NoticeRow = observer(function NoticeRow({
  pool,
  id,
  actions,
  onOpened,
}: {
  pool: Pool
  id: string
  actions: Actions
  onOpened: () => void
}): JSX.Element | null {
  const notice = here(pool.model('inboxNotice', id))
  if (notice === undefined) return null
  const Icon = KIND_ICON[notice.kind] ?? Bell
  return (
    <li>
      <button
        type="button"
        data-pressable
        className="notice-row"
        data-testid="notice-row"
        data-unread={notice.unread ? 'true' : undefined}
        onClick={() => {
          openNotice(notice, actions)
          onOpened()
        }}
      >
        <Icon size={14} aria-hidden="true" className="notice-row-icon" />
        <span className="notice-row-text">
          <span className="notice-row-title">{notice.title}</span>
          {notice.body && <span className="notice-row-body">{notice.body}</span>}
        </span>
        <span className="notice-row-age">
          <CardAge stamp={notice.createdAt} />
        </span>
        {notice.unread && (
          <>
            <span className="notice-row-dot" aria-hidden="true" />
            <span className="sr-only">Unread</span>
          </>
        )}
      </button>
    </li>
  )
})
