import { ISSUES_DISPLAY_KEY } from '@podium/client-core/ui-state'
import {
  type BoardFilter,
  discoveredPlacement,
  type filterChips,
  type IssueNavigationModel,
  readSharedIssuesDisplay as readMobileTaskDisplay,
  writeSharedIssuesDisplay as writeMobileTaskDisplay,
} from '@podium/client-core/values'
import { MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { parseIssueStatusValue } from '@podium/model'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useBooting, useStoreActions } from '../client/hooks'
import { useMobilePool } from '../client/mobile-pool'
import { useIssueCloseGuard } from '../client/use-issue-close'
import { TaskFiltersSheet } from '../components/TaskFiltersSheet'
import { WorkIssueMenu, type WorkMenuSheet } from '../components/WorkIssueMenu'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { usePersistedUiState } from '../hooks/usePersistedUiState'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { type PoolWorkMenuData, resolvePoolWorkMenu } from '../lib/pool-work-menu'
import type { WorkMenuActionId } from '../lib/work-menu'
import { color, font, radius, sans, space } from '../theme/theme'
import { TasksSurface } from './TasksSurface'

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
  const store = useStoreActions()
  const hasCloseBlockers = useIssueCloseGuard()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [menu, setMenu] = useState<(PoolWorkMenuData & { initialSheet?: WorkMenuSheet }) | null>(
    null,
  )
  const [actionError, setActionError] = useState<string | null>(null)
  const [display, setDisplay] = usePersistedUiState(
    ISSUES_DISPLAY_KEY,
    readMobileTaskDisplay,
    writeMobileTaskDisplay,
  )
  const refresh = useRefreshableTab('issues')
  const bottomInset = useContentBottomInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()

  const pool = useMobilePool()
  const booting = useBooting() || !pool
  // The board holds the view's options (show done, open parents, filter and
  // search) and its lists; it is built once per pool. The display preference
  // seeds it here and reaches it afterwards through `showDisplay` below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: built once per pool, by design
  const board = useMemo(
    () =>
      pool
        ? new MobileTasksBoard(pool, {
            showDone: false,
            expanded: [],
            filter: {},
            ordering: display.ordering,
            showAgentTasks: display.showAgentTasks,
          })
        : null,
    [pool],
  )
  // The display preference stays saved in ui-state until the UiStore (POD-5797)
  // holds it; the board follows it from here.
  useEffect(() => {
    board?.showDisplay(display)
  }, [board, display])

  const openMenu = useCallback(
    (id: string, initialSheet?: WorkMenuSheet) => {
      if (!pool) return
      const target = resolvePoolWorkMenu(pool, id, 'live')
      if (target) setMenu({ ...target, ...(initialSheet ? { initialSheet } : {}) })
    },
    [pool],
  )
  const runAction = useCallback((action: Promise<unknown>) => {
    setActionError(null)
    void action.catch((error) =>
      setActionError(error instanceof Error ? error.message : String(error)),
    )
  }, [])
  const onAction = useCallback(
    (id: string, action: WorkMenuActionId) => {
      if (!pool) return
      const issue = pool.issueObject(id) as unknown as IssueNavigationModel
      if (action === 'read')
        runAction(issue.unread ? store.markIssueRead(id) : store.markIssueUnread(id))
      else if (action === 'placement') {
        const placement = discoveredPlacement(issue)
        if (placement?.originId)
          runAction(
            store.setIssuePlacement(
              id,
              placement.placement === 'mission' ? 'own' : 'mission',
              placement.originId,
            ),
          )
      } else if (action === 'rename' || action === 'status') openMenu(id, { kind: action })
      else if (action === 'delete') openMenu(id, { kind: 'confirm-delete' })
    },
    [openMenu, pool, runAction, store],
  )
  const onStatus = useCallback(
    (id: string, value: string) => {
      const intent = parseIssueStatusValue(value)
      if (!intent) return
      if (intent.kind === 'stage') runAction(store.updateIssue(id, { stage: intent.stage }))
      else if (hasCloseBlockers(id)) openMenu(id, { kind: 'confirm-close', reason: intent.reason })
      else runAction(store.closeIssue(id, intent.reason))
    },
    [hasCloseBlockers, openMenu, runAction, store],
  )
  const onClose = useCallback(
    (id: string) => {
      if (hasCloseBlockers(id)) openMenu(id, { kind: 'confirm-close', reason: 'done' })
      else runAction(store.closeIssue(id, 'done'))
    },
    [hasCloseBlockers, openMenu, runAction, store],
  )

  return (
    <>
      <TasksSurface
        board={board}
        booting={booting}
        chips={board?.chips ?? NO_CHIPS}
        refresh={refresh}
        minimizeOnScroll={minimizeOnScroll}
        bottomInset={bottomInset}
        onOpen={(id) => router.push(`/issue/${encodeURIComponent(id)}`)}
        onScreenProposals={() => router.push('/screen-proposed')}
        onRemoveFilter={(key) => board?.clearFilter(key)}
        onOpenActions={(issue) => openMenu(issue.id)}
        onAction={onAction}
        onStatus={onStatus}
        onClose={onClose}
        onFilters={() => setFiltersOpen(true)}
        onNewTask={() => router.push('/new-issue')}
      />
      <TaskFiltersSheet
        visible={filtersOpen}
        filter={board?.filter ?? NO_FILTER}
        ordering={display.ordering}
        showDone={board?.showDone ?? false}
        showAgentTasks={display.showAgentTasks}
        onFilter={(filter) => board?.setFilter(filter)}
        onOrdering={(ordering) => setDisplay({ ...display, ordering })}
        onShowDone={(show) => {
          if (board && board.showDone !== show) board.toggleShowDone()
        }}
        onShowAgentTasks={(showAgentTasks) => setDisplay({ ...display, showAgentTasks })}
        onClose={() => setFiltersOpen(false)}
      />
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
