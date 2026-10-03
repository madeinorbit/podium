/**
 * MESSAGES THAT DID NOT ARRIVE (POD-4764) — the header chip and its list.
 *
 * A chat message the server says will not be delivered, or that nobody can
 * vouch for, shows in its own chat; this is the same fact where a person who
 * has moved on will still see it. Each row opens its chat or dismisses the
 * notice. "Send again" lives in the chat, beside the words it puts back into
 * the composer. Appears only when there is something to say.
 */
import { useStoreHandle } from '@podium/client-core/react'
import type { MessageNotice } from '@podium/client-core/viewmodels'
import { MessageSquareWarning } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { usePoolMessageNotices } from './use-pool-notices'

function NoticeRow({ notice, onOpen }: { notice: MessageNotice; onOpen: () => void }): JSX.Element {
  const { trpc, openSessionTab } = useStoreHandle<Trpc>().getSnapshot()
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
}

export function MessageNoticeIndicator({ compact }: { compact?: boolean }): JSX.Element | null {
  const notices = usePoolMessageNotices()
  return <NoticeIndicatorBody notices={notices} compact={compact} />
}
function NoticeIndicatorBody({
  notices,
  compact,
}: {
  notices: readonly MessageNotice[]
  compact?: boolean
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (notices.length === 0) setOpen(false)
  }, [notices.length])
  if (notices.length === 0) return null

  const count = notices.length
  const label = `${count} ${count === 1 ? 'message didn’t arrive' : 'messages didn’t arrive'}`
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-pressable
              onClick={() => setOpen(true)}
              data-testid="message-notice-chip"
              className={cn(
                'inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-destructive',
                compact && 'min-w-[30px] justify-center px-1',
              )}
              aria-label={label}
            >
              <MessageSquareWarning size={14} aria-hidden="true" />
              {!compact && <span>{count} not delivered</span>}
            </button>
          }
        />
        <TooltipContent className="max-w-60 flex-col items-start gap-0.5">
          <strong>{label}</strong>
          <span className="text-background/70">Open the chat to send again, or dismiss</span>
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-label={label}
          className="max-w-md gap-0 overflow-hidden p-0 sm:max-w-md"
        >
          <DialogHeader className="gap-1.5 px-5 pt-5 pr-12">
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              The agent did not get these, or nobody can say whether it did.
            </DialogDescription>
          </DialogHeader>
          <ul className="mt-2 flex max-h-[60vh] flex-col overflow-auto">
            {notices.map((notice) => (
              <NoticeRow key={notice.messageId} notice={notice} onOpen={() => setOpen(false)} />
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
