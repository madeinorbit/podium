import { ISSUE_STAGES, type IssueStage, IssueType, type IssueWire } from '@podium/protocol'
import {
  Check,
  CircleUser,
  Flag,
  ListFilter,
  ListTree,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
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
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { CardBoundary } from './CardBoundary'
import { useIsMobile } from './hooks/use-is-mobile'
import { IssueListView } from './IssueListView'
import { IssuePage } from './IssuePage'
import { type BoardFilter, clearChip, filterBoardIssues, filterChips } from './issue-board-filter'
import { issueCardModel, STAGE_LABELS } from './issue-card'
import { AssigneeAvatar, PriorityGlyph, StageGlyph } from './issue-glyphs'
import {
  childStageCounts,
  flattenRowGroups,
  isEpic,
  issuePageOrderIds,
  issueRowsByStage,
  partitionIssueTree,
} from './issue-hierarchy'
import { groupIssuesByStage } from './issue-list'
import {
  DISPLAY_KEY,
  filterBoardScope,
  type IssuesDisplay,
  type IssuesLayout,
  type IssuesOrdering,
  readIssuesDisplay,
  writeIssuesDisplay,
} from './issues-display'
import {
  type IssuesKeyAction,
  type IssuesKeyState,
  type IssuesNav,
  issuesKeyReduce,
} from './issues-keys'
import { dropTargetStage } from './kanban-dnd'
import { NewIssueDialog } from './NewIssueDialog'
import { PropertyMenu } from './PropertyMenu'
import { useStore } from './store'

/** Which anchored property menu the keyboard opened, and for which issue. */
type PropMenuKind = 's' | 'p' | 'a' | 'l'
type PropMenuState = { kind: PropMenuKind; id: string }

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
  const { issues, openIssueId, setOpenIssueId, trpc } = useStore()
  // On phones the board's horizontal lanes don't fit — force the list layout.
  const isMobile = useIsMobile()
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
  // Keyboard focus (single) + multi-select set. The reducer keeps these in sync
  // with the visible nav; ids that vanish (moved/deleted/filtered) drop out.
  const [keyState, setKeyState] = useState<IssuesKeyState>({ focusId: null, selected: [] })
  // Which keyboard-anchored property menu (s/p/a/l) is open, and over which issue.
  const [propMenu, setPropMenu] = useState<PropMenuState | null>(null)
  // Parents whose nested children are revealed (list layout, nested mode only).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggleExpand = (id: string): void =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // Hide archived, drafts, and (unless toggled on) agent-origin issues, then
  // narrow by the filter — all before the issues are split into per-stage lanes,
  // so each lane reflects the same view.
  const scoped = filterBoardScope(
    issues.filter((i) => !i.archived),
    display.showAgentTasks,
  )
  const active = filterBoardIssues(scoped, filter)
  // Distinct assignees / labels across the (unfiltered) board scope —
  // the Filter and Assignee menus offer whatever is actually in use.
  const scope = scoped
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

  const setPriority = (id: string, priority: number): void => {
    runMut(trpc.issues.update.mutate({ id, patch: { priority } }))
  }

  // Add or remove a single label from an issue (keyboard `l` menu toggles).
  const toggleLabel = (issue: IssueWire, label: string): void => {
    const labels = issue.labels.includes(label)
      ? issue.labels.filter((l) => l !== label)
      : [...issue.labels, label]
    runMut(trpc.issues.setLabels.mutate({ id: issue.id, labels }))
  }

  const chips = filterChips(filter)
  const layout = isMobile ? 'list' : display.layout

  // Hierarchy (#85): by default only top-level issues (roots) surface — nested
  // children hide behind their parent's chevron (list) or roll up into the
  // parent card's n/m count (board). The Flatten toggle restores the old view.
  const boardIssues = display.flatten ? active : partitionIssueTree(active).roots
  // Nested board only: per-parent direct-child stage counts, so an epic card
  // says where its (lane-hidden) children stand. Computed over the whole
  // non-archived scope, not the filtered view — the rollup states a fact about
  // the epic, and a filter hiding a child shouldn't make the fact wrong.
  const stageCounts = display.flatten
    ? new Map<string, { stage: IssueStage; count: number }[]>()
    : childStageCounts(scope)

  // The per-stage ordered lanes / rows — computed once so the board render, the
  // list render, and the keyboard nav all agree on order. `listIds` flattens the
  // visible (expanded) rows top-to-bottom for the single-column list layout.
  const orderedByStage = groupIssuesByStage(boardIssues, display.ordering)
  const rowGroups = issueRowsByStage(active, display.ordering, {
    flatten: display.flatten,
    expanded,
  })
  const listIds = flattenRowGroups(rowGroups)
  const nav: IssuesNav =
    layout === 'list'
      ? { kind: 'rows', ids: listIds }
      : { kind: 'columns', columns: orderedByStage.map((c) => c.issues.map((i) => i.id)) }

  // Selection filtered to ids still visible (deleted/filtered-out/collapsed drop
  // off), so the bulk bar and highlights never reference stale issues.
  const presentIds = new Set(nav.kind === 'rows' ? nav.ids : nav.columns.flat())
  const selectedIds = keyState.selected.filter((id) => presentIds.has(id))
  const focusId = keyState.focusId

  // Latest nav / focus for the window key handler, which is attached once.
  const navRef = useRef(nav)
  navRef.current = nav
  const focusRef = useRef(focusId)
  focusRef.current = focusId

  const dispatchKey = useCallback((a: IssuesKeyAction): void => {
    setKeyState((s) => issuesKeyReduce(s, a, navRef.current))
  }, [])

  // Global keyboard nav for the board/list. Inactive while the issue page is open
  // (its own Esc handler owns keys), while any dialog/menu is open, or while a
  // form field is focused — so typing in the search box or composer is untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (openIssueId) return
      // Ignore modifier chords (Cmd/Ctrl/Alt) so browser/OS shortcuts —
      // copy, select-all, print, etc. — pass through untouched.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      )
        return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      switch (e.key) {
        case 'c':
          e.preventDefault()
          setCreating({})
          break
        case 'Escape':
          dispatchKey({ kind: 'clear' })
          break
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          dispatchKey({ kind: 'next' })
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          dispatchKey({ kind: 'prev' })
          break
        case 'ArrowLeft':
          e.preventDefault()
          dispatchKey({ kind: 'left' })
          break
        case 'ArrowRight':
          e.preventDefault()
          dispatchKey({ kind: 'right' })
          break
        case 'Enter': {
          const f = focusRef.current
          if (f) {
            e.preventDefault()
            setOpenIssueId(f)
          }
          break
        }
        case 'x':
          if (focusRef.current) {
            e.preventDefault()
            dispatchKey({ kind: 'toggleSelect' })
          }
          break
        case 's':
        case 'p':
        case 'a':
        case 'l': {
          const f = focusRef.current
          if (f) {
            e.preventDefault()
            setPropMenu({ kind: e.key, id: f })
            document.querySelector(`[data-issue-id="${f}"]`)?.scrollIntoView({ block: 'nearest' })
          }
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openIssueId, dispatchKey, setOpenIssueId])

  // Shift+click toggles the clicked issue in/out of the selection (focusing it too).
  const toggleSelectId = (id: string): void =>
    setKeyState((s) =>
      issuesKeyReduce({ ...s, focusId: id }, { kind: 'toggleSelect' }, navRef.current),
    )

  // Bulk-bar actions loop the mutation over the whole selection; the server
  // re-broadcasts the board so the view reconciles. Delete confirms once, then
  // clears the (now-gone) selection.
  const bulkStage = (stage: IssueStage): void =>
    runMut(
      Promise.all(selectedIds.map((id) => trpc.issues.update.mutate({ id, patch: { stage } }))),
    )
  const bulkPriority = (priority: number): void =>
    runMut(
      Promise.all(selectedIds.map((id) => trpc.issues.update.mutate({ id, patch: { priority } }))),
    )
  const bulkDelete = (): void => {
    if (selectedIds.length === 0) return
    const n = selectedIds.length
    if (!window.confirm(`Delete ${n} issue${n > 1 ? 's' : ''}? This can't be undone.`)) return
    runMut(Promise.all(selectedIds.map((id) => trpc.issues.delete.mutate({ id }))))
    setKeyState((s) => ({ ...s, selected: [] }))
  }

  // When an issue is open (and still exists), the board is replaced in-view by the
  // full issue page. Prev/next navigate the same flattened, grouped visual order.
  const open = openIssueId ? issues.find((i) => i.id === openIssueId) : undefined
  if (open) {
    return (
      <IssuePage
        issue={open}
        orderedIds={issuePageOrderIds(
          listIds,
          flattenRowGroups(issueRowsByStage(active, display.ordering, { flatten: true, expanded })),
          open.id,
        )}
        onBack={() => setOpenIssueId(null)}
        onNavigate={setOpenIssueId}
      />
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Issues">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <h2 className="font-medium text-base text-foreground">Issues</h2>
        <div className="flex items-center gap-2">
          <FilterMenu filter={filter} onChange={setFilter} labels={labels} assignees={assignees} />
          <DisplayMenu display={display} onChange={updateDisplay} showLayout={!isMobile} />
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
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[12px] transition-colors',
            display.flatten
              ? 'bg-primary/15 text-foreground'
              : 'bg-muted/50 text-muted-foreground hover:text-foreground',
          )}
          aria-pressed={display.flatten}
          title={
            display.flatten
              ? 'Showing all issues flat — click to nest sub-issues under parents'
              : 'Showing top-level issues — click to flatten sub-issues into the list'
          }
          onClick={() => updateDisplay({ flatten: !display.flatten })}
        >
          <ListTree size={12} aria-hidden="true" /> Flatten
        </button>
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

      {layout === 'list' ? (
        <IssueListView
          groups={rowGroups}
          display={display}
          onOpen={setOpenIssueId}
          onCreateIn={(stage) => setCreating({ stage })}
          focusId={focusId}
          selected={selectedIds}
          onToggleSelect={toggleSelectId}
          onToggleExpand={toggleExpand}
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 md:p-4">
          {orderedByStage.map(({ stage, issues: laneIssues }) => (
            <IssueColumn
              key={stage}
              stage={stage}
              label={STAGE_LABELS[stage]}
              issues={laneIssues}
              badges={display.badges}
              stageCounts={stageCounts}
              onOpen={setOpenIssueId}
              onMoveIssue={moveIssue}
              onCreateIn={(s) => setCreating({ stage: s })}
              onSetAssignee={setAssignee}
              assignees={assignees}
              focusId={focusId}
              selected={selectedIds}
              onToggleSelect={toggleSelectId}
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
      {selectedIds.length > 0 && (
        <BulkBar
          count={selectedIds.length}
          onStage={bulkStage}
          onPriority={bulkPriority}
          onDelete={bulkDelete}
          onClear={() => dispatchKey({ kind: 'clear' })}
        />
      )}
      {propMenu &&
        (() => {
          const target = active.find((i) => i.id === propMenu.id)
          return target ? (
            <AnchoredIssueMenu
              issue={target}
              kind={propMenu.kind}
              assignees={assignees}
              labelPool={labels}
              onMoveIssue={moveIssue}
              onSetPriority={setPriority}
              onSetAssignee={setAssignee}
              onToggleLabel={toggleLabel}
              onClose={() => setPropMenu(null)}
            />
          ) : null
        })()}
    </section>
  )
}

/**
 * A keyboard-anchored property menu (opened by `s`/`p`/`a`/`l`). It positions a
 * zero-size fixed trigger at the focused card/row's on-screen rect and opens the
 * matching options over it — Stage, Priority, Assignee, or Labels. Selecting an
 * option fires the corresponding mutation; any close (select / Esc / outside
 * click) calls `onClose`.
 */
function AnchoredIssueMenu({
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
  issue: IssueWire
  kind: PropMenuKind
  assignees: string[]
  labelPool: string[]
  onMoveIssue: (id: string, stage: IssueStage) => void
  onSetPriority: (id: string, priority: number) => void
  onSetAssignee: (id: string, assignee: string) => void
  onToggleLabel: (issue: IssueWire, label: string) => void
  onClose: () => void
}): JSX.Element {
  const el =
    typeof document !== 'undefined' ? document.querySelector(`[data-issue-id="${issue.id}"]`) : null
  const r = el?.getBoundingClientRect()
  const addable = labelPool.filter((l) => !issue.labels.includes(l))
  return (
    <DropdownMenu open modal={false} onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuTrigger
        render={
          <span
            aria-hidden="true"
            style={{
              position: 'fixed',
              left: r?.left ?? 0,
              top: r?.bottom ?? 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />
        }
      />
      <DropdownMenuContent align="start" className="w-52">
        {kind === 's' &&
          ISSUE_STAGES.map((s) => (
            <DropdownMenuItem key={s} onClick={() => onMoveIssue(issue.id, s)}>
              <StageGlyph stage={s} />
              {STAGE_LABELS[s]}
            </DropdownMenuItem>
          ))}
        {kind === 'p' &&
          [0, 1, 2, 3, 4].map((p) => (
            <DropdownMenuItem key={p} onClick={() => onSetPriority(issue.id, p)}>
              <PriorityGlyph priority={p} />P{p}
            </DropdownMenuItem>
          ))}
        {kind === 'a' && (
          <>
            <DropdownMenuItem onClick={() => onSetAssignee(issue.id, '')}>
              Unassigned
            </DropdownMenuItem>
            {assignees.map((a) => (
              <DropdownMenuItem key={a} onClick={() => onSetAssignee(issue.id, a)}>
                {a}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {kind === 'l' && (
          <>
            {issue.labels.map((l) => (
              <DropdownMenuItem key={l} onClick={() => onToggleLabel(issue, l)}>
                <Check size={13} aria-hidden="true" />
                {l}
              </DropdownMenuItem>
            ))}
            {addable.map((l) => (
              <DropdownMenuItem key={l} onClick={() => onToggleLabel(issue, l)}>
                {l}
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

/**
 * The multi-select action bar — a fixed bottom-center panel shown while any
 * issues are selected. Bulk Stage / Priority pickers loop their mutation over
 * the selection, Delete confirms once then removes them, and Clear drops the
 * selection.
 */
function BulkBar({
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
        options={ISSUE_STAGES.map((s) => ({
          value: s,
          label: STAGE_LABELS[s],
          icon: <StageGlyph stage={s} />,
        }))}
        onSelect={(v) => onStage(v as IssueStage)}
        trigger={
          <Button type="button" variant="outline" size="sm">
            Stage
          </Button>
        }
      />
      <PropertyMenu
        options={[0, 1, 2, 3, 4].map((p) => ({
          value: String(p),
          label: `P${p}`,
          icon: <PriorityGlyph priority={p} />,
        }))}
        onSelect={(v) => onPriority(Number(v))}
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
  showLayout,
}: {
  display: IssuesDisplay
  onChange: (patch: DisplayPatch) => void
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
              onValueChange={(v) => onChange({ layout: v as IssuesLayout })}
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
          onValueChange={(v) => onChange({ ordering: v as IssuesOrdering })}
        >
          <DropdownMenuLabel>Ordering</DropdownMenuLabel>
          {(Object.keys(ORDERING_LABELS) as IssuesOrdering[]).map((o) => (
            <DropdownMenuRadioItem key={o} value={o}>
              {ORDERING_LABELS[o]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={display.showAgentTasks}
          onCheckedChange={(c) => onChange({ showAgentTasks: c === true })}
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
              onCheckedChange={(c) => onChange({ badges: { [key]: c === true } })}
            >
              {label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function IssueColumn({
  stage,
  label,
  issues,
  badges,
  stageCounts,
  onOpen,
  onMoveIssue,
  onCreateIn,
  onSetAssignee,
  assignees,
  focusId,
  selected,
  onToggleSelect,
}: {
  stage: IssueStage
  label: string
  issues: IssueWire[]
  badges: IssuesDisplay['badges']
  stageCounts: Map<string, { stage: IssueStage; count: number }[]>
  onOpen: (id: string) => void
  onMoveIssue: (id: string, stage: IssueStage) => void
  onCreateIn: (stage: IssueStage) => void
  onSetAssignee: (id: string, assignee: string) => void
  assignees: string[]
  focusId: string | null
  selected: string[]
  onToggleSelect: (id: string) => void
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
                stageCounts={stageCounts.get(issue.id)}
                onOpen={onOpen}
                onSetAssignee={onSetAssignee}
                assignees={assignees}
                focused={focusId === issue.id}
                selected={selected.includes(issue.id)}
                onToggleSelect={onToggleSelect}
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
  stageCounts,
  onOpen,
  onSetAssignee,
  assignees,
  focused,
  selected,
  onToggleSelect,
}: {
  issue: IssueWire
  badges: IssuesDisplay['badges']
  /** Direct-child stage rollup (nested board only) — see childStageCounts. */
  stageCounts?: { stage: IssueStage; count: number }[]
  onOpen: (id: string) => void
  onSetAssignee: (id: string, assignee: string) => void
  assignees: string[]
  focused: boolean
  selected: boolean
  onToggleSelect: (id: string) => void
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
        data-issue-id={issue.id}
        className={cn(
          'flex w-full flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/60',
          focused && 'ring-2 ring-primary/60',
          selected && 'bg-primary/10',
        )}
        onClick={(e) => (e.shiftKey ? onToggleSelect(issue.id) : onOpen(issue.id))}
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
          {isEpic(issue) && (
            <Badge
              variant="outline"
              className="border-violet-500/50 font-normal text-violet-600 dark:text-violet-400"
            >
              Epic
            </Badge>
          )}
          {/* Skip the plain type badge for typed epics — the Epic badge already says it. */}
          {show.type && issue.type !== 'epic' && (
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
          {/* Nested board: the lanes hold roots only, so this card must say
              where its hidden children stand — one glyph+count chip per stage
              in play (e.g. ◔2 ●1 = 2 in-progress, 1 done). */}
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
