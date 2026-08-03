import { ISSUE_STAGES, type IssueStage, IssueType } from '@podium/model'
import { Check, ListFilter, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PropertyMenu } from '@/lib/PropertyMenu'
import type { BoardFilter } from './issue-board-filter'
import { STAGE_LABELS } from './issue-card'
import { PriorityGlyph, StageGlyph } from './issue-glyphs'
import type { IssuesDisplay, IssuesLayout, IssuesOrdering } from './issues-display'
import type { IssuesDisplayPatch } from './issues-view-model'

export type PropMenuKind = 's' | 'p' | 'a' | 'l'

export function AnchoredIssueMenu({
  issue,
  kind,
  assignees,
  labelPool,
  onMoveIssue,
  onSetPriority,
  onSetAssignee,
  onToggleLabel,
  onClose,
}: {
  issue: IssueViewModel
  kind: PropMenuKind
  assignees: string[]
  labelPool: string[]
  onMoveIssue: (id: string, stage: IssueStage) => void
  onSetPriority: (id: string, priority: number) => void
  onSetAssignee: (id: string, assignee: string) => void
  onToggleLabel: (issue: IssueViewModel, label: string) => void
  onClose: () => void
}): JSX.Element {
  const element =
    typeof document === 'undefined' ? null : document.querySelector(`[data-issue-id="${issue.id}"]`)
  const rect = element?.getBoundingClientRect()
  const addable = labelPool.filter((label) => !issue.labels.includes(label))
  return (
    <DropdownMenu open modal={false} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger
        render={
          <span
            aria-hidden="true"
            style={{
              position: 'fixed',
              left: rect?.left ?? 0,
              top: rect?.bottom ?? 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />
        }
      />
      <DropdownMenuContent align="start" className="w-52">
        {kind === 's' &&
          ISSUE_STAGES.map((stage) => (
            <DropdownMenuItem key={stage} onClick={() => onMoveIssue(issue.id, stage)}>
              <StageGlyph stage={stage} />
              {STAGE_LABELS[stage]}
            </DropdownMenuItem>
          ))}
        {kind === 'p' &&
          [0, 1, 2, 3, 4].map((priority) => (
            <DropdownMenuItem key={priority} onClick={() => onSetPriority(issue.id, priority)}>
              <PriorityGlyph priority={priority} />P{priority}
            </DropdownMenuItem>
          ))}
        {kind === 'a' && (
          <>
            <DropdownMenuItem onClick={() => onSetAssignee(issue.id, '')}>
              Unassigned
            </DropdownMenuItem>
            {assignees.map((assignee) => (
              <DropdownMenuItem key={assignee} onClick={() => onSetAssignee(issue.id, assignee)}>
                {assignee}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {kind === 'l' && (
          <>
            {issue.labels.map((label) => (
              <DropdownMenuItem key={label} onClick={() => onToggleLabel(issue, label)}>
                <Check size={13} aria-hidden="true" /> {label}
              </DropdownMenuItem>
            ))}
            {addable.map((label) => (
              <DropdownMenuItem key={label} onClick={() => onToggleLabel(issue, label)}>
                {label}
              </DropdownMenuItem>
            ))}
            {issue.labels.length === 0 && addable.length === 0 && (
              <DropdownMenuItem disabled>No labels</DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function BulkBar({
  count,
  onStage,
  onPriority,
  onDelete,
  onClear,
}: {
  count: number
  onStage: (stage: IssueStage) => void
  onPriority: (priority: number) => void
  onDelete: () => void
  onClear: () => void
}): JSX.Element {
  return (
    <div className="-translate-x-1/2 fixed bottom-4 left-1/2 z-40 flex items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
      <span className="text-[13px] text-foreground tabular-nums">{count} selected</span>
      <div className="mx-1 h-4 w-px bg-border" />
      <PropertyMenu
        options={ISSUE_STAGES.map((stage) => ({
          value: stage,
          label: STAGE_LABELS[stage],
          icon: <StageGlyph stage={stage} />,
        }))}
        onSelect={(value) => onStage(value as IssueStage)}
        trigger={
          <Button type="button" variant="outline" size="sm">
            Stage
          </Button>
        }
      />
      <PropertyMenu
        options={[0, 1, 2, 3, 4].map((priority) => ({
          value: String(priority),
          label: `P${priority}`,
          icon: <PriorityGlyph priority={priority} />,
        }))}
        onSelect={(value) => onPriority(Number(value))}
        trigger={
          <Button type="button" variant="outline" size="sm">
            Priority
          </Button>
        }
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={onDelete}
      >
        <Trash2 size={14} aria-hidden="true" /> Delete
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
    </div>
  )
}

const STATUS_OPTIONS: NonNullable<BoardFilter['status']>[] = [
  'open',
  'closed',
  'ready',
  'blocked',
  'deferred',
]

export function FilterMenu({
  filter,
  onChange,
  labels,
  assignees,
}: {
  filter: BoardFilter
  onChange: (filter: BoardFilter) => void
  labels: string[]
  assignees: string[]
}): JSX.Element {
  const set = (patch: Partial<BoardFilter>): void => onChange({ ...filter, ...patch })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            <ListFilter size={14} aria-hidden="true" /> Filter
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {[0, 1, 2, 3, 4].map((priority) => (
              <DropdownMenuItem key={priority} onClick={() => set({ priority })}>
                P{priority}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Type</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {IssueType.options.map((type) => (
              <DropdownMenuItem key={type} onClick={() => set({ type })}>
                {type}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {STATUS_OPTIONS.map((status) => (
              <DropdownMenuItem key={status} onClick={() => set({ status })}>
                {status}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Stage</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {ISSUE_STAGES.map((stage) => (
              <DropdownMenuItem key={stage} onClick={() => set({ stage })}>
                {STAGE_LABELS[stage]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Assignee</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {assignees.length === 0 ? (
              <DropdownMenuItem disabled>No assignees</DropdownMenuItem>
            ) : (
              assignees.map((assignee) => (
                <DropdownMenuItem key={assignee} onClick={() => set({ assignee })}>
                  {assignee}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Label</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {labels.length === 0 ? (
              <DropdownMenuItem disabled>No labels</DropdownMenuItem>
            ) : (
              labels.map((label) => (
                <DropdownMenuItem key={label} onClick={() => set({ label })}>
                  {label}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={!!filter.archived}
          onCheckedChange={(checked) => set({ archived: checked === true ? true : undefined })}
        >
          Show archived
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={!!filter.deleted}
          onCheckedChange={(checked) => set({ deleted: checked === true ? true : undefined })}
        >
          Show deleted
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const ORDERING_LABELS: Record<IssuesOrdering, string> = {
  priority: 'Priority',
  updated: 'Last updated',
  created: 'Created',
}
const BADGE_LABELS: { key: keyof IssuesDisplay['badges']; label: string }[] = [
  { key: 'labels', label: 'Labels' },
  { key: 'type', label: 'Type' },
  { key: 'estimate', label: 'Estimate' },
  { key: 'due', label: 'Due date' },
  { key: 'sessions', label: 'Sessions' },
]

export function DisplayMenu({
  display,
  onChange,
  showLayout,
}: {
  display: IssuesDisplay
  onChange: (patch: IssuesDisplayPatch) => void
  showLayout: boolean
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            <SlidersHorizontal size={14} aria-hidden="true" /> Display
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-48">
        {showLayout && (
          <>
            <DropdownMenuRadioGroup
              value={display.layout}
              onValueChange={(value) => onChange({ layout: value as IssuesLayout })}
            >
              <DropdownMenuLabel>Layout</DropdownMenuLabel>
              <DropdownMenuRadioItem value="board">Board</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="list">List</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuRadioGroup
          value={display.ordering}
          onValueChange={(value) => onChange({ ordering: value as IssuesOrdering })}
        >
          <DropdownMenuLabel>Ordering</DropdownMenuLabel>
          {(Object.keys(ORDERING_LABELS) as IssuesOrdering[]).map((ordering) => (
            <DropdownMenuRadioItem key={ordering} value={ordering}>
              {ORDERING_LABELS[ordering]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={display.showAgentTasks}
          onCheckedChange={(checked) => onChange({ showAgentTasks: checked === true })}
        >
          Show agent tasks
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Badges</DropdownMenuLabel>
          {BADGE_LABELS.map(({ key, label }) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={display.badges[key]}
              onCheckedChange={(checked) => onChange({ badges: { [key]: checked === true } })}
            >
              {label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
