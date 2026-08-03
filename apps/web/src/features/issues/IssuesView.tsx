import type { IssueId, IssueStage } from '@podium/model'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
import { IssueContextMenu } from './IssueContextMenu'
import { IssueListView } from './IssueListView'
import { IssuePage } from './IssuePage'
import {
  AnchoredIssueMenu,
  BulkBar,
  DisplayMenu,
  FilterMenu,
  type PropMenuKind,
} from './IssuesFilters'
import { IssuesKanban } from './IssuesKanban'
import { type BoardFilter, clearChip } from './issue-board-filter'
import { contextMenuTargets } from './issue-context-menu'
import {
  DISPLAY_KEY,
  type IssuesDisplay,
  readIssuesDisplay,
  writeIssuesDisplay,
} from './issues-display'
import { type IssuesKeyAction, type IssuesKeyState, issuesKeyReduce } from './issues-keys'
import { deriveIssuesViewModel, type IssuesDisplayPatch } from './issues-view-model'
import { NewIssueDialog } from './NewIssueDialog'

/**
 * Issues is a composer, not a second view-model. The published issue projection
 * enters here once; `deriveIssuesViewModel` supplies the single answer consumed
 * by the list, kanban, keyboard navigation and issue page.
 */
export function IssuesView(): JSX.Element {
  const issues = useReplicaIssues()
  const openIssueId = useStoreSelector((store) => store.openIssueId)
  const setOpenIssueId = useStoreSelector((store) => store.setOpenIssueId)
  const trpc = useStoreSelector((store) => store.trpc)
  const ui = useStoreSelector((store) => store.uiState)
  const isMobile = useIsMobile()
  const [display, setDisplay] = useState<IssuesDisplay>(() =>
    readIssuesDisplay(ui.get(DISPLAY_KEY)),
  )
  const [creating, setCreating] = useState<null | { stage?: IssueStage }>(null)
  const [filter, setFilter] = useState<BoardFilter>({})
  const [error, setError] = useState('')
  const [keyState, setKeyState] = useState<IssuesKeyState>({ focusId: null, selected: [] })
  const [propMenu, setPropMenu] = useState<{ kind: PropMenuKind; id: string } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{
    ids: string[]
    anchor: { x: number; y: number }
  } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const updateDisplay = (patch: IssuesDisplayPatch): void => {
    const next = { ...display, ...patch, badges: { ...display.badges, ...(patch.badges ?? {}) } }
    setDisplay(next)
    ui.set(DISPLAY_KEY, writeIssuesDisplay(next))
  }
  const toggleExpand = (id: string): void =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const view = useMemo(
    () => deriveIssuesViewModel({ issues, display, filter, expanded, isMobile, openIssueId }),
    [issues, display, filter, expanded, isMobile, openIssueId],
  )

  const runMut = (promise: Promise<unknown>): void => {
    setError('')
    promise.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }
  const moveIssue = (id: string, stage: IssueStage): void =>
    runMut(trpc.issues.update.mutate({ id, patch: { stage } }))
  const approveIssue = (id: string): void => runMut(trpc.issues.promote.mutate({ id }))
  const approveAndStart = (id: string): void =>
    runMut(trpc.issues.promote.mutate({ id }).then(() => trpc.issues.start.mutate({ id })))
  const archiveIssue = (id: string): void => runMut(trpc.issues.archive.mutate({ id }))
  const setAssignee = (id: string, assignee: string): void =>
    runMut(trpc.issues.update.mutate({ id, patch: { assignee } }))
  const setPriority = (id: string, priority: number): void =>
    runMut(trpc.issues.update.mutate({ id, patch: { priority } }))
  const toggleLabel = (issue: IssueViewModel, label: string): void => {
    const labels = issue.labels.includes(label)
      ? issue.labels.filter((candidate) => candidate !== label)
      : [...issue.labels, label]
    runMut(trpc.issues.setLabels.mutate({ id: issue.id, labels }))
  }

  const selectedIds = keyState.selected.filter((id) => view.presentIds.has(id))
  const focusId = keyState.focusId
  const navRef = useRef(view.nav)
  navRef.current = view.nav
  const focusRef = useRef(focusId)
  focusRef.current = focusId
  const dispatchKey = useCallback((action: IssuesKeyAction): void => {
    setKeyState((state) => issuesKeyReduce(state, action, navRef.current))
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (openIssueId || event.metaKey || event.ctrlKey || event.altKey) return
      const element = document.activeElement as HTMLElement | null
      if (
        element &&
        (element.tagName === 'INPUT' ||
          element.tagName === 'TEXTAREA' ||
          element.tagName === 'SELECT' ||
          element.isContentEditable)
      )
        return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      switch (event.key) {
        case 'c':
          event.preventDefault()
          setCreating({})
          break
        case 'Escape':
          dispatchKey({ kind: 'clear' })
          break
        case 'j':
        case 'ArrowDown':
          event.preventDefault()
          dispatchKey({ kind: 'next' })
          break
        case 'k':
        case 'ArrowUp':
          event.preventDefault()
          dispatchKey({ kind: 'prev' })
          break
        case 'ArrowLeft':
          event.preventDefault()
          dispatchKey({ kind: 'left' })
          break
        case 'ArrowRight':
          event.preventDefault()
          dispatchKey({ kind: 'right' })
          break
        case 'Enter':
          if (focusRef.current) {
            event.preventDefault()
            setOpenIssueId(focusRef.current)
          }
          break
        case 'x':
          if (focusRef.current) {
            event.preventDefault()
            dispatchKey({ kind: 'toggleSelect' })
          }
          break
        case 's':
        case 'p':
        case 'a':
        case 'l':
          if (focusRef.current) {
            event.preventDefault()
            setPropMenu({ kind: event.key, id: focusRef.current })
            document
              .querySelector(`[data-issue-id="${focusRef.current}"]`)
              ?.scrollIntoView({ block: 'nearest' })
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatchKey, openIssueId, setOpenIssueId])

  useEffect(() => {
    if (!focusId) return
    const frame = requestAnimationFrame(() =>
      document.querySelector(`[data-issue-id="${focusId}"]`)?.scrollIntoView({ block: 'nearest' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [focusId])

  const toggleSelectId = (id: IssueId): void =>
    setKeyState((state) =>
      issuesKeyReduce({ ...state, focusId: id }, { kind: 'toggleSelect' }, navRef.current),
    )
  const onIssueContextMenu = (id: IssueId, event: ReactMouseEvent): void => {
    event.preventDefault()
    const next = contextMenuTargets({ focusId: keyState.focusId, selected: selectedIds }, id)
    setKeyState(next.keyState)
    setCtxMenu({ ids: next.targetIds, anchor: { x: event.clientX, y: event.clientY } })
  }
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
    const targets = issues.filter((issue) => selectedIds.includes(issue.id))
    const sessions = new Set(targets.flatMap((issue) => issue.memberSessionIds)).size
    if (
      !window.confirm(
        `Delete ${targets.length} task${targets.length > 1 ? 's' : ''} and ${sessions} session${sessions === 1 ? '' : 's'}? Tasks and sessions can be restored; running processes will be stopped.`,
      )
    )
      return
    runMut(Promise.all(selectedIds.map((id) => trpc.issues.delete.mutate({ id }))))
    setKeyState((state) => ({ ...state, selected: [] }))
  }

  if (view.open) {
    return (
      <IssuePage
        issue={view.open}
        orderedIds={view.orderedIdsForOpen}
        onBack={() => setOpenIssueId(null)}
        onNavigate={setOpenIssueId}
      />
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Tasks">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <h2 className="font-medium text-base text-foreground">Tasks</h2>
        <div className="flex items-center gap-2">
          <FilterMenu
            filter={filter}
            onChange={setFilter}
            labels={view.labels}
            assignees={view.assignees}
          />
          <DisplayMenu display={display} onChange={updateDisplay} showLayout={!isMobile} />
          <Button
            type="button"
            size="sm"
            data-testid="issues-new-task"
            onClick={() => setCreating({})}
          >
            + New Task
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-border border-b px-4 py-2 md:px-[22px]">
        <Input
          value={filter.text ?? ''}
          onChange={(event) => setFilter({ ...filter, text: event.target.value || undefined })}
          placeholder="Search tasks or ID…"
          aria-label="Search tasks"
          className="h-8 w-full max-w-[240px] flex-1"
        />
        <button
          data-pressable
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
              ? 'Showing all tasks flat — click to nest sub-tasks under parents'
              : 'Showing top-level tasks — click to flatten sub-tasks into the list'
          }
          onClick={() => updateDisplay({ flatten: !display.flatten })}
        >
          Flatten
        </button>
        {view.chips.map((chip) => (
          <button
            data-pressable
            key={chip.key}
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[12px]"
            onClick={() => setFilter(clearChip(filter, chip.key))}
            title="Remove filter"
          >
            {chip.label} ×
          </button>
        ))}
      </div>
      {view.layout === 'list' ? (
        <IssueListView
          groups={view.rowGroups}
          display={display}
          onOpen={setOpenIssueId}
          onCreateIn={(stage) => setCreating({ stage })}
          focusId={focusId}
          selected={selectedIds}
          onToggleSelect={toggleSelectId}
          onToggleExpand={toggleExpand}
          onContextMenu={onIssueContextMenu}
        />
      ) : (
        <IssuesKanban
          columns={view.orderedByStage}
          allIssues={issues}
          badges={display.badges}
          stageCounts={view.stageCounts}
          epicProgress={view.epicProgress}
          onOpen={setOpenIssueId}
          onMoveIssue={moveIssue}
          onApprove={approveIssue}
          onApproveStart={approveAndStart}
          onArchive={archiveIssue}
          onCreateIn={(stage) => setCreating({ stage })}
          onSetAssignee={setAssignee}
          assignees={view.assignees}
          focusId={focusId}
          selected={selectedIds}
          onToggleSelect={toggleSelectId}
          onContextMenu={onIssueContextMenu}
        />
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
          const target = view.active.find((issue) => issue.id === propMenu.id)
          return target ? (
            <AnchoredIssueMenu
              issue={target}
              kind={propMenu.kind}
              assignees={view.assignees}
              labelPool={view.labels}
              onMoveIssue={moveIssue}
              onSetPriority={setPriority}
              onSetAssignee={setAssignee}
              onToggleLabel={toggleLabel}
              onClose={() => setPropMenu(null)}
            />
          ) : null
        })()}
      {ctxMenu &&
        (() => {
          const targets = ctxMenu.ids
            .map((id) => issues.find((issue) => issue.id === id))
            .filter((issue): issue is IssueViewModel => issue !== undefined)
          return targets.length > 0 ? (
            <IssueContextMenu
              issues={targets}
              allIssues={view.scope}
              anchor={ctxMenu.anchor}
              onClose={() => setCtxMenu(null)}
              onOpen={setOpenIssueId}
            />
          ) : null
        })()}
    </section>
  )
}
