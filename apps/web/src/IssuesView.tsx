import { ISSUE_STAGES, type IssueStage, type IssueWire } from '@podium/protocol'
import { Plus } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CardBoundary } from './CardBoundary'
import { issueCardModel } from './issue-card'
import { NewIssueDialog } from './NewIssueDialog'
import { useStore } from './store'

const STAGE_LABELS: Record<IssueStage, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  review: 'Review',
  verifying: 'Verifying',
  done: 'Done',
}

/**
 * The Issues board — a kanban over the issue lifecycle stages. One column per
 * stage in `ISSUE_STAGES` order, each holding the active (non-archived) issues
 * in that stage. Cards open a detail panel; the header opens the new-issue
 * dialog. Issues come live from the store (hub-subscribed) — mutations broadcast
 * `issuesChanged`, so the board reconciles itself with no manual refetch.
 */
export function IssuesView(): JSX.Element {
  const { issues, setOpenIssueId } = useStore()
  const [creating, setCreating] = useState(false)
  const active = issues.filter((i) => !i.archived)

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Issues">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <h2 className="font-medium text-base text-foreground">Issues</h2>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" /> New Issue
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 md:p-4">
        {ISSUE_STAGES.map((stage) => (
          <IssueColumn
            key={stage}
            label={STAGE_LABELS[stage]}
            issues={active.filter((i) => i.stage === stage)}
            onOpen={setOpenIssueId}
          />
        ))}
      </div>
      {creating && <NewIssueDialog onClose={() => setCreating(false)} />}
    </section>
  )
}

function IssueColumn({
  label,
  issues,
  onOpen,
}: {
  label: string
  issues: IssueWire[]
  onOpen: (id: string) => void
}): JSX.Element {
  return (
    <div className="flex w-[280px] min-w-[280px] flex-col gap-2 rounded-lg bg-muted/40 p-2">
      <div className="flex items-center justify-between px-1 py-0.5">
        <h3 className="font-medium text-[13px] text-foreground">{label}</h3>
        <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">
          {issues.length}
        </span>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto">
        {issues.length === 0 ? (
          <p className="px-1 py-2 text-[12px] text-muted-foreground/60">No issues.</p>
        ) : (
          issues.map((issue) => (
            <CardBoundary key={issue.id} resetKey={issue.id} label="issue card">
              <IssueCard issue={issue} onOpen={onOpen} />
            </CardBoundary>
          ))
        )}
      </div>
    </div>
  )
}

function IssueCard({
  issue,
  onOpen,
}: {
  issue: IssueWire
  onOpen: (id: string) => void
}): JSX.Element {
  const m = issueCardModel(issue)
  return (
    <button
      type="button"
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/60',
      )}
      onClick={() => onOpen(issue.id)}
    >
      <div className="min-w-0 break-words font-medium text-[13px] text-foreground">{m.title}</div>
      <div className="text-[11px] text-muted-foreground">{m.subtitle}</div>
      {(m.phaseBadges.length > 0 || issue.linearIdentifier) && (
        <div className="flex flex-wrap gap-1">
          {m.phaseBadges.map((b) => (
            <Badge key={b.label} variant="secondary" className="font-normal">
              {b.label}
            </Badge>
          ))}
          {issue.linearIdentifier && (
            <Badge variant="outline" className="font-normal">
              {issue.linearIdentifier}
            </Badge>
          )}
        </div>
      )}
      {m.hasSuggestion && issue.suggestedStage && (
        <div className="text-[11px] text-primary">
          Suggested: move to {STAGE_LABELS[issue.suggestedStage]}
        </div>
      )}
      {issue.activityNotes && (
        <div className="line-clamp-2 text-[11px] text-muted-foreground/80">
          {issue.activityNotes}
        </div>
      )}
    </button>
  )
}
