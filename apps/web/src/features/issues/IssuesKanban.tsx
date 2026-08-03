import type { IssueId, IssueStage } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Bot, CircleUser, Flag, Plus } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useRef, useState } from 'react'
import { CardBoundary } from '@/app/CardBoundary'
import type { IssueViewModel } from '@/app/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { issueCardModel, issueIdTitle, STAGE_LABELS } from './issue-card'
import { AssigneeAvatar, PriorityGlyph, StageGlyph } from './issue-glyphs'
import { isEpic } from './issue-hierarchy'
import type { EpicProgress, IssuesDisplay } from './issues-display'
import { dropTargetStage } from './kanban-dnd'
import {
  ISSUE_RENDER_CHUNK,
  nextProgressiveRenderLimit,
  progressiveRenderLimit,
} from './progressive-render'

export interface IssuesKanbanProps {
  columns: { stage: IssueStage; issues: IssueViewModel[] }[]
  allIssues: IssueViewModel[]
  badges: IssuesDisplay['badges']
  stageCounts: Map<string, { stage: IssueStage; count: number }[]>
  epicProgress: Map<string, EpicProgress | null>
  onOpen: (id: IssueId) => void
  onMoveIssue: (id: string, stage: IssueStage) => void
  onApprove: (id: IssueId) => void
  onApproveStart: (id: IssueId) => void
  onArchive: (id: string) => void
  onCreateIn: (stage: IssueStage) => void
  onSetAssignee: (id: string, assignee: string) => void
  assignees: string[]
  focusId: string | null
  selected: string[]
  onToggleSelect: (id: IssueId) => void
  onContextMenu: (id: IssueId, event: ReactMouseEvent) => void
}

export function IssuesKanban(props: IssuesKanbanProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 md:p-4">
      {props.columns.map(({ stage, issues }) => (
        <IssueColumn
          key={stage}
          stage={stage}
          issues={issues}
          allIssues={props.allIssues}
          badges={props.badges}
          stageCounts={props.stageCounts}
          epicProgress={props.epicProgress}
          onOpen={props.onOpen}
          onMoveIssue={props.onMoveIssue}
          onApprove={props.onApprove}
          onApproveStart={props.onApproveStart}
          onArchive={props.onArchive}
          onCreateIn={props.onCreateIn}
          onSetAssignee={props.onSetAssignee}
          assignees={props.assignees}
          focusId={props.focusId}
          selected={props.selected}
          onToggleSelect={props.onToggleSelect}
          onContextMenu={props.onContextMenu}
        />
      ))}
    </div>
  )
}

function IssueColumn({
  stage,
  issues,
  allIssues,
  badges,
  stageCounts,
  epicProgress,
  onOpen,
  onMoveIssue,
  onApprove,
  onApproveStart,
  onArchive,
  onCreateIn,
  onSetAssignee,
  assignees,
  focusId,
  selected,
  onToggleSelect,
  onContextMenu,
}: Omit<IssuesKanbanProps, 'columns'> & {
  stage: IssueStage
  issues: IssueViewModel[]
}): JSX.Element {
  const [over, setOver] = useState(false)
  const scopeKey = issues.map((issue) => issue.id).join('\0')
  const scopeRef = useRef({ key: scopeKey, version: 0 })
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = { key: scopeKey, version: scopeRef.current.version + 1 }
  }
  const scopeVersion = scopeRef.current.version
  const [reveal, setReveal] = useState({ scopeVersion, count: ISSUE_RENDER_CHUNK })
  const revealed = reveal.scopeVersion === scopeVersion ? reveal.count : ISSUE_RENDER_CHUNK
  const requiredIds = new Set(selected)
  if (focusId) requiredIds.add(focusId)
  const limit = progressiveRenderLimit(
    issues.map((issue) => issue.id),
    revealed,
    requiredIds,
  )
  const visibleIssues = issues.slice(0, limit)
  const remaining = issues.length - limit
  const label = STAGE_LABELS[stage]
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: kanban column is a native-DnD drop target
    <div
      className={cn(
        'flex w-[280px] min-w-[280px] flex-col gap-2 rounded-lg bg-muted/40 p-2 transition-colors',
        over && 'ring-2 ring-primary/50',
      )}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false)
        const id = event.dataTransfer.getData('text/issue-id')
        const target = dropTargetStage(stage)
        if (id && target) onMoveIssue(id, target)
      }}
    >
      <div className="flex items-center gap-1.5 px-1 py-0.5">
        <StageGlyph stage={stage} />
        <h3 className="font-medium text-[13px] text-foreground">{label}</h3>
        <span className="text-[11px] text-muted-foreground tabular-nums">{issues.length}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto size-5"
          title={`New task in ${label}`}
          aria-label={`New task in ${label}`}
          onClick={() => onCreateIn(stage)}
        >
          <Plus size={13} aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto">
        {issues.length === 0 ? (
          <p className="px-1 py-2 text-[12px] text-muted-foreground/60">No tasks.</p>
        ) : (
          visibleIssues.map((issue) => (
            <CardBoundary key={issue.id} resetKey={issue.id} label="issue card">
              <IssueCard
                issue={issue}
                allIssues={allIssues}
                badges={badges}
                stageCounts={stageCounts.get(issue.id)}
                progress={epicProgress.get(issue.id) ?? null}
                onOpen={onOpen}
                onApprove={onApprove}
                onApproveStart={onApproveStart}
                onArchive={onArchive}
                onSetAssignee={onSetAssignee}
                assignees={assignees}
                focused={focusId === issue.id}
                selected={selected.includes(issue.id)}
                onToggleSelect={onToggleSelect}
                onContextMenu={onContextMenu}
              />
            </CardBoundary>
          ))
        )}
        {remaining > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full flex-none text-muted-foreground"
            onClick={() =>
              setReveal({
                scopeVersion,
                count: nextProgressiveRenderLimit(revealed, issues.length),
              })
            }
          >
            Show {Math.min(ISSUE_RENDER_CHUNK, remaining)} more tasks ({remaining} remaining)
          </Button>
        )}
      </div>
    </div>
  )
}

function AssigneeMenu({
  issue,
  assignees,
  onSetAssignee,
  trigger,
}: {
  issue: IssueViewModel
  assignees: string[]
  onSetAssignee: (id: string, assignee: string) => void
  trigger: JSX.Element
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          // A span avoids invalid nested buttons inside the issue card button.
          // biome-ignore lint/a11y/useSemanticElements: a button would be invalidly nested in the card button
          <span
            data-pressable
            role="button"
            tabIndex={0}
            title="Set assignee"
            aria-label="Set assignee"
            className="inline-flex cursor-pointer"
          >
            {trigger}
          </span>
        }
      />
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={() => onSetAssignee(issue.id, '')}>Unassigned</DropdownMenuItem>
        {assignees.length > 0 && <DropdownMenuSeparator />}
        {assignees.map((assignee) => (
          <DropdownMenuItem key={assignee} onClick={() => onSetAssignee(issue.id, assignee)}>
            {assignee}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function IssueCard({
  issue,
  allIssues,
  badges,
  stageCounts,
  progress,
  onOpen,
  onApprove,
  onApproveStart,
  onArchive,
  onSetAssignee,
  assignees,
  focused,
  selected,
  onToggleSelect,
  onContextMenu,
}: {
  issue: IssueViewModel
  allIssues: IssueViewModel[]
  badges: IssuesDisplay['badges']
  stageCounts?: { stage: IssueStage; count: number }[]
  progress?: EpicProgress | null
  onOpen: (id: IssueId) => void
  onApprove: (id: IssueId) => void
  onApproveStart: (id: IssueId) => void
  onArchive: (id: string) => void
  onSetAssignee: (id: string, assignee: string) => void
  assignees: string[]
  focused: boolean
  selected: boolean
  onToggleSelect: (id: IssueId) => void
  onContextMenu: (id: IssueId, event: ReactMouseEvent) => void
}): JSX.Element {
  const model = issueCardModel(issue)
  const discovered = issue.deps.find((dependency) => dependency.type === 'discovered-from')
  const discoveredFrom = discovered
    ? allIssues.find((candidate) => candidate.id === discovered.id)
    : undefined
  const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(issue.createdAt)) / 86_400_000))
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: card is a native-DnD drag source
    <div
      className="group relative"
      draggable
      onDragStart={(event) => event.dataTransfer.setData('text/issue-id', issue.id)}
    >
      <button
        data-pressable
        type="button"
        data-issue-id={issue.id}
        className={cn(
          'flex w-full flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/60',
          focused && 'ring-2 ring-primary/60',
          selected && 'bg-primary/10',
        )}
        title={issueIdTitle(issue)}
        onClick={(event) => (event.shiftKey ? onToggleSelect(issue.id) : onOpen(issue.id))}
        onContextMenu={(event) => onContextMenu(issue.id, event)}
      >
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
            {model.seqLabel}
            {issue.origin === 'agent' && (
              <Bot
                size={11}
                className="text-muted-foreground/70"
                aria-label="Created by an agent"
              />
            )}
          </span>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stops card-open when picking assignee */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the inner menu trigger handles keyboard events */}
          <span onClick={(event) => event.stopPropagation()}>
            <AssigneeMenu
              issue={issue}
              assignees={assignees}
              onSetAssignee={onSetAssignee}
              trigger={<AssigneeAvatar assignee={model.assignee} />}
            />
          </span>
        </div>
        <div className="line-clamp-2 min-w-0 break-words font-medium text-[13px] text-foreground">
          {model.title}
        </div>
        {issue.description && (
          <p className="line-clamp-2 text-[11px] text-muted-foreground">{issue.description}</p>
        )}
        {issue.stage === 'proposed' && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>{issue.origin === 'agent' ? 'Agent proposal' : 'Proposal'}</span>
            <span>·</span>
            <span>{ageDays === 0 ? 'today' : `${ageDays}d old`}</span>
            {discoveredFrom && <span>· found while working {issueDisplayRef(discoveredFrom)}</span>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityGlyph priority={issue.priority} />
          {issue.deletedAt && (
            <Badge variant="destructive" className="font-normal">
              Deleted
            </Badge>
          )}
          {isEpic(issue) && (
            <Badge
              variant="outline"
              className="border-violet-500/50 font-normal text-violet-600 dark:text-violet-400"
            >
              Epic
            </Badge>
          )}
          {badges.type && issue.type !== 'epic' && (
            <Badge variant="outline" className="font-normal">
              {model.typeLabel}
            </Badge>
          )}
          {badges.labels &&
            model.labels.slice(0, 3).map((label) => (
              <Badge key={label} variant="secondary" className="font-normal">
                {label}
              </Badge>
            ))}
          {badges.labels && model.labels.length > 3 && (
            <Badge variant="secondary" className="font-normal">
              +{model.labels.length - 3}
            </Badge>
          )}
          {model.subProgress && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {model.subProgress.done}/{model.subProgress.total}
            </span>
          )}
          {progress && progress.liveAgents > 0 && (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-live tabular-nums"
              title={`${progress.liveAgents} subtask${progress.liveAgents === 1 ? '' : 's'} being worked · ${progress.done}/${progress.total} done in subtree`}
              data-testid="epic-live-agents"
            >
              <span className="size-1.5 rounded-full bg-live" aria-hidden />
              {progress.liveAgents}
            </span>
          )}
          {stageCounts?.map(({ stage, count }) => (
            <span
              key={stage}
              className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums"
              title={`${count} ${STAGE_LABELS[stage].toLowerCase()}`}
              data-testid={`stage-chip-${stage}`}
            >
              <StageGlyph stage={stage} size={11} />
              {count}
            </span>
          ))}
          {model.isBlocked && <Flag size={12} className="text-orange-500" aria-label="Blocked" />}
          {model.isBlocking && <Flag size={12} className="text-red-500" aria-label="Blocking" />}
          {model.needsHuman && (
            <CircleUser size={12} className="text-amber-500" aria-label="Needs human" />
          )}
          {badges.due && model.dueLabel && (
            <span className="text-[11px] text-muted-foreground">{model.dueLabel}</span>
          )}
          {badges.estimate && model.estimateLabel && (
            <span className="text-[11px] text-muted-foreground">{model.estimateLabel}</span>
          )}
          {badges.sessions && model.sessionCount > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              ▣ {model.sessionCount}
            </span>
          )}
        </div>
      </button>
      {issue.stage === 'proposed' && (
        <div className="mt-1 flex gap-1 px-1" data-testid="proposal-actions">
          <Button size="sm" className="h-6 flex-1 text-[10px]" onClick={() => onApprove(issue.id)}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 flex-1 text-[10px]"
            onClick={() => onApproveStart(issue.id)}
          >
            Approve &amp; start
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={() => onArchive(issue.id)}
          >
            Archive
          </Button>
        </div>
      )}
    </div>
  )
}
