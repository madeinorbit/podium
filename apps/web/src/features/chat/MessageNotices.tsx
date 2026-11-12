/**
 * MESSAGES THAT DID NOT ARRIVE (POD-4764) — the list in the sync panel.
 *
 * A chat message the server says will not be delivered, or that nobody can
 * vouch for, shows in its own chat; this is the same fact where a person who
 * has moved on will still see it. Each row opens its chat or dismisses the
 * notice. "Send again" lives in the chat, beside the words it puts back into
 * the composer. Since POD-6852 the list lives in the sync panel's "Needs
 * review" section instead of behind its own header chip; the panel mounts it
 * only while open, so a closed panel reads the count alone.
 */
import { useRequestClient, useUi } from '@podium/client-core/react'
import type { MessageNotice } from '@podium/client-core/values'
import { NOTICE_MESSAGE_WINDOW } from '@podium/client-graph/notice-views'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { usePoolMessageNoticeCount, usePoolMessageNotices } from './use-pool-notices'

export const NoticeRow = observer(function NoticeRow({
  notice,
  onOpen,
}: {
  notice: MessageNotice
  onOpen: () => void
}): JSX.Element {
  const trpc = useRequestClient<Trpc>(),
    { openSessionTab } = useUi()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <li className="flex flex-col gap-1 border-t border-border px-5 py-3 first:border-t-0">
      <span className="text-[12px] text-muted-foreground">To {notice.sessionLabel}</span>
      <span className="truncate text-[13px]">{notice.excerpt || 'A message with files'}</span>
      <span className="text-[12px] text-destructive">{notice.line}</span>
      {error && <span className="text-[12px] text-destructive">{error}</span>}
      <div className="mt-1 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            openSessionTab(notice.sessionId)
            onOpen()
          }}
        >
          Open chat
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            trpc.messages.dismissNotice
              .mutate({ id: notice.messageId })
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : String(cause)),
              )
              .finally(() => setBusy(false))
          }}
        >
          Dismiss
        </Button>
      </div>
    </li>
  )
})

export function noticeLabel(count: number): string {
  return `${count} ${count === 1 ? 'message didn’t arrive' : 'messages didn’t arrive'}`
}

/**
 * The undelivered messages, newest first. Renders nothing at zero. `onOpenChat`
 * runs after a row opens its chat, so the panel can close behind it.
 */
export function MessageNoticeList({ onOpenChat }: { onOpenChat?: () => void }): JSX.Element | null {
  const count = usePoolMessageNoticeCount()
  const notices = usePoolMessageNotices(count > 0)
  if (count === 0) return null
  return (
    <section data-testid="message-notice-list" aria-label={noticeLabel(count)}>
      <div className="sync-panel-lead">
        <p className="sync-panel-lead-title">{noticeLabel(count)}</p>
        <p>
          {count === 1
            ? 'The agent did not get it, or nobody can say whether it did.'
            : 'The agent did not get these, or nobody can say whether it did.'}
        </p>
      </div>
      <ul className="flex flex-col">
        {notices.map((notice) => (
          <NoticeRow key={notice.messageId} notice={notice} onOpen={() => onOpenChat?.()} />
        ))}
      </ul>
      {count > notices.length && (
        <p className="px-5 pb-3 text-[12px] text-muted-foreground">
          Showing the newest {NOTICE_MESSAGE_WINDOW} — older ones stay in their chats.
        </p>
      )}
    </section>
  )
}
