import {
  asUserId,
  type IssueId,
  type IssueStage,
  parseIssueStatusValue,
} from '@podium/model/browser'
import { ListTree, Plus } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { ToolbarSlot } from '@/app/ToolbarSlot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import { cn } from '@/lib/utils'
import { BoardShortcutSheet } from './BoardShortcutSheet'
import { boardKeyAction } from './board-shortcuts'
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
import { IssueBulkCloseDialog, type IssueCloseReason, useIssueCloseGuard } from './issue-lifecycle'
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
  // The board's own writes ride the outbox-as-overlay too (POD-781) — the same
  // store actions the right-click menu uses, so a stage move made from a card
  // and one made from the menu paint identically.
  const updateIssue = useStoreSelector((store) => store.updateIssue)
  const setIssueLabels = useStoreSelector((store) => store.setIssueLabels)
  const deleteIssue = useStoreSelector((store) => store.deleteIssue)
  const closeIssue = useStoreSelector((store) => store.closeIssue)
  const isMobile = useIsMobile()
  // Display options are per-user REPLICATED, so they are subscribed rather than
  // seeded — a `useState` initializer reads the key before the replica has the
  // row and the board is stuck on the defaults for the session (POD-540).
  const [display, setDisplay] = usePersistedUiState<IssuesDisplay>(
    DISPLAY_KEY,
    readIssuesDisplay,
    writeIssuesDisplay,
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
  // The batch close guard (POD-1126). Holds the selection it was asked for, not
  // just the reason: the board keeps repainting underneath the dialog.
  const [bulkClose, setBulkClose] = useState<{ ids: IssueId[]; reason: IssueCloseReason } | null>(
    null,
  )
  const [bulkClosing, setBulkClosing] = useState(false)
  const needsCloseGuard = useIssueCloseGuard()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [showShortcuts, setShowShortcuts] = useState(false)
  const issueScrollPositions = useRef<{
    list: number
    columns: Partial<Record<IssueStage, number>>
  }>({ list: 0, columns: {} })
  const rememberListScroll = useCallback((top: number): void => {
    issueScrollPositions.current.list = top
  }, [])
  const rememberColumnScroll = useCallback((stage: IssueStage, top: number): void => {
    issueScrollPositions.current.columns[stage] = top
  }, [])

  const updateDisplay = (patch: IssuesDisplayPatch): void => {
    setDisplay({ ...display, ...patch, badges: { ...display.badges, ...(patch.badges ?? {}) } })
  }
  const toggleExpand = (id: IssueId): void =>
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

  const runMut = useCallback((promise: Promise<unknown>): void => {
    setError('')
    promise.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])
  const moveIssue = useCallback(
    (id: IssueId, stage: IssueStage): void => runMut(updateIssue(id, { stage })),
    [runMut, updateIssue],
  )
  const approveIssue = useCallback(
    (id: IssueId): void => runMut(trpc.issues.promote.mutate({ id })),
    [runMut, trpc.issues.promote],
  )
  const createInStage = useCallback((stage: IssueStage): void => setCreating({ stage }), [])
  // `approve & start` and `archive` left this file with the card's three-button
  // bar (POD-591). They are not lost: both are on the right-click menu, which
  // acts on a selection rather than on one card, and that is where a decision
  // taken over 140 proposals belongs. The card keeps Approve alone.

  // The picker hands back a bare string (and `''` to unassign) while the
  // contract's patch is branded — the brand is a compile-time claim about which
  // string this is, and the dropdown's options come from the issues' own
  // assignees, so it is the same string either way.
  const setAssignee = (id: IssueId, assignee: string): void =>
    runMut(updateIssue(id, { assignee: asUserId(assignee) }))
  const setPriority = (id: IssueId, priority: number): void => runMut(updateIssue(id, { priority }))
  const toggleLabel = (issue: IssueViewModel, label: string): void => {
    const labels = issue.labels.includes(label)
      ? issue.labels.filter((candidate) => candidate !== label)
      : [...issue.labels, label]
    runMut(setIssueLabels(issue.id, labels))
  }

  const selectedIds = useMemo(
    () => keyState.selected.filter((id) => view.presentIds.has(id)),
    [keyState.selected, view.presentIds],
  )
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
      // Bindings come from `board-shortcuts.ts`, which the `?` sheet also reads
      // (POD-591) — so a key the board answers is a key the sheet lists, by
      // construction rather than by two people remembering.
      const bound = boardKeyAction(event.key)
      if (!bound) return
      switch (bound.kind) {
        case 'nav':
          // Escape is the one binding that must NOT preventDefault: it is also
          // how the browser leaves full screen and how a native wrapper cancels.
          if (event.key !== 'Escape') event.preventDefault()
          if (bound.action.kind === 'toggleSelect' && !focusRef.current) return
          dispatchKey(bound.action)
          return
        case 'create':
          event.preventDefault()
          setCreating({})
          return
        case 'open':
          if (!focusRef.current) return
          event.preventDefault()
          setOpenIssueId(focusRef.current)
          return
        case 'property':
          if (!focusRef.current) return
          event.preventDefault()
          setPropMenu({ kind: event.key as PropMenuKind, id: focusRef.current })
          document
            .querySelector(`[data-issue-id="${focusRef.current}"]`)
            ?.scrollIntoView({ block: 'nearest' })
          return
        case 'help':
          event.preventDefault()
          setShowShortcuts(true)
          return
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

  const toggleSelectId = useCallback((id: IssueId): void => {
    setKeyState((state) =>
      issuesKeyReduce({ ...state, focusId: id }, { kind: 'toggleSelect' }, navRef.current),
    )
  }, [])
  const contextStateRef = useRef({ keyState, selectedIds })
  contextStateRef.current = { keyState, selectedIds }
  const onIssueContextMenu = useCallback((id: IssueId, event: ReactMouseEvent): void => {
    event.preventDefault()
    const current = contextStateRef.current
    const next = contextMenuTargets(
      { focusId: current.keyState.focusId, selected: current.selectedIds },
      id,
    )
    setKeyState(next.keyState)
    setCtxMenu({ ids: next.targetIds, anchor: { x: event.clientX, y: event.clientY } })
  }, [])
  // Bulk status (POD-1074): the lane arm patches the stage, the terminal arm
  // CLOSES with its reason. Marking a batch Done is an ordinary thing to want —
  // it just has to record that the ending was `done` rather than dropping the
  // rows on the done lane with no reason at all, which is what the old bare
  // stage patch did.
  //
  // The terminal arm goes through the guard (POD-1126), like every other close
  // in the app: a lane move is reversible by dragging the card back, an ending
  // retires standing offers and leaves attributed work behind. The selection is
  // captured with the reason — `selectedIds` can move while the dialog stands.
  const bulkStatus = (value: string): void => {
    const intent = parseIssueStatusValue(value)
    if (!intent) return
    if (intent.kind === 'close') {
      // A selection of ONE is handed to the single-issue dialog by
      // `IssueBulkCloseDialog`, so it follows the single-issue rule (POD-1278):
      // the guard is raised only when it has something to name. A real batch
      // still gets its dialog — its headline carries a count of what is about to
      // close, which is a fact the bar has not otherwise shown.
      const only =
        selectedIds.length === 1 ? issues.find((i) => i.id === selectedIds[0]) : undefined
      if (only && !needsCloseGuard(only)) {
        runMut(closeIssue(only.id, intent.reason))
        return
      }
      setBulkClose({ ids: selectedIds, reason: intent.reason })
      return
    }
    runMut(Promise.all(selectedIds.map((id) => updateIssue(id, { stage: intent.stage }))))
  }
  const bulkCloseTargets = useMemo(
    () =>
      bulkClose
        ? bulkClose.ids
            .map((id) => issues.find((issue) => issue.id === id))
            .filter((issue): issue is IssueViewModel => issue !== undefined)
        : [],
    [bulkClose, issues],
  )
  const confirmBulkClose = (reason: IssueCloseReason): void => {
    setBulkClosing(true)
    runMut(
      Promise.all(bulkCloseTargets.map((issue) => closeIssue(issue.id, reason))).finally(() => {
        setBulkClosing(false)
        setBulkClose(null)
      }),
    )
  }
  const bulkPriority = (priority: number): void =>
    runMut(Promise.all(selectedIds.map((id) => updateIssue(id, { priority }))))
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
    runMut(Promise.all(selectedIds.map((id) => deleteIssue(id))))
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
      {/* Tasks' controls live in the command bar's dynamic centre (POD-365).
          They pass the slot's test — their scope is the whole mode and no column
          owns them — and before this they paid for that with two full-bleed bars
          and an H1 restating the mode tab. The board keeps the vertical budget. */}
      <ToolbarSlot>
        <div className="topbar-tools" data-testid="tasks-toolbar">
          <Input
            value={filter.text ?? ''}
            onChange={(event) => setFilter({ ...filter, text: event.target.value || undefined })}
            placeholder="Search tasks or ID…"
            aria-label="Search tasks"
            className="topbar-tools-search"
          />
          <button
            data-pressable
            type="button"
            className={cn('topbar-tool-toggle', display.flatten && 'topbar-tool-toggle-on')}
            aria-pressed={display.flatten}
            title={
              display.flatten
                ? 'Showing all tasks flat — click to nest sub-tasks under parents'
                : 'Showing top-level tasks — click to flatten sub-tasks into the list'
            }
            onClick={() => updateDisplay({ flatten: !display.flatten })}
          >
            <ListTree size={13} aria-hidden="true" />
            <span className="topbar-tool-label">Flatten</span>
          </button>
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
            // The label collapses under the narrow breakpoint; the name must not.
            aria-label="New Task"
            title="New Task"
            onClick={() => setCreating({})}
          >
            <Plus size={13} aria-hidden="true" />
            <span className="topbar-tool-label">New Task</span>
          </Button>
        </div>
      </ToolbarSlot>
      {/* Active filters, and ONLY when some are set — a strip that appears with
          the state it describes is not permanent chrome. */}
      {view.chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-border border-b px-4 py-2 md:px-[22px]">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
            Filtered
          </span>
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
      )}
      {view.layout === 'list' ? (
        <IssueListView
          groups={view.rowGroups}
          display={display}
          onOpen={setOpenIssueId}
          onCreateIn={createInStage}
          focusId={focusId}
          selected={selectedIds}
          onToggleSelect={toggleSelectId}
          onToggleExpand={toggleExpand}
          onContextMenu={onIssueContextMenu}
          initialScrollTop={issueScrollPositions.current.list}
          onScrollTop={rememberListScroll}
        />
      ) : (
        <IssuesKanban
          columns={view.orderedByStage}
          allIssues={issues}
          badges={display.badges}
          ordering={display.ordering}
          stageCounts={view.stageCounts}
          epicProgress={view.epicProgress}
          onOpen={setOpenIssueId}
          onMoveIssue={moveIssue}
          onApprove={approveIssue}
          onCreateIn={createInStage}
          focusId={focusId}
          selected={selectedIds}
          onToggleSelect={toggleSelectId}
          onContextMenu={onIssueContextMenu}
          scrollTops={issueScrollPositions.current.columns}
          onScrollTop={rememberColumnScroll}
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
      {showShortcuts && <BoardShortcutSheet onClose={() => setShowShortcuts(false)} />}
      {/* Mounted outside the BulkBar's own conditional: confirming closes the
          rows, and the bar goes with the selection while the dialog is still
          animating out. */}
      {bulkClose && bulkCloseTargets.length > 0 && (
        <IssueBulkCloseDialog
          issues={bulkCloseTargets}
          reason={bulkClose.reason}
          busy={bulkClosing}
          onOpenChange={(open) => !open && setBulkClose(null)}
          onConfirm={confirmBulkClose}
        />
      )}
      {selectedIds.length > 0 && (
        <BulkBar
          count={selectedIds.length}
          onStatus={bulkStatus}
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
