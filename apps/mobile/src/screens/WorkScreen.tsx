import type { IssueNavigationModel } from '@podium/client-core/values'
import { discoveredPlacement } from '@podium/client-core/values'
import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { observer, useWorklistModel, WorklistProvider } from '@podium/client-graph/react'
import { PhoneWorkFilters } from '@podium/client-graph/worklist/phone'
import type { SidebarState } from '@podium/client-graph/worklist/sidebar'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { parseIssueStatusValue, type SessionId } from '@podium/model'
import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStoreActions } from '../client/hooks'
import { useMobilePool, useMobilePoolProjection } from '../client/mobile-pool'
import { useIssueCloseGuard } from '../client/use-issue-close'
import { useSessionContextBooting } from '../client/use-session-context'
import { WorkSkeleton } from '../components/LaunchPlaceholders'
import { RefreshOffer } from '../components/RefreshOffer'
import { Screen } from '../components/Screen'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { WorkIssueMenu, type WorkMenuSheet } from '../components/WorkIssueMenu'
import { WorkspaceContinuityNotice } from '../components/WorkspaceContinuityNotice'
import { useCollapsedSet } from '../hooks/useCollapsedSet'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { type PoolWorkMenuData, resolvePoolWorkMenu } from '../lib/pool-work-menu'
import { sessionHref } from '../lib/session-route'
import type { WorkMenuActionId } from '../lib/work-menu'
import { WorkSurface } from './WorkSurface'

const EMPTY_LAYOUT: SidebarState = Object.freeze({
  projectOrder: [],
  pinnedRepos: [],
  pinnedWorktrees: [],
})
const readLayout = (pool: MobxPool): SidebarState => {
  const window = omitGone(pool.row('commandWindow', 'window'))
  return window && typeof window !== 'symbol'
    ? {
        projectOrder: window.sidebarSettings.repoOrder,
        pinnedRepos: window.pins.repos,
        pinnedWorktrees: window.pins.worktrees,
      }
    : EMPTY_LAYOUT
}
const foldKey = (key: string) =>
  key === 'pinned' ? 'podium:sidebar:pinned-fold' : `podium:sidebar:project-fold:${key}`

/** Both phone presentations borrow desktop membership and the same per-task companions. */
export function WorkScreen() {
  const pool = useMobilePool()
  return (
    <WorklistProvider model={pool ? worklistView(pool) : null}>
      <PoolWorkScreen />
    </WorklistProvider>
  )
}

const PoolWorkScreen = observer(function PoolWorkScreen() {
  const router = useRouter()
  const pool = useMobilePool()
  const model = useWorklistModel()
  const store = useStoreActions()
  const booting = useSessionContextBooting()
  const refresh = useRefreshableTab('work')
  const bottomInset = useContentBottomInset()
  const hasCloseBlockers = useIssueCloseGuard()
  const layout = useMobilePoolProjection(readLayout, EMPTY_LAYOUT)
  useEffect(() => {
    model?.setLayout(layout)
  }, [model, layout])
  const [filters] = useState(() => model?.phone.filters ?? new PhoneWorkFilters())
  // Initialize each newly attached presentation before its list renders. Only
  // the screen's UI state crosses that boundary; records stay with their pool.
  const phone = useMemo(() => {
    model?.phone.setFilters(filters)
    return model?.phone
  }, [model, filters])
  const keys = phone?.sections.map((section) => section.key) ?? []
  const { collapsed, toggle } = useCollapsedSet(keys, foldKey)
  const [pendingNav, setPendingNav] = useState<string | null>(null)
  const [menu, setMenu] = useState<(PoolWorkMenuData & { initialSheet?: WorkMenuSheet }) | null>(
    null,
  )
  useFocusEffect(
    useCallback(() => {
      setPendingNav(null)
      return () => setPendingNav(null)
    }, []),
  )

  const openIssue = useCallback(
    (issue: IssueNavigationModel) => {
      model?.select(issue.id)
      setPendingNav(issue.id)
      router.push(`/mission/${encodeURIComponent(issue.id)}`)
      void store.markIssueRead(issue.id)
    },
    [model, router, store],
  )
  const openSession = useCallback(
    (sessionId: SessionId, rowKey: string) => {
      model?.select(rowKey)
      setPendingNav(rowKey)
      router.push(sessionHref(sessionId, '/work'))
    },
    [model, router],
  )
  const openMenu = useCallback(
    (
      issue: IssueNavigationModel,
      lane: 'live' | 'snoozed' | 'closed' = 'live',
      initialSheet?: WorkMenuSheet,
    ) => {
      if (pool) {
        const target = resolvePoolWorkMenu(pool, issue.id, lane)
        if (target) setMenu({ ...target, initialSheet })
      }
    },
    [pool],
  )
  const onAction = useCallback(
    (id: string, action: WorkMenuActionId) => {
      const row = model?.knownRow(id)
      if (row?.ready !== 'ready') return
      const issue = row.issue as unknown as IssueNavigationModel
      if (action === 'read')
        void (issue.unread ? store.markIssueRead(id) : store.markIssueUnread(id))
      else if (action === 'undefer') void store.undeferIssue(id)
      else if (action === 'bringBack') void store.setIssueTucked(id, false)
      else if (action === 'placement') {
        const placement = discoveredPlacement(issue)
        if (placement?.originId)
          void store.setIssuePlacement(
            id,
            placement.placement === 'mission' ? 'own' : 'mission',
            placement.originId,
          )
      } else openMenu(issue, 'live', { kind: action === 'delete' ? 'confirm-delete' : action })
    },
    [model, openMenu, store],
  )
  const onStatus = useCallback(
    (id: string, value: string) => {
      const intent = parseIssueStatusValue(value),
        row = model?.knownRow(id)
      if (!intent || row?.ready !== 'ready') return
      if (intent.kind === 'stage') void store.updateIssue(id, { stage: intent.stage })
      else if (hasCloseBlockers(id))
        openMenu(row.issue as unknown as IssueNavigationModel, 'live', {
          kind: 'confirm-close',
          reason: intent.reason,
        })
      else void store.closeIssue(id, intent.reason)
    },
    [hasCloseBlockers, model, openMenu, store],
  )
  const tuck = useCallback((id: string) => void store.setIssueTucked(id, true), [store])

  if (!phone)
    return (
      <Screen large title="Work">
        <WorkSkeleton />
      </Screen>
    )
  return (
    <>
      <WorkSurface
        phone={phone}
        collapsed={collapsed}
        onToggle={toggle}
        pendingNav={pendingNav}
        onOpenIssue={openIssue}
        onOpenSession={openSession}
        onMenu={openMenu}
        onAction={onAction}
        onStatus={onStatus}
        onTuck={tuck}
        refresh={refresh}
        bottomInset={bottomInset}
        loading={booting}
        notices={
          <>
            <StorageNoticeAlert />
            <RefreshOffer />
            <WorkspaceContinuityNotice />
          </>
        }
      />
      {menu ? (
        <WorkIssueMenu
          key={`${menu.target.issue.id}:${menu.initialSheet?.kind ?? 'menu'}`}
          {...menu}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  )
})
