/**
 * The activity half of the issue page: agent mail, the assistant note, the
 * interleaved comment/event feed, and the comment composer. Split out of
 * IssuePage.tsx (POD-646).
 *
 * COMMENTS AND MAIL CARRY NO VISIBILITY OF THEIR OWN. Per
 * docs/multi-user-readiness.md §3.1.2 inheritance on create is declared per
 * class, and both inherit the ISSUE: if you can see this page you can see its
 * thread, and if you cannot see the issue you never reach this component. So
 * there is deliberately no per-comment visibility affordance here, and adding
 * one would invent a policy the doc settles the other way.
 */

import { relativeTime } from '@podium/client-core/focus'
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  CircleDot,
  Flag,
  FlagOff,
  GitMerge,
  Link2,
  type LucideIcon,
  Mail,
  Play,
  RefreshCw,
  Trash2,
  Unlock,
} from 'lucide-react'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { ActivityItem, IssueEventIcon } from '../issue-events'
import type { IssueMailMessage, IssuePageCommands } from '../issue-page-commands'
import { SectionHeading } from './chrome'

/** Agent mail addressed to this issue (issue #103) — durable messages other
 *  agents sent to whoever works it. Read-only operator view; listing here never
 *  consumes the recipient's unread status. */
export function MailSection({ mail }: { mail: IssueMailMessage[] }): JSX.Element | null {
  if (mail.length === 0) return null
  const now = Date.now()
  return (
    <section className="mb-7 flex flex-col gap-1.5" data-testid="issue-mail">
      <SectionHeading count={String(mail.length)}>Mail</SectionHeading>
      {mail.map((m) => (
        <div
          key={m.id}
          className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/20 p-2"
        >
          <div className="flex items-center gap-2">
            <Mail
              size={12}
              aria-hidden="true"
              className={cn('flex-none', m.status === 'unread' ? 'text-primary' : 'opacity-50')}
            />
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {m.fromAuthor}
            </span>
            {m.status === 'unread' && (
              <span className="rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
                unread
              </span>
            )}
            {m.status === 'claimed' && m.claimedBy && (
              <span
                className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground"
                title={`Claimed by ${m.claimedBy}`}
              >
                claimed · {m.claimedBy}
              </span>
            )}
            <span
              className="ml-auto flex-none text-[11px] text-muted-foreground/70"
              title={m.createdAt}
            >
              {relativeTime(m.createdAt, now)}
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words pl-5 text-[13px] text-foreground/85">
            {m.body}
          </p>
        </div>
      ))}
    </section>
  )
}

/** Glyph per event-line kind (the pure formatter returns a stable `icon` key so
 *  it stays JSX-free and unit-testable; the mapping to a real icon lives here). */
const EVENT_ICONS: Record<IssueEventIcon, LucideIcon> = {
  created: CircleDot,
  moved: ArrowRight,
  closed: CheckCircle2,
  started: Play,
  attached: Link2,
  cleaned: Trash2,
  flagged: Flag,
  cleared: FlagOff,
  ready: Unlock,
  integration: GitMerge,
  generic: Circle,
}

/** One compact, muted state-transition line in the activity feed. */
function ActivityEvent({
  icon,
  text,
  ts,
}: {
  icon: IssueEventIcon
  text: string
  ts: string
}): JSX.Element {
  const Icon = EVENT_ICONS[icon] ?? EVENT_ICONS.generic
  return (
    <div
      className="flex items-center gap-2 px-1 py-0.5 text-[12px] text-muted-foreground"
      data-testid="activity-event"
    >
      <Icon size={13} aria-hidden="true" className="shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 break-words">{text}</span>
      <span className="shrink-0 text-[11px] opacity-70">{ts}</span>
    </div>
  )
}

/**
 * The activity section: assistant note, feed, composer.
 *
 * A comment renders its ATTRIBUTION PAIR when the server sent one (§3.1.3 A3) —
 * which agent wrote it, and which human that agent was working for. The legacy
 * `author` string stays the headline for rows that predate the pair; the pair is
 * additive and never synthesised from `author`.
 */
export function IssueActivitySection({
  issue,
  busy,
  commands,
  feed,
  commentBody,
  onCommentBodyChange,
  onPost,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
  feed: ActivityItem[]
  commentBody: string
  onCommentBodyChange: (body: string) => void
  onPost: () => void
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <SectionHeading>Activity</SectionHeading>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Refresh AI notes"
          disabled={busy}
          onClick={commands.refreshAssistant}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      </div>

      {issue.activityNotes && (
        <div className="flex flex-col gap-0.5 rounded-lg border border-border border-dashed bg-muted/30 p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              Assistant
            </span>
            {issue.notesUpdatedAt && (
              <span className="text-[10px] text-muted-foreground/70" title={issue.notesUpdatedAt}>
                {relativeTime(issue.notesUpdatedAt, Date.now())}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
            {issue.activityNotes}
          </p>
        </div>
      )}

      {feed.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="activity-feed">
          {feed.map((item) =>
            item.kind === 'comment' ? (
              <div
                key={item.id}
                className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/40 p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[12px] text-foreground">{item.author}</span>
                  <span className="text-[11px] text-muted-foreground">{item.ts}</span>
                </div>
                {/* NO ATTRIBUTION PAIR HERE, and that is a measurement rather
                    than an omission: `IssueComment` (model/entities/
                    issue-vocabulary.ts) carries `author`, `body`, `createdAt`
                    and an id — no `Attribution`. §3.1.3 A3 says the UI READS the
                    pair and never asserts it, so a comment row whose server
                    shape has no pair renders none. Deriving one from `author`
                    would be exactly the synthesis A3 forbids. See the ledger for
                    the upstream that would supply it. */}
                <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
                  {item.body}
                </p>
              </div>
            ) : (
              <ActivityEvent
                key={item.id}
                icon={item.line.icon}
                text={item.line.text}
                ts={item.ts}
              />
            ),
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Textarea
          value={commentBody}
          placeholder="Add a comment…"
          aria-label="Add a comment"
          disabled={busy}
          className="min-h-[60px] text-[13px]"
          onChange={(e) => onCommentBodyChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && commentBody.trim()) {
              e.preventDefault()
              onPost()
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          className="w-fit"
          disabled={busy || commentBody.trim().length === 0}
          onClick={onPost}
        >
          Post
        </Button>
      </div>
    </section>
  )
}
