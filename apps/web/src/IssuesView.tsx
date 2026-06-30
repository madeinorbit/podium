import { ISSUE_STAGES, type IssueStage, type IssueWire } from '@podium/protocol'
import { Plus, Trash2 } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CardBoundary } from './CardBoundary'
import { issueCardModel, STAGE_LABELS } from './issue-card'
import { dropTargetStage } from './kanban-dnd'
import { NewIssueDialog } from './NewIssueDialog'
import { useStore } from './store'

const STATUS_DOT_COLOR: Record<'ready' | 'blocked' | 'deferred' | 'closed' | 'open', string> = {
  ready: 'bg-green-500',
  blocked: 'bg-red-500',
  deferred: 'bg-amber-500',
  closed: 'bg-muted-foreground',
  open: 'bg-sky-500',
}

/**
 * The Issues board — a kanban over the issue lifecycle stages. One column per
 * stage in `ISSUE_STAGES` order, each holding the active (non-archived) issues
 * in that stage. Cards open a detail panel; the header opens the new-issue
 * dialog. Issues come live from the store (hub-subscribed) — mutations broadcast
 * `issuesChanged`, so the board reconciles itself with no manual refetch.
 */
export function IssuesView(): JSX.Element {
  const { issues, setOpenIssueId, trpc } = useStore()
  const [creating, setCreating] = useState(false)
  // Surface any drag-drop / delete mutation failure verbatim — the server
  // re-broadcasts the authoritative board, so we only need to show the error.
  const [error, setError] = useState('')
  const active = issues.filter((i) => !i.archived)

  // Fire a board mutation; on rejection show the message. Success needs no
  // handling — the `issuesChanged` broadcast reconciles the board.
  const runMut = (p: Promise<unknown>): void => {
    setError('')
    p.catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  const moveIssue = (id: string, stage: IssueStage): void => {
    runMut(trpc.issues.update.mutate({ id, patch: { stage } }))
  }

  const deleteIssue = (id: string): void => {
    runMut(trpc.issues.delete.mutate({ id }))
  }

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
            stage={stage}
            label={STAGE_LABELS[stage]}
            issues={active.filter((i) => i.stage === stage)}
            onOpen={setOpenIssueId}
            onMoveIssue={moveIssue}
            onDeleteIssue={deleteIssue}
          />
        ))}
      </div>
      {error && (
        <div
          className="border-border border-t px-4 py-2 text-[12px] text-destructive"
          role="status"
        >
          {error}
        </div>
      )}
      {creating && <NewIssueDialog onClose={() => setCreating(false)} />}
    </section>
  )
}

function IssueColumn({
  stage,
  label,
  issues,
  onOpen,
  onMoveIssue,
  onDeleteIssue,
}: {
  stage: IssueStage
  label: string
  issues: IssueWire[]
  onOpen: (id: string) => void
  onMoveIssue: (id: string, stage: IssueStage) => void
  onDeleteIssue: (id: string) => void
}): JSX.Element {
  // Highlight the column while a card is dragged over it. Native DnD fires
  // enter/leave on descendants too, so this can flicker — it's cosmetic only.
  const [over, setOver] = useState(false)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: kanban column is a native-DnD drop target
    <div
      className={cn(
        'flex w-[280px] min-w-[280px] flex-col gap-2 rounded-lg bg-muted/40 p-2 transition-colors',
        over && 'ring-2 ring-primary/50',
      )}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const id = e.dataTransfer.getData('text/issue-id')
        const s = dropTargetStage(stage)
        if (id && s) onMoveIssue(id, s)
      }}
    >
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
              <IssueCard issue={issue} onOpen={onOpen} onDelete={() => onDeleteIssue(issue.id)} />
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
  onDelete,
}: {
  issue: IssueWire
  onOpen: (id: string) => void
  onDelete: () => void
}): JSX.Element {
  const m = issueCardModel(issue)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: card is a native-DnD drag source
    <div
      className="group relative"
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/issue-id', issue.id)}
    >
      <button
        type="button"
        className={cn(
          'flex w-full flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/60',
        )}
        onClick={() => onOpen(issue.id)}
      >
        <div className="min-w-0 break-words pr-5 font-medium text-[13px] text-foreground">
          {m.title}
        </div>
        <div className="text-[11px] text-muted-foreground">{m.subtitle}</div>
        <div className="flex flex-wrap items-center gap-1">
          <span
            className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_COLOR[m.statusDot])}
            title={m.statusDot}
          />
          <Badge variant="outline" className="font-normal">
            {m.priorityLabel}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {m.typeLabel}
          </Badge>
          {m.labels.map((label) => (
            <Badge key={label} variant="secondary" className="font-normal">
              {label}
            </Badge>
          ))}
        </div>
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
      <button
        type="button"
        title="Delete issue"
        aria-label="Delete issue"
        className="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation()
          if (window.confirm(`Delete "${m.title}"? This can't be undone.`)) onDelete()
        }}
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
