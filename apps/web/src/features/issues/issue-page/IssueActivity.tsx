/**
 * The activity half of the issue page: agent mail, the assistant note, the
 * day-grouped comment/event feed, and the comment composer.
 *
 * COMMENTS AND MAIL CARRY NO VISIBILITY OF THEIR OWN. Per
 * docs/multi-user-readiness.md §3.1.2 inheritance on create is declared per
 * class, and both inherit the ISSUE: if you can see this page you can see its
 * thread, and if you cannot see the issue you never reach this component. So
 * there is deliberately no per-comment visibility affordance here, and adding
 * one would invent a policy the doc settles the other way.
 *
 * POD-591 rebuilt the feed. It used to be a flat list that printed
 * `item.ts` — the raw ISO-8601 string straight off the event row — beside a
 * line produced by de-prefixing the event KIND, so a live task rendered thirty
 * consecutive rows reading `read  2026-08-07T20:21:24.588Z`. Three changes fix
 * it, and all three live in `../issue-events.ts` so they stay pure:
 *   · days carry the date, rows carry a clock time (`eventClock`), and the ISO
 *     precision moves to `title`;
 *   · runs of minor events collapse into one line the operator can open;
 *   · comments render as cards against a hairline event timeline, so the thing
 *     a human wrote outranks the thing a process logged.
 * The composer left this module entirely — IssuePage pins it below the scroll
 * (see `CommentComposer`), because a reply box at the end of six thousand
 * pixels of history is a reply box nobody reaches.
 */

import { relativeTime } from '@podium/client-core/focus'
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
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
import { useEffect, useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type {
  ActivityDay,
  ActivityEntry,
  ActivityItem,
  IssueEventIcon,
  IssueEventLine,
} from '../issue-events'
import { eventClock, eventStamp, groupActivityFeed } from '../issue-events'
import type { IssueMailMessage, IssuePageCommands } from '../issue-page-commands'
import { MACHINE_LABEL, SectionHeading } from './chrome'

/** Agent mail addressed to this issue (issue #103) — durable messages other
 *  agents sent to whoever works it. Read-only operator view; listing here never
 *  consumes the recipient's unread status. */
export function MailSection({ mail }: { mail: IssueMailMessage[] }): JSX.Element | null {
  if (mail.length === 0) return null
  const now = Date.now()
  return (
    <section className="mb-9 flex flex-col gap-2" data-testid="issue-mail">
      <SectionHeading count={String(mail.length)}>Mail</SectionHeading>
      {mail.map((m) => (
        <div
          key={m.id}
          className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <Mail
              size={12}
              aria-hidden="true"
              className={cn('flex-none', m.status === 'unread' ? 'text-attention' : 'opacity-50')}
            />
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
              {m.fromAuthor}
            </span>
            {m.status === 'unread' && (
              <span className="rounded-[4px] bg-attention/12 px-1.5 font-mono text-[9px] text-attention uppercase tracking-[0.04em]">
                unread
              </span>
            )}
            {m.status === 'claimed' && m.claimedBy && (
              <span
                className="rounded-[4px] bg-muted/50 px-1.5 font-mono text-[9px] text-muted-foreground"
                title={`Claimed by ${m.claimedBy}`}
              >
                claimed · {m.claimedBy}
              </span>
            )}
            <span
              className="ml-auto flex-none font-mono text-[9px] text-text-faint tabular-nums"
              title={eventStamp(m.createdAt)}
            >
              {relativeTime(m.createdAt, now)}
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words text-[13.5px] text-foreground/90 leading-[1.6]">
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

/**
 * One transition line on the timeline. The left rule and its node are drawn by
 * the row itself (a 1px hairline plus a 5px dot) so the feed reads as one
 * continuous spine — a real transition lights its node in the issue colour, a
 * minor one leaves it grey.
 */
function ActivityEvent({ line, ts }: { line: IssueEventLine; ts: string }): JSX.Element {
  const Icon = EVENT_ICONS[line.icon] ?? EVENT_ICONS.generic
  const minor = line.minor === true
  return (
    <div
      className={cn(
        'relative flex items-center gap-2 border-border/45 border-l py-1 pl-4 text-[12px]',
        minor ? 'text-text-faint' : 'text-muted-foreground',
      )}
      data-testid="activity-event"
    >
      <span
        aria-hidden="true"
        className={cn(
          '-left-[3px] absolute top-[10px] size-[5px] rounded-full',
          minor ? 'bg-border' : 'bg-[var(--issue)]',
        )}
      />
      <Icon size={12} aria-hidden="true" className="shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 break-words">{line.text}</span>
      <span className="shrink-0 font-mono text-[9px] tabular-nums" title={eventStamp(ts)}>
        {eventClock(ts)}
      </span>
    </div>
  )
}

/** A collapsed run of minor events — one line, opened in place. */
function ActivityRollupRow({
  label,
  count,
  firstTs,
  ts,
  items,
}: {
  label: string
  count: number
  firstTs: string
  ts: string
  items: ActivityItem[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div
        className="relative flex items-center gap-2 border-border/45 border-l py-1 pl-4 text-[12px] text-text-faint"
        data-testid="activity-rollup"
      >
        <span
          aria-hidden="true"
          className="-left-[3px] absolute top-[10px] size-[5px] rounded-full bg-border"
        />
        <button
          data-pressable
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-muted-foreground"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight
            size={11}
            aria-hidden="true"
            className={cn('shrink-0 transition-transform', open && 'rotate-90')}
          />
          <span className="truncate underline decoration-border underline-offset-2">{label}</span>
          <span className="hidden shrink-0 sm:inline">
            between {eventClock(firstTs)} and {eventClock(ts)}
          </span>
        </button>
        {/* The clock, like every other row — the count is already in the label,
            and a second copy of it in the timestamp column made the one column
            that should read as one thing read as two. */}
        <span
          className="shrink-0 font-mono text-[9px] tabular-nums"
          title={`${count} events, ${eventStamp(firstTs)} – ${eventStamp(ts)}`}
        >
          {eventClock(ts)}
        </span>
      </div>
      {open &&
        items.map((item) =>
          item.kind === 'event' ? (
            <ActivityEvent key={item.id} line={item.line} ts={item.ts} />
          ) : null,
        )}
    </>
  )
}

/**
 * A comment. Renders its ATTRIBUTION PAIR when the server sent one (§3.1.3 A3) —
 * which agent wrote it, and which human that agent was working for.
 *
 * NO PAIR IS SYNTHESISED HERE, and that is a measurement rather than an
 * omission: `IssueComment` (model/entities/issue-vocabulary.ts) carries
 * `author`, `body`, `createdAt` and an id — no `Attribution`. §3.1.3 A3 says the
 * UI READS the pair and never asserts it, so a comment row whose server shape
 * has no pair renders none. Deriving one from `author` would be exactly the
 * synthesis A3 forbids. See the ledger for the upstream that would supply it.
 */
function ActivityComment({
  author,
  body,
  ts,
}: {
  author: string
  body: string
  ts: string
}): JSX.Element {
  return (
    <div className="my-2 ml-[5px] rounded-lg border border-border bg-card px-3 py-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium text-[11.5px] text-foreground">{author}</span>
        <span
          className="ml-auto shrink-0 font-mono text-[9px] text-text-faint tabular-nums"
          title={eventStamp(ts)}
        >
          {eventClock(ts)}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[13.5px] text-muted-foreground leading-[1.6]">
        {body}
      </p>
    </div>
  )
}

function ActivityEntryRow({ entry }: { entry: ActivityEntry }): JSX.Element | null {
  if (entry.kind === 'rollup') {
    return (
      <ActivityRollupRow
        label={entry.label}
        count={entry.count}
        firstTs={entry.firstTs}
        ts={entry.ts}
        items={entry.items}
      />
    )
  }
  if (entry.kind === 'comment') {
    return <ActivityComment author={entry.author} body={entry.body} ts={entry.ts} />
  }
  return <ActivityEvent line={entry.line} ts={entry.ts} />
}

/** The mono day divider that carries the date the rows no longer restate. */
function DayDivider({ label }: { label: string }): JSX.Element {
  return (
    <div className="mt-4 mb-2 flex items-center gap-2.5 first:mt-0">
      <span className={MACHINE_LABEL}>{label}</span>
      <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
    </div>
  )
}

/** The activity section: assistant note, then the day-grouped feed. */
export function IssueActivitySection({
  issue,
  busy,
  commands,
  feed,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
  feed: ActivityItem[]
}): JSX.Element {
  // Days are derived per render against a coarse clock: the only thing `now`
  // decides is whether a group says "Today", so re-deriving on a timer would
  // repaint the whole feed to change one word a day.
  const days: ActivityDay[] = groupActivityFeed(feed, Date.now())
  return (
    <section className="group/section flex flex-col gap-2">
      <SectionHeading
        action={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Refresh AI notes"
            aria-label="Refresh AI notes"
            disabled={busy}
            onClick={commands.refreshAssistant}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </Button>
        }
      >
        Activity
      </SectionHeading>

      {issue.activityNotes && (
        <div className="flex flex-col gap-1 rounded-lg border border-border border-dashed bg-muted/20 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className={MACHINE_LABEL}>Assistant</span>
            {issue.notesUpdatedAt && (
              <span
                className="font-mono text-[9px] text-text-faint tabular-nums"
                title={eventStamp(issue.notesUpdatedAt)}
              >
                {relativeTime(issue.notesUpdatedAt, Date.now())}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-[13.5px] text-muted-foreground leading-[1.6]">
            {issue.activityNotes}
          </p>
        </div>
      )}

      {days.length > 0 && (
        <div data-testid="activity-feed">
          {days.map((day) => (
            <div key={day.key}>
              <DayDivider label={day.label} />
              {day.entries.map((entry) => (
                <ActivityEntryRow key={entry.id} entry={entry} />
              ))}
            </div>
          ))}
        </div>
      )}

      {days.length === 0 && (
        <p className="py-1 text-[12px] text-text-faint">
          Nothing has happened on this task yet. Comments and state changes land here.
        </p>
      )}
    </section>
  )
}

/**
 * The comment composer, pinned by IssuePage below the scrolling document.
 *
 * It grows with what you type and stops at a third of the viewport, so a long
 * reply never eats the history it is replying to. Cmd/Ctrl+Enter posts.
 */
export function CommentComposer({
  issueId,
  busy,
  value,
  onChange,
  onPost,
}: {
  issueId: string
  busy: boolean
  value: string
  onChange: (body: string) => void
  onPost: () => void
}): JSX.Element {
  const [focused, setFocused] = useState(false)
  // Collapse back to one line when the issue changes under a focused composer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => setFocused(false), [issueId])
  const active = focused || value.trim().length > 0
  return (
    <div className="flex-none border-border/50 border-t bg-card/20 px-6 py-2.5 md:px-10">
      <div className="mx-auto flex w-full max-w-[54rem] items-end gap-2">
        <Textarea
          value={value}
          placeholder="Comment, or @mention an agent on this task…"
          aria-label="Add a comment"
          disabled={busy}
          className={cn(
            'resize-none rounded-[9px] text-[13.5px] transition-[min-height] duration-150',
            active ? 'min-h-[76px]' : 'min-h-[34px]',
          )}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && value.trim()) {
              e.preventDefault()
              onPost()
            }
          }}
        />
        {active ? (
          <Button
            type="button"
            size="sm"
            className="mb-px"
            disabled={busy || value.trim().length === 0}
            onClick={onPost}
          >
            Post
          </Button>
        ) : (
          <span className="mb-2 select-none font-mono text-[9px] text-text-faint">⌘↵</span>
        )}
      </div>
    </div>
  )
}
