import { ISSUES_DISPLAY_KEY } from '@podium/client-core/ui-state'
import {
  activeFilterCount,
  assigneeFacet,
  type BoardFilter,
  DEFAULT_ISSUES_FILTERS,
  type filterChips,
  readSharedIssuesDisplay as readMobileTaskDisplay,
  writeSharedIssuesDisplay as writeMobileTaskDisplay,
} from '@podium/client-core/values'
import { MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useBooting } from '../client/hooks'
import { useMobileMemberRoster } from '../client/member-roster'
import { useMobilePool } from '../client/mobile-pool'
import { TaskFiltersSheet } from '../components/TaskFiltersSheet'
import { WorkIssueMenu, type WorkMenuSheet } from '../components/WorkIssueMenu'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useIssuesFilters } from '../hooks/useIssuesFilters'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { usePersistedUiState } from '../hooks/usePersistedUiState'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { useIssueRowActions } from '../lib/issue-row-actions'
import { type PoolWorkMenuData, resolvePoolWorkMenu } from '../lib/pool-work-menu'
import { color, font, radius, sans, space } from '../theme/theme'
import { TasksSurface } from './TasksSurface'
import { workTaskHref } from './work-navigation'

const NO_CHIPS: ReturnType<typeof filterChips> = []
const NO_FILTER: BoardFilter = {}

/**
 * THE TASKS TAB — high-level work, plus proposals that need a call [POD-947].
 *
 * The shared pool derives the rows with the board's membership rules and the
 * phone's proposal promotion. This file holds the screen's state — the board,
 * the filter sheet, the row menu — and every write. The list itself is a
 * surface: SwiftUI on iOS (`TasksSurface.ios.tsx`), React Native elsewhere.
 *
 * Long press opens Work's own menu (Rename, Mark as unread, Status, Move out of
 * mission, Delete), so a task answers the same acts on both tabs.
 */
export const IssuesScreen = observer(function IssuesScreen() {
  const router = useRouter()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [menu, setMenu] = useState<(PoolWorkMenuData & { initialSheet?: WorkMenuSheet }) | null>(
    null,
  )
  const [actionError, setActionError] = useState<string | null>(null)
  const [display] = usePersistedUiState(
    ISSUES_DISPLAY_KEY,
    readMobileTaskDisplay,
    writeMobileTaskDisplay,
  )
  // Assigned to and Show agent tasks are the member's own saved filters, on
  // the row the web writes too (POD-6294, POD-6297); the other facets belong
  // to this screen. On a one-member instance, or until the roster loads,
  // Assigned to narrows nothing and is not offered.
  const [savedFilters, setSavedFilters] = useIssuesFilters()
  const roster = useMobileMemberRoster()
  const shared = roster?.shared === true
  const assignee = assigneeFacet(savedFilters.assignedTo, {
    shared,
    viewer: roster?.currentMemberId,
  })
  const refresh = useRefreshableTab('issues')
  const bottomInset = useContentBottomInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()

  const pool = useMobilePool()
  const booting = useBooting() || !pool
  // The board holds the view's options (show done, open parents, filter and
  // search) and its lists; it is built once per pool. The display preference
  // seeds it here and reaches it afterwards through `showDisplay` below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: built once per pool; showDisplay below carries later display and filter changes
  const board = useMemo(
    () =>
      pool
        ? new MobileTasksBoard(pool, {
            showDone: false,
            expanded: [],
            filter: {},
            ordering: display.ordering,
            showAgentTasks: savedFilters.showAgentTasks,
          })
        : null,
    [pool],
  )
  // The display and filter preferences stay saved in ui-state until the
  // UiStore (POD-5797) holds them; the board follows them from here.
  const showAgentTasks = savedFilters.showAgentTasks
  useEffect(() => {
    board?.showDisplay({ ordering: display.ordering, showAgentTasks, assignee })
  }, [board, display.ordering, showAgentTasks, assignee])
  const filterCount = activeFilterCount(board?.filter ?? NO_FILTER, savedFilters, shared)

  const openMenu = useCallback(
    (id: string, initialSheet?: WorkMenuSheet) => {
      if (!pool) return
      const target = resolvePoolWorkMenu(pool, id, 'live')
      if (target) setMenu({ ...target, ...(initialSheet ? { initialSheet } : {}) })
    },
    [pool],
  )
  const onError = useCallback((message: string) => setActionError(message), [])
  // Work's row acts, through the one dispatch both lists share.
  const { onAction, onStatus, onClose } = useIssueRowActions({ openMenu, onError })

  return (
    <>
      <TasksSurface
        board={board}
        booting={booting}
        chips={board?.chips ?? NO_CHIPS}
        filterCount={filterCount}
        refresh={refresh}
        minimizeOnScroll={minimizeOnScroll}
        bottomInset={bottomInset}
        onOpen={(id) => {
          router.push(workTaskHref(pool, id))
        }}
        onScreenProposals={() =>
          router.push({
            pathname: '/screen-proposed',
            params: { text: board?.searchFilter.text ?? '' },
          })
        }
        onRemoveFilter={(key) => board?.clearFilter(key)}
        onOpenActions={(issue) => openMenu(issue.id)}
        onAction={onAction}
        onStatus={onStatus}
        onClose={onClose}
        onFilters={() => setFiltersOpen(true)}
        onNewTask={() => router.push('/new-issue')}
      />
      {/* Mounted only while open: a sheet failure can never take the tab down
          with it, and a closed sheet costs nothing. */}
      {filtersOpen ? (
        <TaskFiltersSheet
          visible
          filter={board?.filter ?? NO_FILTER}
          ordering={display.ordering}
          showDone={board?.showDone ?? false}
          showAgentTasks={showAgentTasks}
          assignedTo={savedFilters.assignedTo}
          roster={roster}
          count={filterCount}
          onFilter={(filter) => board?.setFilter(filter)}
          onOrdering={(ordering) => board?.setOrdering(ordering)}
          onShowDone={(show) => {
            if (board && board.showDone !== show) board.toggleShowDone()
          }}
          onShowAgentTasks={(show) =>
            setSavedFilters({ assignedTo: savedFilters.assignedTo, showAgentTasks: show })
          }
          onAssignedTo={(assignedTo) => setSavedFilters({ assignedTo, showAgentTasks })}
          onReset={() => {
            const filter = board?.filter ?? NO_FILTER
            board?.setFilter(filter.text ? { text: filter.text } : {})
            setSavedFilters({ ...DEFAULT_ISSUES_FILTERS })
          }}
          onClose={() => setFiltersOpen(false)}
        />
      ) : null}
      {menu ? (
        <WorkIssueMenu
          key={`${menu.target.issue.id}:${menu.initialSheet?.kind ?? 'menu'}`}
          {...menu}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {actionError ? (
        <View style={styles.errorBand} accessibilityLiveRegion="assertive">
          <Text selectable style={styles.errorText}>
            {actionError}
          </Text>
        </View>
      ) : null}
    </>
  )
})

const styles = StyleSheet.create({
  errorBand: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.lg,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.dangerSoft,
  },
  errorText: { ...sans(500), color: color.dangerText, fontSize: font.small },
})
