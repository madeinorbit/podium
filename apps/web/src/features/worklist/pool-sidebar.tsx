import type { Store } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/shallow-equal'
import {
  type IssueNavigationModel,
  isSessionWorking,
  planReorderKeys,
} from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { here, omitGone } from '@podium/client-graph/lookup'
import {
  compareStructural,
  computed,
  observer,
  useWorklistModel,
  WorklistProvider,
} from '@podium/client-graph/react'
import type { SliceWorktree } from '@podium/client-graph/shared/slice-types'
import type { SidebarSections, SidebarState } from '@podium/client-graph/worklist/sidebar'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { machinePathKey, machinePathsEqual, type SessionId } from '@podium/model/browser'
import * as m from 'motion/react-m'
import {
  type AnimationEvent,
  isValidElement,
  type JSX,
  type MouseEvent,
  memo,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { toast } from 'sonner'
import { usePanelVisible } from '@/app/panel-visible'
import { useRuntimeSelector } from '@/app/store'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { MobilePromoCard } from '@/features/mobile-handoff/MobilePromoCard'
import { PHONE_APP_IN_STORES } from '@/features/mobile-handoff/mobile-handoff'
import { type RowTransitionItem, type RowTransitionTarget, useRowTransitions } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { useReducedMotion } from '@/lib/use-reduced-motion'
import { cn } from '@/lib/utils'
import { FoldedRowMenu } from './FoldedRowMenu'
import { PINNED_FOLD_KEY, projectFoldKey } from './fold-keys'
import { useNewTask } from './new-task'
import { NewTaskRow } from './new-task-row'
import {
  navigationIssue,
  poolIssueDisplay,
  poolIssueRow,
  poolSessionPaint,
  sidebarExitSnapshot,
  worklistIssueHaystack,
} from './pool-row-data'
import { MAX_ROW_SHORTCUTS, useRowShortcuts } from './row-shortcuts'
import { PanelRow, useCollapsedKeys } from './sidebar-common'
import { UnifiedIssueRow, WorklistIssueRow } from './UnifiedIssueRow'
import { UnifiedWorktreeRow } from './UnifiedWorktreeRow'
import {
  type ArchiveIssueTree,
  type PoolWorkActions,
  usePoolUnifiedWork,
} from './use-pool-unified-work'
import { useRowDrag } from './useRowDrag'
import { WorkListEmpty } from './WorkListEmpty'
import { normalizeWorkQuery } from './work-filter'
import {
  AddRepositoryFooter,
  ClosedLaneHeader,
  ProjectFolderHeader,
  placeInFullOrder,
  useProjectOrderWriter,
  type WorkLane,
  WorkLaneSwitch,
} from './work-folders'
import { FoldedWorkRow, FoldPanel, WorklistFoldedRow } from './work-folds'
import {
  useWorkFilterState,
  WorkFilterEmpty,
  WorkFilterFootnote,
  WorkSearchField,
} from './work-search'
import { WorklistMotion } from './worklist-motion'
import {
  cssEase,
  EASE_IN,
  EASE_OUT,
  MOTION_S,
  ROW_LAYOUT_TRANSITION,
} from './worklist-motion-tokens'
import { WorklistWindow } from './worklist-window'

type Slot = {
  kind: 'issue' | 'worktree'
  id: string
  lane: 'pinned' | 'open' | 'snoozed' | 'closed'
  groupKey: string
  groupLabel: string
}
type Item = RowTransitionItem<Slot>
const itemKey = (item: Item) => item.key
const itemDragId = (item: Item) =>
  item.value.kind === 'issue' && item.phase !== 'exiting' ? item.value.id : undefined
const NO_DRAG_ROWS: readonly string[] = []
const selectLayout = (s: Store) => ({
  projectOrder: s.sidebarSettings.repoOrder,
  pinnedRepos: s.pins.repos,
  pinnedWorktrees: s.pins.worktrees,
})

export function usePoolLayoutState(): SidebarState {
  const layout = useRuntimeSelector(selectLayout, shallowEqual)
  return useMemo(() => layout, [layout])
}

function slotsFor(
  sections: SidebarSections,
  orderByScope?: Map<string, readonly string[]>,
): RowTransitionTarget<Slot>[] {
  const slots: RowTransitionTarget<Slot>[] = []
  const add = (
    id: string,
    kind: Slot['kind'],
    lane: Slot['lane'],
    groupKey: string,
    groupLabel: string,
  ) =>
    slots.push({
      key: `${kind === 'issue' ? 'issue' : 'wt'}:${id}`,
      placement: lane === 'closed' || lane === 'snoozed' ? `${lane}:${groupKey}` : 'active',
      value: { kind, id, lane, groupKey, groupLabel },
    })
  for (const id of sections.pinnedIds) add(id, 'issue', 'pinned', 'pinned', 'Pinned')
  for (const band of sections.bands) {
    orderByScope?.set(`group:${band.key}`, band.rowIds)
    for (const id of band.rowIds) add(id, 'issue', 'open', band.key, band.label)
    for (const id of band.worktreeIds) add(id, 'worktree', 'open', band.key, band.label)
    for (const id of band.snoozedIds) add(id, 'issue', 'snoozed', band.key, band.label)
    for (const id of band.closedIds) add(id, 'issue', 'closed', band.key, band.label)
  }
  return slots
}

function matches(pool: MobxPool, slot: Slot, needle: string): boolean {
  if (!needle) return true
  if (slot.kind === 'issue') {
    const value = sidebarView(pool).row(slot.id)
    return value !== undefined && value !== LOADING && worklistIssueHaystack(value).includes(needle)
  }
  const value = omitGone(pool.row('worktree', slot.id)) as
    | SliceWorktree
    | typeof LOADING
    | undefined
  return (
    value !== undefined &&
    value !== LOADING &&
    `${value['repoName']} ${value['branch'] ?? ''} ${slot.id}`.toLowerCase().includes(needle)
  )
}

const PoolEviction = observer(function PoolEviction({ pool }: { pool: MobxPool }) {
  const clear = useRuntimeSelector((s) => s.setSelectedIssueId)
  const evicted = sidebarView(pool).selectionGone()
  useEffect(() => {
    if (evicted) clear(null)
  }, [evicted, clear])
  return null
})

/** The lane a slot belongs to, as the top switch names it. Pinned rows are open. */
const laneOf = (slot: Slot): WorkLane => (slot.lane === 'pinned' ? 'open' : slot.lane)

export const PoolSidebarUnified = observer(function PoolSidebarUnified(): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pool = useWorklistPool()
  const state = usePoolLayoutState()
  const model = pool ? worklistView(pool) : null
  useEffect(() => {
    model?.setLayout(state)
  }, [model, state])
  const [lane, setLane] = useState<WorkLane>('open')
  // A lane change swaps the whole list in one commit; the list fades up into
  // place over 140ms so the swap reads as the switch's answer (POD-2080). One
  // compositor animation on the scroller, never per row.
  const reduceMotion = useReducedMotion()
  const shownLane = useRef(lane)
  useLayoutEffect(() => {
    if (shownLane.current === lane) return
    shownLane.current = lane
    const list = scrollRef.current
    if (reduceMotion || typeof list?.animate !== 'function') return
    list.animate(
      [
        { opacity: 0, transform: 'translateY(3px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: MOTION_S.lane * 1000, easing: cssEase(EASE_OUT) },
    )
  }, [lane, reduceMotion])
  const input = useWorkFilterState()
  const needle = normalizeWorkQuery(input.deferredQuery)
  const count = useMemo(
    () =>
      computed(
        () => {
          const counts: Record<WorkLane, number> = { open: 0, snoozed: 0, closed: 0 }
          if (!pool) return { total: 0, hits: 0, counts }
          const slots = slotsFor(sidebarView(pool).sections(state))
          for (const slot of slots) if (slot.value.kind === 'issue') counts[laneOf(slot.value)]++
          const live = slots.filter((slot) => laneOf(slot.value) === lane)
          return {
            total: live.length,
            hits: needle
              ? live.filter((slot) => matches(pool, slot.value, needle)).length
              : live.length,
            counts,
          }
        },
        { equals: compareStructural },
      ),
    [pool, state, needle, lane],
  ).get()
  return (
    <WorklistProvider model={model}>
      <NewTaskRow />
      <WorkSearchField filter={{ ...input, total: count.total, hits: count.hits }} />
      <WorkLaneSwitch lane={lane} counts={count.counts} onChange={setLane} />
      <div
        ref={scrollRef}
        data-testid="work-scroll"
        style={{ overflowAnchor: 'none' }}
        className="work-scroll scroll-none flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto border-t border-hairline-bar pb-2.5"
      >
        <PoolWorkSections
          query={input.deferredQuery}
          scrollRef={scrollRef}
          lane={lane}
          onLaneChange={setLane}
        />
      </div>
      <AddRepositoryFooter />
      {PHONE_APP_IN_STORES && <MobilePromoCard />}
    </WorklistProvider>
  )
})

export function PoolWorkSections({
  query = '',
  scrollRef,
  lane = 'open',
  onLaneChange,
}: {
  query?: string
  scrollRef?: RefObject<HTMLElement | null>
  /** Which lane of the top switch is showing. */
  lane?: WorkLane
  /** Reveal a selection that lives in another lane. */
  onLaneChange?: (lane: WorkLane) => void
}): JSX.Element | null {
  const pool = useWorklistPool()
  const fallbackScroll = useRef<HTMLElement | null>(null)
  return pool ? (
    <ObservedPoolWorkSections
      pool={pool}
      query={query}
      scrollRef={scrollRef ?? fallbackScroll}
      lane={lane}
      onLaneChange={onLaneChange}
    />
  ) : null
}

const MemoFoldedWorkRow = memo(FoldedWorkRow)
const stampPaint = (node: ReactNode) =>
  isValidElement<{ title?: string; children?: ReactNode }>(node)
    ? { title: node.props.title, children: node.props.children }
    : node
const MemoPanelRow = memo(
  PanelRow,
  (a, b) =>
    a.active === b.active &&
    a.onSelect === b.onSelect &&
    a.issueDisplayRef === b.issueDisplayRef &&
    compareStructural(a.snoozeState, b.snoozeState) &&
    compareStructural(stampPaint(a.trailingMeta), stampPaint(b.trailingMeta)) &&
    compareStructural(poolSessionPaint(a.session), poolSessionPaint(b.session)),
)

/** A folder drag in flight: which header, and the order it is showing. */
type FolderDrag = { key: string; start: readonly string[]; order: readonly string[] }

const ObservedPoolWorkSections = observer(function ObservedPoolWorkSections({
  pool,
  query,
  scrollRef,
  lane,
  onLaneChange,
}: {
  pool: MobxPool
  query: string
  scrollRef: RefObject<HTMLElement | null>
  lane: WorkLane
  onLaneChange?: (lane: WorkLane) => void
}): JSX.Element {
  const state = usePoolLayoutState()
  const actions = usePoolUnifiedWork(pool)
  const model = useWorklistModel() ?? worklistView(pool)
  const sections = model.sections(state)
  const stableSlots = useRef(new Map<string, Slot>())
  const { targets, slotById, orderByScope } = useMemo(() => {
    const slotById = new Map<string, Slot>()
    const orderByScope = new Map<string, readonly string[]>()
    orderByScope.set('pinned', sections.pinnedIds)
    const next = slotsFor(sections, orderByScope).map((target) => {
      const key = `${target.key}:${target.placement}`
      const previous = stableSlots.current.get(key)
      const value = previous && compareStructural(previous, target.value) ? previous : target.value
      stableSlots.current.set(key, value)
      slotById.set(value.id, value)
      return { ...target, value }
    })
    const keys = new Set(next.map((target) => `${target.key}:${target.placement}`))
    for (const key of stableSlots.current.keys())
      if (!keys.has(key)) stableSlots.current.delete(key)
    return { targets: next, slotById, orderByScope }
  }, [sections])
  const { items, settle, discardExit } = useRowTransitions(targets)
  const reduceMotion = useReducedMotion()
  const layoutGroupId = useId()
  // A gesture snapshot: Undo restores this batch even if other tasks close later.
  const [archivedTrees, setArchivedTrees] = useState<readonly ArchiveIssueTree[]>([])
  const archiving = useSyncExternalStore(
    actions.subscribeArchiveChanges,
    () => actions.archiveBatchPending(archivedTrees),
    () => false,
  )
  const archivedCount = archivedTrees.reduce((count, tree) => count + tree.ids.length, 0)
  useEffect(() => {
    if (lane !== 'closed') setArchivedTrees([])
  }, [lane])
  useEffect(() => {
    // A refused root archive or an external restore ends that tree's Undo.
    // Descendants can remain visible until the server's cascade arrives.
    if (archivedTrees.some((tree) => slotById.has(tree.rootId)))
      setArchivedTrees((current) => current.filter((tree) => !slotById.has(tree.rootId)))
  }, [archivedTrees, slotById])
  const [quickArchive, setQuickArchive] = useState<ReadonlySet<string>>(() => new Set())
  const [menu, setMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null)
  const { startNewTask } = useNewTask()
  const writeOrder = useProjectOrderWriter()
  const keys = [PINNED_FOLD_KEY, ...sections.bands.map((band) => band.foldKey)]
  const [collapsed, toggle] = useCollapsedKeys(keys)
  const needle = normalizeWorkQuery(query)
  const filtering = needle.length > 0
  const selectedId = useRuntimeSelector((s) => s.selectedIssueId)
  const revealedSelection = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId) {
      revealedSelection.current = null
      return
    }
    if (revealedSelection.current === selectedId) return
    const selected = slotById.get(selectedId)
    if (!selected) return
    revealedSelection.current = selectedId
    // Selection is the reveal request: switch to its lane and open its folder;
    // folding the current selection afterwards stays folded.
    if (laneOf(selected) !== lane) onLaneChange?.(laneOf(selected))
    const key = selected.lane === 'pinned' ? PINNED_FOLD_KEY : projectFoldKey(selected.groupKey)
    if (collapsed.has(key)) toggle(key)
  }, [selectedId, slotById, collapsed, toggle, lane, onLaneChange])
  const search = useMemo(
    () =>
      computed(
        () =>
          new Set(
            targets
              .filter(
                (target) => laneOf(target.value) === lane && matches(pool, target.value, needle),
              )
              .map((target) => target.key),
          ),
        { equals: compareStructural },
      ),
    [pool, targets, needle, lane],
  ).get()
  const issue = (id: string) => {
    const value = sidebarView(pool).row(id)
    return value === undefined || value === LOADING ? undefined : value
  }
  const { startDrag, dragging, draggedId } = useRowDrag({
    virtualOrder: (scope) => orderByScope.get(scope) ?? NO_DRAG_ROWS,
    allowedTargets: (scope, id) => {
      const value = issue(id)
      return scope === 'pinned'
        ? value
          ? [`group:${value.issue.repoId ?? machinePathKey(value.issue.repoPath)}`]
          : []
        : scope.startsWith('group:')
          ? ['pinned']
          : []
    },
    onDrop: ({ sourceScope, targetScope, movedId, order }) =>
      actions.applySortPatches(
        planReorderKeys(order, movedId, (id) => issue(id)?.issue.sortKey).map((patch) => ({
          ...patch,
          ...(sourceScope !== targetScope && patch.id === movedId
            ? { pinned: targetScope === 'pinned' }
            : {}),
        })),
      ),
  })
  const drag = useRef(startDrag)
  drag.current = startDrag
  const onGrip = useCallback((event: PointerEvent, id: string) => drag.current(event, id), [])
  const openMenu = useCallback((id: string, event: MouseEvent) => {
    event.preventDefault()
    setMenu({ id, anchor: { x: event.clientX, y: event.clientY } })
  }, [])
  const forgetQuickArchive = (ids: readonly string[]) =>
    setQuickArchive((current) => {
      const next = new Set([...current].filter((id) => !ids.includes(id)))
      return next.size === current.size ? current : next
    })
  useEffect(() => {
    if (!quickArchive.size) return
    const onScreen = new Set(items.map((item) => item.key))
    setQuickArchive((current) => {
      const next = new Set([...current].filter((id) => onScreen.has(`issue:${id}`)))
      return next.size === current.size ? current : next
    })
  }, [items, quickArchive])
  const archive = (id: string) => {
    setArchivedTrees([])
    setQuickArchive((current) => new Set(current).add(id))
    return actions.archiveIssue(id).catch(() => {
      forgetQuickArchive([id])
      setArchivedTrees((current) => current.filter((tree) => tree.rootId !== id))
    })
  }
  const undoArchive = () => {
    if (archiving) return
    const trees = archivedTrees
    setArchivedTrees([])
    forgetQuickArchive(trees.map((tree) => tree.rootId))
    void actions.unarchiveBatch(trees).catch(() => toast.error('Could not restore archived tasks'))
  }
  // Rows take a stable archive handle, or every row would re-render with the list.
  const archiveRef = useRef(archive)
  archiveRef.current = archive
  const archiveRow = useCallback((id: string) => archiveRef.current(id), [])

  // ---- Folder order: the saved order, a drag's live order, or a write in flight.
  const naturalOrder = sections.bands.map((band) => band.key)
  const [folderDrag, setFolderDrag] = useState<FolderDrag | null>(null)
  // A folder drag folds EVERY folder's rows away (≈140ms) so only headers
  // move, and the drop restores them on the same quick fold.
  const [quickFold, setQuickFold] = useState(false)
  const [pendingOrder, setPendingOrder] = useState<readonly string[] | null>(null)
  const naturalSignature = naturalOrder.join('\u0000')
  useEffect(() => {
    if (!pendingOrder) return
    // The write landed (or another device moved them): the saved order rules.
    if (pendingOrder.join('\u0000') === naturalSignature) {
      setPendingOrder(null)
      return
    }
    const expire = window.setTimeout(() => setPendingOrder(null), 4000)
    return () => window.clearTimeout(expire)
  }, [pendingOrder, naturalSignature])

  // Keyed on the RENDERED rows, not the targets: a removed row is retained
  // through its exit, and the neighbours only slide into its place when it is
  // finally dropped. Keyed on targets, that drop changed no layoutDependency
  // and the rows below jumped into the hole (POD-2080).
  const signature = `${items.map((item) => `${item.key}:${item.placement}`).join('|')}#${(folderDrag?.order ?? pendingOrder ?? naturalOrder).join('|')}`
  const revision = useRef({ signature: '', value: 0 })
  if (!dragging && revision.current.signature !== signature)
    revision.current = { signature, value: revision.current.value + 1 }
  const shortcutIds =
    lane === 'open'
      ? targets
          .filter(
            (target) =>
              target.value.kind === 'issue' &&
              (target.value.lane === 'pinned'
                ? !collapsed.has(PINNED_FOLD_KEY)
                : target.value.lane === 'open' &&
                  !collapsed.has(projectFoldKey(target.value.groupKey))),
          )
          .slice(0, MAX_ROW_SHORTCUTS)
          .map((target) => target.value.id)
      : []
  const { numbers } = useRowShortcuts(
    shortcutIds.map((id) => ({
      id,
      activate: () => {
        const value = issue(id)
        if (value?.sessionOnlyDraft && value.firstSessionId)
          actions.selectPanelForIssue(id, value.firstSessionId as SessionId)
        else actions.selectIssue(id)
      },
    })),
  )
  const renderRow = (item: Item, animate = true) => (
    <PoolMotionRow
      key={`${item.key}:${item.placement}`}
      pool={pool}
      item={item}
      actions={actions}
      digit={numbers.get(item.value.id)}
      layoutRevision={revision.current.value}
      reduceMotion={reduceMotion}
      filtering={filtering}
      animate={animate}
      quickArchive={quickArchive.has(item.value.id)}
      settle={settle}
      discardExit={discardExit}
      onGrip={onGrip}
      openMenu={openMenu}
      onArchive={archiveRow}
    />
  )
  type ShownBand = {
    key: string
    label: string
    repoPath: string
    repoId: string | null
    foldKey: string
    rows: Item[]
  }
  // Each folder's rows keep their identity until the rows themselves change, so
  // a selection or menu render neither refilters every folder nor hands each
  // virtual window a new key list to re-derive its geometry from.
  const { pinned, bandList } = useMemo(() => {
    const inLane = (item: Item) =>
      laneOf(item.value) === lane && (!filtering || search.has(item.key))
    const pinned =
      lane === 'open' ? items.filter((item) => item.value.lane === 'pinned' && inLane(item)) : []
    const bandList: ShownBand[] = sections.bands.map((band) => ({
      key: band.key,
      label: band.label,
      repoPath: band.repoPath,
      repoId: band.repoId ?? null,
      foldKey: band.foldKey,
      rows: items.filter(
        (item) => item.value.lane !== 'pinned' && item.value.groupKey === band.key && inLane(item),
      ),
    }))
    // Exits can briefly outlive the band's pool membership.
    for (const item of items)
      if (
        item.value.lane !== 'pinned' &&
        !bandList.some((band) => band.key === item.value.groupKey) &&
        inLane(item)
      )
        bandList.push({
          key: item.value.groupKey,
          label: item.value.groupLabel,
          repoPath: '',
          repoId: null,
          foldKey: projectFoldKey(item.value.groupKey),
          rows: items.filter((row) => row.value.groupKey === item.value.groupKey && inLane(row)),
        })
    return { pinned, bandList }
  }, [items, sections.bands, lane, filtering, search])
  // Open keeps every project in its place (an empty one greyed and shut);
  // Snoozed, Closed and a filter show only the folders with something in them.
  const order = folderDrag?.order ?? pendingOrder
  const bands = bandList
    .filter((band) => (lane === 'open' && !filtering) || band.rows.length > 0)
    .sort((a, b) => (order ? rank(order, a.key) - rank(order, b.key) : 0))
  const visibleKeys = bands.map((band) => band.key)
  const commitOrder = (visible: readonly string[], moved: string) => {
    const full = placeInFullOrder(pendingOrder ?? naturalOrder, visible, moved)
    if (full.join('\u0000') === (pendingOrder ?? naturalOrder).join('\u0000')) return
    setPendingOrder(full)
    const byKey = new Map(sections.bands.map((band) => [band.key, band] as const))
    void writeOrder(
      full.flatMap((key) => {
        const band = byKey.get(key)
        return band ? [{ key, name: band.label, aliases: band.aliases }] : []
      }),
    ).catch(() => setPendingOrder(null))
  }
  const moveBy = (key: string, delta: -1 | 1) => {
    const at = visibleKeys.indexOf(key)
    const to = at + delta
    if (at < 0 || to < 0 || to >= visibleKeys.length) return
    const next = [...visibleKeys]
    next.splice(at, 1)
    next.splice(to, 0, key)
    commitOrder(next, key)
  }
  // Refs so the window listeners of one drag always read this render's facts.
  const dragFacts = useRef({ commitOrder, visibleKeys })
  dragFacts.current = { commitOrder, visibleKeys }
  const startFolderDrag = (event: PointerEvent, key: string) => {
    if (event.button !== 0 || filtering) return
    event.preventDefault()
    event.stopPropagation()
    const start = dragFacts.current.visibleKeys
    let current: FolderDrag = { key, start, order: start }
    setFolderDrag(current)
    setQuickFold(true)
    const scroller = scrollRef.current
    const onMove = (move: globalThis.PointerEvent) => {
      if (!scroller) return
      const bounds = scroller.getBoundingClientRect()
      // Edge scroll, so a folder can travel past the visible window.
      if (move.clientY < bounds.top + 36) scroller.scrollTop -= 12
      else if (move.clientY > bounds.bottom - 36) scroller.scrollTop += 12
      const others = current.order.filter((item) => item !== key)
      let index = 0
      for (const other of others) {
        const node = scroller.querySelector<HTMLElement>(`[data-folder-key="${CSS.escape(other)}"]`)
        if (!node) continue
        const rect = node.getBoundingClientRect()
        if (move.clientY > rect.top + rect.height / 2) index++
      }
      const next = [...others]
      next.splice(index, 0, key)
      if (next.join('\u0000') === current.order.join('\u0000')) return
      current = { ...current, order: next }
      setFolderDrag(current)
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      setFolderDrag(null)
      window.setTimeout(() => setQuickFold(false), MOTION_S.foldQuick * 1000 + 80)
      if (commit) dragFacts.current.commitOrder(current.order, key)
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
  }
  const setAllCollapsed = (shut: boolean) => {
    for (const band of bands)
      if (band.rows.length > 0 && collapsed.has(band.foldKey) !== shut) toggle(band.foldKey)
  }
  const anyOpen = bands.some((band) => band.rows.length > 0 && !collapsed.has(band.foldKey))
  const anyShut = bands.some((band) => band.rows.length > 0 && collapsed.has(band.foldKey))

  // A filtered viewport is not a complete reorder scope.
  const windowRows = (
    rows: readonly Item[],
    render = renderRow,
    dragScope?: string,
    estimateSize = 53,
  ) => (
    <WorklistWindow
      rows={rows}
      rowKey={itemKey}
      renderRow={render}
      scrollRef={scrollRef}
      selectedKey={selectedId ? `issue:${selectedId}` : null}
      draggingKey={draggedId ? `issue:${draggedId}` : null}
      dragScope={filtering || lane !== 'open' ? undefined : dragScope}
      dragId={itemDragId}
      estimateSize={estimateSize}
    />
  )
  if (lane === 'open' && items.length === 0 && sections.bands.length === 0)
    return (
      <>
        <PoolEviction pool={pool} />
        <WorkListEmpty />
      </>
    )
  const filterEmpty = filtering && pinned.length === 0 && bands.length === 0
  const transition = reduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }
  // Headers trade places under a drag on a short ease, not the rows' spring:
  // the slot has to keep up with the pointer.
  const folderTransition = reduceMotion
    ? { duration: 0 }
    : folderDrag
      ? { layout: { duration: MOTION_S.slot, ease: EASE_OUT } }
      : transition
  const closedRows =
    lane === 'closed'
      ? targets.filter((row) => search.has(row.key) && !quickArchive.has(row.value.id))
      : []
  return (
    <WorklistMotion layoutGroupId={layoutGroupId}>
      <PoolEviction pool={pool} />
      {lane === 'closed' && (
        <ClosedLaneHeader
          count={closedRows.length}
          archivedCount={archivedCount}
          archiving={archiving}
          onArchiveAll={() => {
            if (archiving) return
            try {
              const trees = actions.captureArchiveBatch(closedRows.map((row) => row.value.id))
              if (trees === LOADING) {
                toast.error('Tasks are still loading. Try archiving again.')
                return
              }
              for (const tree of trees)
                void archive(tree.rootId).then(() =>
                  setArchivedTrees((current) =>
                    current.map((item) => (item === tree ? { ...tree, queued: true } : item)),
                  ),
                )
              setArchivedTrees(trees)
            } catch {
              toast.error('Could not load all tasks to archive')
            }
          }}
          onUndo={undoArchive}
        />
      )}
      {filterEmpty && <WorkFilterEmpty />}
      {!filterEmpty && lane !== 'open' && bands.length === 0 && (
        <div data-testid="work-lane-empty" className="px-[22px] py-6 text-[11.5px] text-text-faint">
          {lane === 'snoozed' ? 'Nothing snoozed.' : 'Nothing closed in the last 7 days.'}
        </div>
      )}
      {pinned.length > 0 && (
        <m.div
          layout="position"
          layoutDependency={revision.current.value}
          transition={transition}
          className="flex min-w-0 flex-col border-b border-hairline-bar pt-1 pb-1.5"
          data-testid="pinned-section"
          data-drag-section
        >
          <ProjectFolderHeader
            label="Pinned"
            pinned
            count={pinned.length}
            collapsed={collapsed.has(PINNED_FOLD_KEY)}
            onToggle={() => toggle(PINNED_FOLD_KEY)}
            testId="pinned-section-label"
          />
          <FoldPanel open={!collapsed.has(PINNED_FOLD_KEY)} testId="pinned-section-rows">
            {windowRows(pinned, renderRow, 'pinned')}
          </FoldPanel>
        </m.div>
      )}
      {bands.map((band, index) => {
        const empty = band.rows.length === 0
        const shut = collapsed.has(band.foldKey)
        const draggingThis = folderDrag?.key === band.key
        return (
          <m.div
            key={band.key}
            layout="position"
            layoutDependency={revision.current.value}
            transition={folderTransition}
            className={cn(
              'relative flex min-w-0 flex-col border-b border-hairline-bar pt-1 pb-1.5',
              draggingThis && 'z-10',
            )}
            data-testid="project-group"
            data-folder-key={band.key}
            data-empty={empty ? 'true' : undefined}
            data-collapsed={shut || empty ? 'true' : 'false'}
            data-drag-section={empty ? undefined : true}
          >
            <ProjectFolderHeader
              label={band.label}
              count={band.rows.length}
              collapsed={shut}
              empty={empty}
              dragging={draggingThis}
              onToggle={() => toggle(band.foldKey)}
              onGripDown={
                filtering || sections.bands.length < 2
                  ? undefined
                  : (event) => startFolderDrag(event, band.key)
              }
              onNewTask={band.repoPath ? () => startNewTask(band.repoPath) : undefined}
              menu={{
                onMoveUp: index > 0 && !filtering ? () => moveBy(band.key, -1) : undefined,
                onMoveDown:
                  index < bands.length - 1 && !filtering ? () => moveBy(band.key, 1) : undefined,
                onToggle: () => toggle(band.foldKey),
                onCollapseAll: anyOpen ? () => setAllCollapsed(true) : undefined,
                onExpandAll: anyShut ? () => setAllCollapsed(false) : undefined,
                repo:
                  band.repoId && band.repoPath
                    ? { repoId: band.repoId, path: band.repoPath }
                    : undefined,
              }}
            />
            {!empty && (
              <FoldPanel
                open={!shut && folderDrag === null}
                quick={quickFold}
                retain={folderDrag !== null}
                testId="project-group-rows"
              >
                {band.rows.length > 0 && windowRows(band.rows, renderRow, `group:${band.key}`)}
              </FoldPanel>
            )}
          </m.div>
        )
      })}
      {filtering && !filterEmpty && (
        <WorkFilterFootnote
          total={targets.filter((target) => laneOf(target.value) === lane).length}
        />
      )}
      {menu && (
        <PoolFoldedMenu
          pool={pool}
          id={menu.id}
          anchor={menu.anchor}
          actions={actions}
          close={() => setMenu(null)}
        />
      )}
    </WorklistMotion>
  )
})

function rank(order: readonly string[], key: string): number {
  const at = order.indexOf(key)
  return at < 0 ? order.length : at
}

const PoolFoldedMenu = observer(function PoolFoldedMenu({
  pool,
  id,
  anchor,
  actions,
  close,
}: {
  pool: MobxPool
  id: string
  anchor: ContextMenuAnchor
  actions: PoolWorkActions
  close: () => void
}) {
  const value = sidebarView(pool).row(id)
  return value === undefined || value === LOADING ? null : (
    <FoldedRowMenu
      issue={navigationIssue(value.issue)}
      canBringBack={value.canBringBack}
      onUnsnooze={
        value.issue.deferred
          ? () => {
              void actions.undeferIssue(id)
            }
          : undefined
      }
      anchor={anchor}
      onClose={close}
      onBringBack={() => {
        void actions.setIssueTucked(id, false)
      }}
    />
  )
})

const PoolMotionRow = observer(function PoolMotionRow({
  pool,
  item,
  actions,
  digit,
  layoutRevision,
  reduceMotion,
  filtering,
  animate,
  quickArchive,
  settle,
  discardExit,
  onGrip,
  openMenu,
  onArchive,
}: {
  pool: MobxPool
  item: Item
  actions: PoolWorkActions
  digit?: number
  layoutRevision: number
  reduceMotion: boolean
  filtering: boolean
  animate: boolean
  quickArchive: boolean
  settle: (key: string, placement: string) => void
  discardExit: (key: string, placement: string) => void
  onGrip: (event: PointerEvent, id: string) => void
  openMenu: (id: string, event: MouseEvent) => void
  onArchive: (id: string) => void
}): JSX.Element | null {
  const { id, kind, lane } = item.value
  const worklist = useWorklistModel() ?? worklistView(pool)
  const companion = kind === 'issue' ? worklist.knownRow(id) : undefined
  const folded = lane === 'closed' || lane === 'snoozed'
  const visible = usePanelVisible()
  const fresh = companion?.ready === 'ready' ? companion : companion?.ready
  const now = 0
  // The existing exit snapshot retains the final paint after archive or eviction.
  const previous = useRef<SidebarRowValues | undefined>(undefined)
  // Retain the last committed paint. Snapshot-only stored fields must not
  // become live dependencies of the row observer.
  useLayoutEffect(() => {
    if (fresh !== undefined && fresh !== LOADING) previous.current = sidebarExitSnapshot(fresh)
  })
  const snapshot = fresh === undefined && item.phase === 'exiting' ? previous.current : undefined
  const draftOnly = fresh && fresh !== LOADING ? fresh.sessionOnlyDraft : snapshot?.draftAgentOnly
  const firstSessionId =
    fresh && fresh !== LOADING ? fresh.firstSessionId : snapshot?.firstSessionId
  const draftPane = useRuntimeSelector(
    (s) => visible && draftOnly === true && s.paneA === firstSessionId,
  )
  const active = visible && companion?.selected === true
  const arriving = animate && item.phase === 'entering'
  const exiting = item.phase === 'exiting'
  const draggable =
    kind === 'issue' &&
    !exiting &&
    !filtering &&
    fresh !== undefined &&
    fresh !== LOADING &&
    !fresh.issue.deferred
  const select = useCallback(() => actions.selectIssue(id), [actions, id])
  const tuck = useCallback(() => {
    void actions.setIssueTucked(id, true)
  }, [actions, id])
  const menuData = useCallback(() => actions.resolveMenuData(id), [actions, id])
  const selectIssue = useCallback(
    (issue: IssueNavigationModel) => actions.selectIssue(issue.id),
    [actions],
  )
  const selectPanel = useCallback(
    (issue: IssueNavigationModel, sid: SessionId) => actions.selectPanelForIssue(issue.id, sid),
    [actions],
  )
  const grip = useCallback(
    (event: PointerEvent, issueId: string) => onGrip(event, issueId),
    [onGrip],
  )
  const contextMenu = useCallback((event: MouseEvent) => openMenu(id, event), [openMenu, id])
  const archiveRow = useCallback(() => onArchive(id), [onArchive, id])
  const row = snapshot ? poolIssueRow(snapshot) : undefined
  const display = snapshot ? poolIssueDisplay(snapshot) : undefined
  if (kind === 'issue' && fresh === undefined && snapshot === undefined) return null
  const inner =
    kind === 'worktree' ? (
      <PoolWorktreeRow pool={pool} path={id} actions={actions} />
    ) : fresh === LOADING ? (
      <div data-testid="pool-row-loading" aria-busy="true" className="min-h-12" />
    ) : folded && fresh ? (
      <WorklistFoldedRow
        model={fresh}
        lane={lane as 'closed' | 'snoozed'}
        now={now}
        active={active}
        onSelect={select}
        onContextMenu={lane === 'closed' || lane === 'snoozed' ? contextMenu : undefined}
        onArchive={lane === 'closed' ? archiveRow : undefined}
      />
    ) : folded && snapshot ? (
      <MemoFoldedWorkRow
        issue={navigationIssue(snapshot.issue)}
        lane={lane as 'closed' | 'snoozed'}
        now={now}
        active={active}
        onSelect={select}
        onContextMenu={lane === 'closed' || lane === 'snoozed' ? contextMenu : undefined}
      />
    ) : fresh ? (
      <WorklistIssueRow
        model={fresh}
        now={now}
        active={active && (!fresh.sessionOnlyDraft || draftPane)}
        shortcutDigit={digit}
        resolveMenuData={menuData}
        onSelectIssue={selectIssue}
        onSelectPanelForIssue={selectPanel}
        onOpenIssue={actions.openIssuePage}
        onRenameIssue={actions.renameIssue}
        onGripDown={draggable ? grip : undefined}
        onTuck={fresh.canTuck ? tuck : undefined}
      />
    ) : snapshot ? (
      <UnifiedIssueRow
        row={row!}
        display={display}
        now={now}
        displayTitle={snapshot.title}
        progress={snapshot.progress}
        origin={snapshot.originTick as Parameters<typeof UnifiedIssueRow>[0]['origin']}
        active={active && (!snapshot.draftAgentOnly || draftPane)}
        shortcutDigit={digit}
        resolveMenuData={menuData}
        onSelectIssue={selectIssue}
        onSelectPanelForIssue={selectPanel}
        onOpenIssue={actions.openIssuePage}
        onRenameIssue={actions.renameIssue}
        onTuck={snapshot.awaitsTuck ? tuck : undefined}
      />
    ) : null
  return (
    <m.div
      layout="position"
      layoutDependency={layoutRevision}
      transition={reduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }}
      {...(draggable ? { 'data-drag-key': id } : {})}
      className={cn('min-w-0', arriving && 'row-arrive', exiting && 'pointer-events-none')}
      onAnimationEnd={
        arriving
          ? (event: AnimationEvent) => {
              if (event.animationName === 'podium-arrive-wash') settle(item.key, item.placement)
            }
          : undefined
      }
      data-transition-phase={item.phase}
    >
      <m.div
        initial={arriving && !reduceMotion ? { opacity: 0, y: -4 } : false}
        animate={exiting ? { opacity: 0, y: -4 } : { opacity: 1, y: 0 }}
        onAnimationComplete={
          exiting && quickArchive ? () => discardExit(item.key, item.placement) : undefined
        }
        transition={
          reduceMotion ? { duration: 0 } : exiting ? ROW_EXIT : arriving ? ROW_ENTER : ROW_RESTORE
        }
      >
        {inner}
      </m.div>
    </m.div>
  )
})

/** A row leaves on a short ease-in and arrives on a strong ease-out, both
 *  under 200ms (POD-2080). The arrival's opacity waits one frame or two so the
 *  neighbours have begun opening its slot before it shows in it. */
const ROW_EXIT = {
  opacity: { duration: MOTION_S.exit - 0.02, ease: EASE_IN },
  y: { duration: MOTION_S.exit, ease: EASE_IN },
}
const ROW_ENTER = {
  opacity: { duration: MOTION_S.enter - 0.04, delay: 0.04, ease: EASE_OUT },
  y: { duration: MOTION_S.enter, ease: EASE_OUT },
}
const ROW_RESTORE = {
  opacity: { duration: MOTION_S.enter, ease: EASE_OUT },
  y: { duration: MOTION_S.enter, ease: EASE_OUT },
}

const PoolWorktreeRow = observer(function PoolWorktreeRow({
  pool,
  path,
  actions,
}: {
  pool: MobxPool
  path: string
  actions: PoolWorkActions
}) {
  const visible = usePanelVisible()
  const state = useRuntimeSelector((s) => {
    const active =
      visible &&
      s.selectedIssueId === null &&
      s.selectedWorktree != null &&
      machinePathsEqual(s.selectedWorktree, path)
    return { selectedWorktree: active ? path : null, paneA: active ? s.paneA : null }
  }, shallowEqual)
  const entity = here(pool.model('worktree', path))
  const model = entity ? worklistView(pool).tree(entity) : undefined
  const select = useCallback(() => actions.selectWorktree(path), [actions, path])
  const panel = useCallback((sid: SessionId) => actions.selectPanel(path, sid), [actions, path])
  const renderSession = useCallback(
    (session: SessionView, active: boolean, ref: string | undefined, trailing: ReactNode) => (
      <PoolPanelRow
        key={session.sessionId}
        pool={pool}
        id={session.sessionId}
        active={active}
        actions={actions}
        path={path}
        issueDisplayRef={ref}
        trailingMeta={trailing}
      />
    ),
    [pool, actions, path],
  )
  if (!model || (!model.rosterIds.length && model.pending === 0)) return null
  return (
    <UnifiedWorktreeRow
      model={model}
      active={model.active(state)}
      paneA={state.paneA}
      now={0}
      renderSession={renderSession}
      onSelect={select}
      onSelectPanel={panel}
    />
  )
})

const PoolPanelRow = observer(function PoolPanelRow({
  pool,
  id,
  path,
  actions,
  active,
  issueDisplayRef,
  trailingMeta,
}: {
  pool: MobxPool
  id: string
  path: string
  actions: PoolWorkActions
  active: boolean
  issueDisplayRef?: string
  trailingMeta: ReactNode
}) {
  const visible = usePanelVisible()
  const projection = useMemo(
    () =>
      computed(
        () => omitGone(pool.row('session', id)) as SessionView | typeof LOADING | undefined,
        {
          equals: (a, b) =>
            compareStructural(
              a !== undefined && a !== LOADING ? poolSessionPaint(a) : a,
              b !== undefined && b !== LOADING ? poolSessionPaint(b) : b,
            ),
        },
      ),
    [pool, id],
  )
  const read = useCallback(() => projection.get(), [projection])
  const value = useWorklistPoolProjection(read, undefined, visible, true)
  const select = useCallback(() => actions.selectPanel(path, id as SessionId), [actions, path, id])
  const snoozeProjection = useMemo(
    () =>
      computed(
        () => {
          if (value === undefined || value === LOADING) return undefined
          const until =
            typeof value.snoozedUntil === 'string' ? Date.parse(value.snoozedUntil) : NaN
          const timed = Number.isFinite(until)
          const returned = timed && pool.clock.reached(until)
          return {
            snoozed: value.snoozedUntil === null || (timed && !returned),
            returned,
          }
        },
        { equals: compareStructural },
      ),
    [pool, value],
  )
  const readSnooze = useCallback(() => snoozeProjection.get(), [snoozeProjection])
  const snoozeState = useWorklistPoolProjection(readSnooze, undefined, visible, true)
  return value === LOADING ? (
    <div aria-busy="true" data-testid="pool-row-loading" className="min-h-6" />
  ) : value === undefined ? null : (
    <MemoPanelRow
      session={value}
      active={active}
      onSelect={select}
      dotRight
      roster
      guardWorking={isSessionWorking(value)}
      snoozeState={snoozeState}
      issueDisplayRef={issueDisplayRef}
      trailingMeta={trailingMeta}
    />
  )
})
