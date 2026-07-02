import { ISSUE_STAGES, type IssueStage, IssueType, type IssueWire } from '@podium/protocol'
import { CircleUser, Flag, ListFilter, Plus, SlidersHorizontal, X } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
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
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { CardBoundary } from './CardBoundary'
import { AssigneeAvatar, PriorityGlyph, StageGlyph } from './issue-glyphs'
import { type BoardFilter, clearChip, filterBoardIssues, filterChips } from './issue-board-filter'
import { issueCardModel, STAGE_LABELS } from './issue-card'
import {
  DISPLAY_KEY,
  type IssuesDisplay,
  type IssuesLayout,
  type IssuesOrdering,
  orderIssues,
  readIssuesDisplay,
  writeIssuesDisplay,
} from './issues-display'
import { dropTargetStage } from './kanban-dnd'
import { NewIssueDialog } from './NewIssueDialog'
import { useStore } from './store'

/** A display-options change — badges may be patched field-by-field. */
type DisplayPatch = Partial<Omit<IssuesDisplay, 'badges'>> & {
  badges?: Partial<IssuesDisplay['badges']>
}

/**
 * The Issues board — a Linear-style kanban over the issue lifecycle stages. One
 * lane per stage in `ISSUE_STAGES` order, each holding the active (non-archived)
 * issues in that stage, sorted by the display ordering. Cards open a detail
 * panel; the header's Filter/Display menus narrow and shape the view (display
 * options persist to localStorage), and lane `+`/`New Issue` open the composer.
 * Issues come live from the store (hub-subscribed) — mutations broadcast
 * `issuesChanged`, so the board reconciles itself with no manual refetch.
 */
export function IssuesView(): JSX.Element {
  const { issues, setOpenIssueId, trpc } = useStore()
  // Display options (layout / ordering / badge visibility), persisted so the
  // board looks the same across reloads. Field-by-field fallback on read.
  const [display, setDisplay] = useState<IssuesDisplay>(() =>
    readIssuesDisplay(localStorage.getItem(DISPLAY_KEY)),
  )
  const updateDisplay = (patch: DisplayPatch): void => {
    const next = { ...display, ...patch, badges: { ...display.badges, ...(patch.badges ?? {}) } }
    setDisplay(next)
    localStorage.setItem(DISPLAY_KEY, writeIssuesDisplay(next))
  }
  // `null` = composer closed; an object opens it, optionally pre-setting the lane.
  const [creating, setCreating] = useState<null | { stage?: IssueStage }>(null)
  // Board-wide filter/search. AND-composed; an empty filter shows everything.
  const [filter, setFilter] = useState<BoardFilter>({})
  // Surface any drag-drop / mutation failure verbatim — the server re-broadcasts
  // the authoritative board, so we only need to show the error.
  const [error, setError] = useState('')
  // Hide archived, then narrow by the filter — both run before the issues are
  // split into per-stage lanes, so each lane reflects the same view.
  const active = filterBoardIssues(
    issues.filter((i) => !i.archived),
    filter,
  )
  // Distinct assignees / labels across the (unfiltered, non-archived) board —
  // the Filter and Assignee menus offer whatever is actually in use.
  const scope = issues.filter((i) => !i.archived)
  const assignees = [...new Set(scope.map((i) => i.assignee).filter(Boolean))].sort() as string[]
  const labels = [...new Set(scope.flatMap((i) => i.labels))].sort()

  // Fire a board mutation; on rejection show the message. Success needs no
  // handling — the `issuesChanged` broadcast reconciles the board.
  const runMut = (p: Promise<unknown>): void => {
    setError('')
    p.catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  const moveIssue = (id: string, stage: IssueStage): void => {
    runMut(trpc.issues.update.mutate({ id, patch: { stage } }))
  }

  const setAssignee = (id: string, assignee: string): void => {
    runMut(trpc.issues.update.mutate({ id, patch: { assignee } }))
  }

  const chips = filterChips(filter)

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Issues">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <h2 className="font-medium text-base text-foreground">Issues</h2>
        <div className="flex items-center gap-2">
          <FilterMenu filter={filter} onChange={setFilter} labels={labels} assignees={assignees} />
          <DisplayMenu display={display} onChange={updateDisplay} />
          <Button type="button" size="sm" onClick={() => setCreating({})}>
            <Plus size={14} aria-hidden="true" /> New Issue
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-border border-b px-4 py-2 md:px-[22px]">
        <Input
          value={filter.text ?? ''}
          onChange={(e) => setFilter({ ...filter, text: e.target.value || undefined })}
          placeholder="Search issues…"
          aria-label="Search issues"
          className="h-8 w-full max-w-[240px] flex-1"
        />
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[12px]"
            onClick={() => setFilter(clearChip(filter, c.key))}
            title="Remove filter"
          >
            {c.label} <X size={11} aria-hidden="true" />
          </button>
        ))}
      </div>

      {display.layout === 'list' ? (
        // List layout lands in Task 6 — keep the seam so the board branch is stable.
        <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Issues list" />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 md:p-4">
          {ISSUE_STAGES.map((stage) => (
            <IssueColumn
              key={stage}
              stage={stage}
              label={STAGE_LABELS[stage]}
              issues={orderIssues(
                active.filter((i) => i.stage === stage),
                display.ordering,
              )}
              badges={display.badges}
              onOpen={setOpenIssueId}
              onMoveIssue={moveIssue}
              onCreateIn={(s) => setCreating({ stage: s })}
              onSetAssignee={setAssignee}
              assignees={assignees}
            />
          ))}
        </div>
      )}

      {error && (
        <div
          className="border-border border-t px-4 py-2 text-[12px] text-destructive"
          role="status"
        >
          {error}
        </div>
      )}
      {creating && (
        <NewIssueDialog initialStage={creating.stage} onClose={() => setCreating(null)} />
      )}
    </section>
  )
}

const STATUS_OPTIONS: NonNullable<BoardFilter['status']>[] = [
  'open',
  'closed',
  'ready',
  'blocked',
  'deferred',
]

/**
 * Header Filter menu. One submenu per dimension (Priority / Type / Status /
 * Stage / Label); selecting an option sets that `BoardFilter` field (chips
 * below the header clear them). Label options are whatever labels are in use.
 */
function FilterMenu({
  filter,
  onChange,
  labels,
  assignees,
}: {
  filter: BoardFilter
  onChange: (f: BoardFilter) => void
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
            {[0, 1, 2, 3, 4].map((p) => (
              <DropdownMenuItem key={p} onClick={() => set({ priority: p })}>
                P{p}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Type</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {IssueType.options.map((t) => (
              <DropdownMenuItem key={t} onClick={() => set({ type: t })}>
                {t}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {STATUS_OPTIONS.map((s) => (
              <DropdownMenuItem key={s} onClick={() => set({ status: s })}>
                {s}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Stage</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {ISSUE_STAGES.map((s) => (
              <DropdownMenuItem key={s} onClick={() => set({ stage: s })}>
                {STAGE_LABELS[s]}
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
              assignees.map((a) => (
                <DropdownMenuItem key={a} onClick={() => set({ assignee: a })}>
                  {a}
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
              labels.map((l) => (
                <DropdownMenuItem key={l} onClick={() => set({ label: l })}>
                  {l}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
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

/**
 * Header Display menu — layout (Board / List) and ordering radio groups plus
 * per-badge visibility checkboxes. Every change persists via `updateDisplay`.
 */
function DisplayMenu({
  display,
  onChange,
}: {
  display: IssuesDisplay
  onChange: (patch: DisplayPatch) => void
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
        <DropdownMenuLabel>Layout</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={display.layout}
          onValueChange={(v) => onChange({ layout: v as IssuesLayout })}
        >
          <DropdownMenuRadioItem value="board">Board</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="list">List</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Ordering</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={display.ordering}
          onValueChange={(v) => onChange({ ordering: v as IssuesOrdering })}
        >
          {(Object.keys(ORDERING_LABELS) as IssuesOrdering[]).map((o) => (
            <DropdownMenuRadioItem key={o} value={o}>
              {ORDERING_LABELS[o]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Badges</DropdownMenuLabel>
        {BADGE_LABELS.map(({ key, label }) => (
          <DropdownMenuCheckboxItem
            key={key}
            checked={display.badges[key]}
            onCheckedChange={(c) => onChange({ badges: { [key]: c === true } })}
          >
            {label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function IssueColumn({
  stage,
  label,
  issues,
  badges,
  onOpen,
  onMoveIssue,
  onCreateIn,
  onSetAssignee,
  assignees,
}: {
  stage: IssueStage
  label: string
  issues: IssueWire[]
  badges: IssuesDisplay['badges']
  onOpen: (id: string) => void
  onMoveIssue: (id: string, stage: IssueStage) => void
  onCreateIn: (stage: IssueStage) => void
  onSetAssignee: (id: string, assignee: string) => void
  assignees: string[]
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
      <div className="flex items-center gap-1.5 px-1 py-0.5">
        <StageGlyph stage={stage} />
        <h3 className="font-medium text-[13px] text-foreground">{label}</h3>
        <span className="text-[11px] text-muted-foreground tabular-nums">{issues.length}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto size-5"
          title={`New issue in ${label}`}
          aria-label={`New issue in ${label}`}
          onClick={() => onCreateIn(stage)}
        >
          <Plus size={13} aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto">
        {issues.length === 0 ? (
          <p className="px-1 py-2 text-[12px] text-muted-foreground/60">No issues.</p>
        ) : (
          issues.map((issue) => (
            <CardBoundary key={issue.id} resetKey={issue.id} label="issue card">
              <IssueCard
                issue={issue}
                badges={badges}
                onOpen={onOpen}
                onSetAssignee={onSetAssignee}
                assignees={assignees}
              />
            </CardBoundary>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * Assignee picker — a thin dropdown of the distinct assignees in play plus an
 * "Unassigned" option; selecting fires an `assignee` patch ('' unassigns).
 * (Task 9 will swap this for the shared PropertyMenu with free-text entry.)
 */
function AssigneeMenu({
  issue,
  assignees,
  onSetAssignee,
  trigger,
}: {
  issue: IssueWire
  assignees: string[]
  onSetAssignee: (id: string, assignee: string) => void
  trigger: JSX.Element
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          // A span (not a button): this trigger is nested inside the card's own
          // button, so Base UI adds the menu-trigger semantics without producing
          // invalid nested-<button> markup.
          <span
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
        {assignees.map((a) => (
          <DropdownMenuItem key={a} onClick={() => onSetAssignee(issue.id, a)}>
            {a}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function IssueCard({
  issue,
  badges,
  onOpen,
  onSetAssignee,
  assignees,
}: {
  issue: IssueWire
  badges: IssuesDisplay['badges']
  onOpen: (id: string) => void
  onSetAssignee: (id: string, assignee: string) => void
  assignees: string[]
}): JSX.Element {
  const m = issueCardModel(issue)
  const show = badges
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: card is a native-DnD drag source
    <div
      className="group relative"
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/issue-id', issue.id)}
    >
      <button
        type="button"
        className="flex w-full flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/60"
        onClick={() => onOpen(issue.id)}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground tabular-nums">{m.seqLabel}</span>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stops card-open when picking assignee */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the inner menu trigger handles keyboard */}
          <span onClick={(e) => e.stopPropagation()}>
            <AssigneeMenu
              issue={issue}
              assignees={assignees}
              onSetAssignee={onSetAssignee}
              trigger={<AssigneeAvatar assignee={m.assignee} />}
            />
          </span>
        </div>
        <div className="line-clamp-2 min-w-0 break-words font-medium text-[13px] text-foreground">
          {m.title}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityGlyph priority={issue.priority} />
          {show.type && (
            <Badge variant="outline" className="font-normal">
              {m.typeLabel}
            </Badge>
          )}
          {show.labels &&
            m.labels.slice(0, 3).map((l) => (
              <Badge key={l} variant="secondary" className="font-normal">
                {l}
              </Badge>
            ))}
          {show.labels && m.labels.length > 3 && (
            <Badge variant="secondary" className="font-normal">
              +{m.labels.length - 3}
            </Badge>
          )}
          {m.subProgress && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {m.subProgress.done}/{m.subProgress.total}
            </span>
          )}
          {m.isBlocked && <Flag size={12} className="text-orange-500" aria-label="Blocked" />}
          {m.isBlocking && <Flag size={12} className="text-red-500" aria-label="Blocking" />}
          {m.needsHuman && (
            <CircleUser size={12} className="text-amber-500" aria-label="Needs human" />
          )}
          {show.due && m.dueLabel && (
            <span className="text-[11px] text-muted-foreground">{m.dueLabel}</span>
          )}
          {show.estimate && m.estimateLabel && (
            <span className="text-[11px] text-muted-foreground">{m.estimateLabel}</span>
          )}
          {show.sessions && m.sessionCount > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              ▣ {m.sessionCount}
            </span>
          )}
        </div>
      </button>
    </div>
  )
}
