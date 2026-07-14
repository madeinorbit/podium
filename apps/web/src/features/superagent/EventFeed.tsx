import type { IssueWire } from '@podium/protocol'
import type { JSX } from 'react'
import { FLOW_SLATE, issueColorHex } from '@/lib/issueColors'
import { trayScopeIssues } from './derive-tray'
import type { FeedEvent } from './useIssueEvents'

const VERBS: Record<string, string> = {
  'issue.created': 'filed',
  'issue.started': 'started',
  'issue.closed': 'closed',
  'issue.reopened': 'reopened',
  'issue.needs_human': 'asked for you',
  'issue.needs_human_cleared': 'question resolved',
  'issue.session_attached': 'agent attached',
}

export function feedEventLine(event: FeedEvent, issue: IssueWire | undefined): string {
  const label = issue ? `#${issue.seq} ${issue.title}` : 'an issue'
  if (event.kind === 'issue.stage_changed') {
    const to = (event.payload as { to?: string } | null)?.to
    return `${label} — moved to ${to ?? 'a new stage'}`
  }
  return `${label} — ${VERBS[event.kind] ?? event.kind.replace('issue.', '').replace(/_/g, ' ')}`
}

const clock = (ts: string): string => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** An event that lands in the TRAY of the current scope gets the ↑ pointer;
 *  everything else points away (→ #seq) and clicking follows it. */
const landsInTray = (kind: string, payload: unknown): boolean =>
  kind === 'issue.needs_human' ||
  (kind === 'issue.stage_changed' && (payload as { to?: string } | null)?.to === 'review')

/**
 * The cross-project event strip of the super agent chat (engraved-column.md
 * §2.5): a capped, quiet tail of issue events — every row in ITS issue's
 * colour (the feed is global even when the column is scoped) — with the
 * YOU WERE HERE divider frozen at the last-seen cursor. True chronological
 * interleave with the transcript is #56; this strip sits above it.
 */
export function EventFeed({
  events,
  issues,
  selectedIssueId,
  dividerId,
  dividerTs,
  onSelectIssue,
}: {
  events: FeedEvent[]
  issues: IssueWire[]
  selectedIssueId: string | null
  dividerId: number
  dividerTs: string | null
  onSelectIssue: (issueId: string) => void
}): JSX.Element | null {
  if (events.length === 0) return null
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const scopeIds = new Set(trayScopeIssues(issues, selectedIssueId).map((issue) => issue.id))
  const firstUnseen = events.findIndex((event) => event.id > dividerId)
  return (
    <div
      data-testid="super-event-feed"
      className="flex max-h-[132px] flex-none flex-col gap-[3px] overflow-y-auto border-b border-hairline-soft px-3.5 py-2"
    >
      {events.map((event, index) => {
        const issue = byId.get(event.subject)
        const hex = issueColorHex(issue?.color) ?? FLOW_SLATE
        const inScope = issue !== undefined && scopeIds.has(issue.id)
        return (
          <div key={event.id} className="contents">
            {index === firstUnseen && dividerId > 0 && (
              <div
                data-testid="you-were-here"
                className="flex items-center gap-2 py-0.5 font-mono text-[9px] tracking-[.08em] text-attention"
              >
                <span className="h-px flex-1 bg-[rgba(245,158,11,.4)]" />
                YOU WERE HERE{dividerTs ? ` · ${clock(dividerTs)}` : ''}
                <span className="h-px flex-1 bg-[rgba(245,158,11,.4)]" />
              </div>
            )}
            <button
              type="button"
              className="flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-[10.5px] text-text-dim hover:text-muted-foreground"
              onClick={() => issue && onSelectIssue(issue.id)}
              title={issue ? `#${issue.seq} ${issue.title}` : undefined}
            >
              <span className="flex-none font-mono text-[9px]">{clock(event.ts)}</span>
              <span
                className="size-[7px] flex-none rounded-[2.5px]"
                style={{ background: hex }}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">{feedEventLine(event, issue)}</span>
              <span className="ml-auto flex-none text-attention">
                {inScope && landsInTray(event.kind, event.payload)
                  ? '↑'
                  : !inScope && issue
                    ? `→ #${issue.seq}`
                    : ''}
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
