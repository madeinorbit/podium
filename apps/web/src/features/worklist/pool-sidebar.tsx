import { here, omitGone } from '@podium/client-graph/lookup'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import type { SessionView } from '@podium/client-core/session-values'
import { relativeTime } from '@podium/client-core/focus'
import type { Store } from '@podium/client-core/react'
import { shallowEqual } from '@podium/client-core/shallow-equal'
import {
  type IssueNavigationModel,
  issueClosedFoldAt,
  isSessionWorking,
  planReorderKeys,
} from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { compareStructural, computed, observer, WorklistProvider, useWorklistModel } from '@podium/client-graph/react'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import type { SliceWorktree } from '@podium/client-graph/shared/slice-types'
import type { SidebarSections, SidebarState } from '@podium/client-graph/worklist/sidebar'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'
import { asIssueId, machinePathKey, machinePathsEqual, type SessionId } from '@podium/model/browser'
import * as m from 'motion/react-m'
import {
  type AnimationEvent,
  type CSSProperties,
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
} from 'react'
import { useRuntimeSelector } from '@/app/store'
import { usePanelVisible } from '@/app/panel-visible'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { MobilePromoCard } from '@/features/mobile-handoff/MobilePromoCard'
import { issueColorHex } from '@/lib/issueColors'
import { type RowTransitionItem, type RowTransitionTarget, useRowTransitions } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { useReducedMotion } from '@/lib/use-reduced-motion'
import { cn } from '@/lib/utils'
import { FoldedRowMenu } from './FoldedRowMenu'
import { PINNED_FOLD_KEY, projectFoldKey } from './fold-keys'
import { ManageProjectsButton } from './ManageProjectsDialog'
import { AddRepositoryButton, NewTaskRow, StartFirstTaskRow } from './new-task-row'
import {
  navigationIssue,
  poolIssueDisplay,
  worklistIssueHaystack,
  sidebarExitSnapshot,
  poolIssueRow,
  poolSessionPaint,
  poolWorktreeRow,
} from './pool-row-data'
import { MAX_ROW_SHORTCUTS, useRowShortcuts } from './row-shortcuts'
import { PanelRow, useCollapsedKeys } from './sidebar-common'
import { UnifiedIssueRow, WorklistIssueRow } from './UnifiedIssueRow'
import { UnifiedWorktreeRow } from './UnifiedWorktreeRow'
import { type PoolWorkActions, usePoolUnifiedWork } from './use-pool-unified-work'
import { useRowDrag } from './useRowDrag'
import { WorkListEmpty } from './WorkListEmpty'
import { normalizeWorkQuery } from './work-filter'
import {
  ClosedIssueFold,
  FoldedWorkRow,
  WorklistFoldedRow,
  FoldPanel,
  foldedMarker,
  PinnedSectionLabel,
  ProjectGroupLabel,
  ROW_LAYOUT_TRANSITION,
  SECTION_GAP_CLASS,
  SnoozedIssueFold,
} from './work-folds'
import {
  useWorkFilterState,
  WorkFilterEmpty,
  WorkFilterFootnote,
  WorkSearchField,
} from './work-search'
import { WorklistMotion } from './worklist-motion'
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

function slotsFor(sections: SidebarSections, orderByScope?: Map<string, readonly string[]>): RowTransitionTarget<Slot>[] {
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
  const value = omitGone(pool.row('worktree', slot.id)) as SliceWorktree | typeof LOADING | undefined
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

export const PoolSidebarUnified = observer(function PoolSidebarUnified(): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pool = useWorklistPool()
  const state = usePoolLayoutState()
  const model = pool ? worklistView(pool) : null
  useEffect(() => { model?.setLayout(state) }, [model, state])
  const input = useWorkFilterState()
  const needle = normalizeWorkQuery(input.deferredQuery)
  const count = useMemo(
    () =>
      computed(
        () => {
          if (!pool) return { total: 0, hits: 0 }
          const live = slotsFor(sidebarView(pool).sections(state)).filter(
            (slot) => slot.value.lane === 'pinned' || slot.value.lane === 'open',
          )
          return {
            total: live.length,
            hits: needle
              ? live.filter((slot) => matches(pool, slot.value, needle)).length
              : live.length,
          }
        },
        { equals: compareStructural },
      ),
    [pool, state, needle],
  ).get()
  return (
    <WorklistProvider model={model}>
      <NewTaskRow />
      <WorkSearchField
        filter={{ ...input, ...count }}
        trailing={
          <div className="flex flex-none items-center gap-1">
            <ManageProjectsButton />
            <AddRepositoryButton />
          </div>
        }
      />
      <div
        ref={scrollRef}
        data-testid="work-scroll"
        style={{ overflowAnchor: 'none' }}
        className="scroll-none flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto pb-2.5"
      >
        <PoolWorkSections query={input.deferredQuery} scrollRef={scrollRef} />
      </div>
      <MobilePromoCard />
    </WorklistProvider>
  )
})

export function PoolWorkSections({
  query = '',
  scrollRef,
}: {
  query?: string
  scrollRef?: RefObject<HTMLElement | null>
}): JSX.Element | null {
  const pool = useWorklistPool()
  const fallbackScroll = useRef<HTMLElement | null>(null)
  return pool ? (
    <ObservedPoolWorkSections pool={pool} query={query} scrollRef={scrollRef ?? fallbackScroll} />
  ) : null
}

const ObservedClosedIssueFold = observer(ClosedIssueFold<Item>)
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

const ObservedPoolWorkSections = observer(function ObservedPoolWorkSections({
  pool,
  query,
  scrollRef,
}: {
  pool: MobxPool
  query: string
  scrollRef: RefObject<HTMLElement | null>
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
  const [quickArchive, setQuickArchive] = useState<ReadonlySet<string>>(() => new Set())
  const [menu, setMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null)
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
    const key =
      selected.lane === 'pinned' ? PINNED_FOLD_KEY : projectFoldKey(selected.groupKey)
    if (collapsed.has(key)) toggle(key)
    // Selection is the reveal request; folding the current selection stays folded.
  }, [selectedId, slotById, collapsed, toggle])
  const search = useMemo(
    () =>
      computed(
        () =>
          new Set(
            targets
              .filter(
                (target) =>
                  (target.value.lane === 'pinned' || target.value.lane === 'open') &&
                  matches(pool, target.value, needle),
              )
              .map((target) => target.key),
          ),
        { equals: compareStructural },
      ),
    [pool, targets, needle],
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
    setQuickArchive((current) => new Set(current).add(id))
    void actions.archiveIssue(id).catch(() => forgetQuickArchive([id]))
  }
  const signature = targets.map((target) => `${target.key}:${target.placement}`).join('|')
  const revision = useRef({ signature: '', value: 0 })
  if (!dragging && revision.current.signature !== signature)
    revision.current = { signature, value: revision.current.value + 1 }
  const shortcutIds = targets
    .filter(
      (target) =>
        target.value.kind === 'issue' &&
        (target.value.lane === 'pinned'
          ? !collapsed.has(PINNED_FOLD_KEY)
          : target.value.lane === 'open' && !collapsed.has(projectFoldKey(target.value.groupKey))),
    )
    .slice(0, MAX_ROW_SHORTCUTS)
    .map((target) => target.value.id)
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
    />
  )
  const pinned = items.filter(
    (item) => item.value.lane === 'pinned' && (!filtering || search.has(item.key)),
  )
  const bands = sections.bands
    .map((band) => ({
      ...band,
      live: items.filter(
        (item) =>
          item.value.groupKey === band.key &&
          item.value.lane === 'open' &&
          (!filtering || search.has(item.key)),
      ),
      snoozed: filtering
        ? []
        : items.filter((item) => item.value.groupKey === band.key && item.value.lane === 'snoozed'),
      closed: filtering
        ? []
        : items.filter((item) => item.value.groupKey === band.key && item.value.lane === 'closed'),
    }))
    .filter((band) => !filtering || band.live.length > 0)
  // Exits can briefly outlive the band's pool membership.
  for (const item of items)
    if (
      item.value.lane !== 'pinned' &&
      !bands.some((band) => band.key === item.value.groupKey) &&
      !filtering
    )
      bands.push({
        key: item.value.groupKey,
        label: item.value.groupLabel,
        aliases: [],
        repoPath: '',
        rowIds: [],
        worktreeIds: [],
        snoozedIds: [],
        closedIds: [],
        collapsed: false,
        snoozedCollapsed: true,
        closedCollapsed: true,
        foldKey: projectFoldKey(item.value.groupKey),
        snoozedFoldKey: '',
        closedFoldKey: '',
        startFirstTask: false,
        live: items.filter(
          (row) => row.value.groupKey === item.value.groupKey && row.value.lane === 'open',
        ),
        snoozed: items.filter(
          (row) => row.value.groupKey === item.value.groupKey && row.value.lane === 'snoozed',
        ),
        closed: items.filter(
          (row) => row.value.groupKey === item.value.groupKey && row.value.lane === 'closed',
        ),
      })
  const windowRows = (
    rows: readonly Item[],
    render = renderRow,
    dragScope?: string,
    estimateSize = 50,
  ) => (
    <WorklistWindow
      rows={rows}
      rowKey={itemKey}
      renderRow={render}
      scrollRef={scrollRef}
      selectedKey={selectedId ? `issue:${selectedId}` : null}
      draggingKey={draggedId ? `issue:${draggedId}` : null}
      dragScope={dragScope}
      dragId={itemDragId}
      estimateSize={estimateSize}
    />
  )
  if (items.length === 0 && sections.bands.length === 0)
    return (
      <>
        <PoolEviction pool={pool} />
        <WorkListEmpty />
      </>
    )
  if (filtering && pinned.length === 0 && bands.length === 0)
    return (
      <>
        <PoolEviction pool={pool} />
        <WorkFilterEmpty />
      </>
    )
  const transition = reduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }
  return (
    <WorklistMotion layoutGroupId={layoutGroupId}>
      <PoolEviction pool={pool} />
      {pinned.length > 0 && (
        <m.div
          layout="position"
          layoutDependency={revision.current.value}
          transition={transition}
          className="flex min-w-0 flex-col"
          data-testid="pinned-section"
          data-drag-section
        >
          <PinnedSectionLabel
            count={pinned.length}
            collapsed={collapsed.has(PINNED_FOLD_KEY)}
            onToggle={() => toggle(PINNED_FOLD_KEY)}
          />
          <FoldPanel open={!collapsed.has(PINNED_FOLD_KEY)} testId="pinned-section-rows">
            {windowRows(pinned, renderRow, 'pinned')}
          </FoldPanel>
        </m.div>
      )}
      {bands.map((band, index) => (
        <m.div
          key={band.key}
          layout="position"
          layoutDependency={revision.current.value}
          transition={transition}
          className={cn(
            'flex min-w-0 flex-col',
            (index > 0 || pinned.length > 0) && SECTION_GAP_CLASS,
          )}
          data-testid="project-group"
          data-empty={band.startFirstTask ? 'true' : undefined}
          data-collapsed={collapsed.has(band.foldKey) ? 'true' : 'false'}
          data-drag-section={band.startFirstTask ? undefined : true}
        >
          <ProjectGroupLabel
            label={band.label}
            count={band.live.length}
            collapsed={collapsed.has(band.foldKey)}
            onToggle={() => toggle(band.foldKey)}
          />
          <FoldPanel
            open={!collapsed.has(band.foldKey)}
            testId={band.startFirstTask ? `project-group-empty:${band.key}` : 'project-group-rows'}
          >
            {band.startFirstTask ? (
              <StartFirstTaskRow repoPath={band.repoPath} />
            ) : (
              <>
                {windowRows(band.live, renderRow, `group:${band.key}`)}
                {band.snoozed.length > 0 && (
                  <m.div
                    layout="position"
                    layoutDependency={revision.current.value}
                    transition={transition}
                  >
                    <SnoozedIssueFold
                      groupKey={band.key}
                      rows={band.snoozed}
                      renderRow={renderRow}
                      settleTransition={settle}
                      revealKey={
                        band.snoozed.some((item) => item.value.id === selectedId)
                          ? selectedId
                          : null
                      }
                      renderRows={(rows, render) => windowRows(rows, render, undefined, 26)}
                    />
                  </m.div>
                )}
                {band.closed.length > 0 && (
                  <m.div
                    layout="position"
                    layoutDependency={revision.current.value}
                    transition={transition}
                  >
                    <ObservedClosedIssueFold
                      groupKey={band.key}
                      rows={band.closed}
                      renderRow={renderRow}
                      issueForRow={(item) => {
                        const value = issue(item.value.id)
                        return value
                          ? { kind: 'issue', issue: value.issue as unknown as IssueNavigationModel, sessions: value.sessions as unknown as SessionView[], activityAt: value.visibleActivityAt }
                          : {
                              kind: 'issue',
                              issue: {
                                id: asIssueId(item.value.id),
                                seq: 0,
                              } as IssueNavigationModel,
                              sessions: [],
                              activityAt: 0,
                            }
                      }}
                      onArchive={archive}
                      revealKey={
                        band.closed.some((item) => item.value.id === selectedId) ? selectedId : null
                      }
                      renderRows={(rows, render) => windowRows(rows, render, undefined, 26)}
                    />
                  </m.div>
                )}
              </>
            )}
          </FoldPanel>
        </m.div>
      ))}
      {filtering && (
        <WorkFilterFootnote
          total={
            targets.filter(
              (target) => target.value.lane === 'pinned' || target.value.lane === 'open',
            ).length
          }
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
  const firstSessionId = fresh && fresh !== LOADING ? fresh.firstSessionId : snapshot?.firstSessionId
  const draftPane = useRuntimeSelector(s => visible && draftOnly === true && s.paneA === firstSessionId)
  const active = visible && companion?.selected === true
  const arriving = animate && item.phase === 'entering'
  const exiting = item.phase === 'exiting'
  const draggable = kind === 'issue' && !exiting && !filtering && fresh !== undefined &&
    fresh !== LOADING && !fresh.issue.deferred
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
  const row = snapshot ? poolIssueRow(snapshot) : undefined
  const display = snapshot ? poolIssueDisplay(snapshot) : undefined
  if (kind === 'issue' && fresh === undefined && snapshot === undefined) return null
  const inner = kind === 'worktree' ? (
    <PoolWorktreeRow pool={pool} path={id} actions={actions} />
  ) : fresh === LOADING ? (
    <div data-testid="pool-row-loading" aria-busy="true" className="min-h-12" />
  ) : folded && fresh ? (
    <WorklistFoldedRow model={fresh} lane={lane as 'closed' | 'snoozed'} now={now}
      active={active} onSelect={select} onContextMenu={lane === 'closed' ? contextMenu : undefined} />
  ) : folded && snapshot ? (
    <MemoFoldedWorkRow issue={navigationIssue(snapshot.issue)} lane={lane as 'closed' | 'snoozed'}
      now={now} active={active} onSelect={select} onContextMenu={lane === 'closed' ? contextMenu : undefined} />
  ) : fresh ? (
    <WorklistIssueRow model={fresh} now={now} active={active && (!fresh.sessionOnlyDraft || draftPane)}
      shortcutDigit={digit} resolveMenuData={menuData} onSelectIssue={selectIssue}
      onSelectPanelForIssue={selectPanel} onOpenIssue={actions.openIssuePage}
      onRenameIssue={actions.renameIssue} onGripDown={draggable ? grip : undefined}
      onTuck={fresh.canTuck ? tuck : undefined} />
  ) : snapshot ? (
    <UnifiedIssueRow row={row!} display={display} now={now} displayTitle={snapshot.title}
      progress={snapshot.progress} origin={snapshot.originTick as Parameters<typeof UnifiedIssueRow>[0]['origin']}
      active={active && (!snapshot.draftAgentOnly || draftPane)} shortcutDigit={digit}
      resolveMenuData={menuData} onSelectIssue={selectIssue} onSelectPanelForIssue={selectPanel}
      onOpenIssue={actions.openIssuePage} onRenameIssue={actions.renameIssue}
      onTuck={snapshot.awaitsTuck ? tuck : undefined} />
  ) : null
  return (
    <m.div
      layout="position"
      layoutDependency={layoutRevision}
      transition={reduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }}
      {...(draggable ? { 'data-drag-key': id } : {})}
      className={cn(
        'min-w-0',
        arriving && 'row-arrive',
        exiting && 'pointer-events-none',
        folded &&
          'opacity-50 transition-opacity duration-150 hover:opacity-80 focus-within:opacity-80',
      )}
      style={
        arriving && fresh !== undefined && fresh !== LOADING
          ? ({
              '--arrive-tint': issueColorHex(
                fresh.issue.color as Parameters<typeof issueColorHex>[0],
              ),
            } as CSSProperties)
          : undefined
      }
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
        initial={arriving && !reduceMotion ? { opacity: 0, y: -8 } : false}
        animate={exiting ? { opacity: 0, y: -6 } : { opacity: 1, y: 0 }}
        onAnimationComplete={
          exiting && quickArchive ? () => discardExit(item.key, item.placement) : undefined
        }
        transition={
          reduceMotion
            ? { duration: 0 }
            : exiting
              ? quickArchive
                ? {
                    opacity: { duration: 0.14, ease: 'easeOut' },
                    y: { duration: 0.18, ease: [0.4, 0, 1, 1] },
                  }
                : {
                    opacity: { duration: 0.64, ease: 'easeInOut' },
                    y: { duration: 0.7, ease: [0.4, 0, 1, 1] },
                  }
              : {
                  opacity: { duration: 0.72, delay: arriving ? 0.22 : 0, ease: 'easeInOut' },
                  y: { duration: 0.78, delay: arriving ? 0.14 : 0, ease: [0.22, 1, 0.36, 1] },
                }
        }
      >
        {inner}
      </m.div>
    </m.div>
  )
})

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
    const active = visible && s.selectedIssueId === null && s.selectedWorktree != null && machinePathsEqual(s.selectedWorktree, path)
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
      computed(() => omitGone(pool.row('session', id)) as SessionView | typeof LOADING | undefined, {
        equals: (a, b) =>
          compareStructural(
            a !== undefined && a !== LOADING ? poolSessionPaint(a) : a,
            b !== undefined && b !== LOADING ? poolSessionPaint(b) : b,
          ),
      }),
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
