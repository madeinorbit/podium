import type { IssueNavigationModel } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import type {
  MobileWorkRef,
  MobileWorkSection,
  MobileWorkState,
} from '@podium/client-graph/worklist/mobile'
import type { SessionId } from '@podium/model'
import { canonicalIssueCloseReason, ISSUE_STATUS_LABELS } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Stack, useFocusEffect, useRouter } from 'expo-router'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  LayoutAnimation,
  Platform,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useStoreActions } from '../client/hooks'
import { useMobilePool, useMobilePoolProjection } from '../client/mobile-pool'
import { useSessionContextBooting } from '../client/use-session-context'
import { Icon } from '../components/Icon'
import { ChevronDown, ChevronRight, Pin, Search, Settings, X } from '../components/icons'
import { BootstrapCrossfade, WorkSkeleton } from '../components/LaunchPlaceholders'
import { NewWorkButton } from '../components/NewWorkButton'
import { NotSavedMark } from '../components/NotSavedMark'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { RefreshOffer } from '../components/RefreshOffer'
import { HeaderButton, Screen } from '../components/Screen'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { EmptyState } from '../components/ui'
import { WorkIssueMenu, type WorkIssueMenuTarget } from '../components/WorkIssueMenu'
import { WorkspaceContinuityNotice } from '../components/WorkspaceContinuityNotice'
import { useCollapsed } from '../hooks/useCollapsed'
import { useCollapsedSet } from '../hooks/useCollapsedSet'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { type PoolWorkMenuData, resolvePoolWorkMenu } from '../lib/pool-work-menu'
import { sessionHref } from '../lib/session-route'
import {
  MobileNativeSections,
  MobileSearchSections,
  mobilePaintNow,
  searchMobileSections,
  workGroupFoldKey,
} from '../lib/work-sections'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space, spring } from '../theme/theme'
import { PoolWorkRowSlot } from './WorkListRow'

const usesNativeHeader = process.env.EXPO_OS !== 'web'

/**
 * Work — the desktop sidebar, on the phone [POD-338, POD-724].
 *
 * The rows come from the pool's resident work indexes. Mobile adds one
 * deliberate triage projection: pinned rows first, then every ask in Needs You —
 * a pinned ask renders in BOTH bands, under a band-scoped list key — then the
 * project bands. Source order is preserved inside each
 * band, and reordering still writes in the original project/pinned scope;
 * tuck-away and the Snoozed / Closed folds stay shared. Every band folds from
 * its sticky header, and the fold replicates per-user like the desktop
 * sidebar's section collapses.
 *
 * ONE FLAT ROW PER MISSION (POD-516 §1.1). This screen used to disagree with the
 * desk about that: it drew a disclosure twist per row, an AGENTS roster band
 * under it, and recursed into `startedByChildren` — a second navigation tree in
 * the one place whose job is to be a list of missions. The order was therefore
 * "the same order" only in the sense that the same rows appeared somewhere in
 * it; a mission with three spin-offs occupied four slots here and one at the
 * desk, so scanning the two side by side never matched. The tree lives one
 * screen right, in the mission deck.
 *
 * What a subtree still owes this row is its SUMMARY, and now the phone carries
 * the same summary the desk does: bubbled attention, the fleet stack, the
 * mission progress meter, the git stamp, the spin-off origin tick and the
 * snoozed/pinned marks.
 */

/** How a folded row ended, in one dim mono word — twin of the desktop's
 *  `foldedMarker`. Nothing here is an ask, so none of it takes the accent. */
function foldedMarker(
  issue: IssueNavigationModel,
  lane: 'closed' | 'snoozed',
  now: number,
): string {
  if (lane === 'snoozed') {
    const until = issue.deferUntil ? Date.parse(issue.deferUntil) : Number.NaN
    if (!Number.isFinite(until)) return 'snoozed'
    const mins = Math.max(0, Math.round((until - now) / 60000))
    if (mins < 60) return 'snoozed <1h'
    const hours = Math.round(mins / 60)
    return hours < 24 ? `snoozed ${hours}h` : `snoozed ${Math.round(hours / 24)}d`
  }
  if (issue.gitState?.merged) return 'merged'
  // One word from the shared status vocabulary (POD-1074), so a row stored as
  // `wontfix` folds as "cancelled" here and on the desktop rather than as this
  // screen's own "won't fix".
  const reason = canonicalIssueCloseReason(issue.closedReason)
  if (reason && reason !== 'done') return ISSUE_STATUS_LABELS[reason].toLowerCase()
  return 'closed'
}

/**
 * The collapse/expand transition — the cheapest smooth mechanism available:
 * one LayoutAnimation frame committed alongside the fold's re-render, so rows
 * ease away under the sticky header instead of vanishing a frame late. Reduce
 * Motion snaps (the state flip alone), and react-native-web has no
 * LayoutAnimation, so the web build snaps too rather than warn.
 */
function configureFoldAnimation(reduceMotion: boolean): void {
  if (reduceMotion || Platform.OS === 'web') return
  LayoutAnimation.configureNext(
    LayoutAnimation.create(
      220,
      LayoutAnimation.Types.easeInEaseOut,
      LayoutAnimation.Properties.opacity,
    ),
  )
}

const EMPTY_MOBILE_SECTIONS: readonly MobileWorkSection[] = Object.freeze([])
const EMPTY_MOBILE_SPLIT = Object.freeze({
  sections: EMPTY_MOBILE_SECTIONS,
  orderingSections: EMPTY_MOBILE_SECTIONS,
  issueCount: 0,
  pinnedCount: 0,
  attentionCount: 0,
  pending: 0,
})
const mobileListKey = (ref: MobileWorkRef): string => ref.listKey
const EMPTY_LAYOUT: MobileWorkState = Object.freeze({
  projectOrder: [],
  pinnedRepos: [],
  pinnedWorktrees: [],
})
const readLayout = (pool: MobxPool): MobileWorkState => {
  const window = pool.row('commandWindow', 'window')
  return window && typeof window !== 'symbol'
    ? {
        projectOrder: window.sidebarSettings.repoOrder,
        pinnedRepos: window.pins.repos,
        pinnedWorktrees: window.pins.worktrees,
      }
    : EMPTY_LAYOUT
}

/** The work list reads the existing pool through attachment and principal rebuild. */
export function WorkScreen() {
  const router = useRouter()
  const pool = useMobilePool()
  const { markIssueRead, setIssueTucked } = useStoreActions()
  const booting = useSessionContextBooting()
  const { listRef, refreshControl, refreshAccessibilityProps, refreshing, onRefresh, connected } =
    useRefreshableTab('work')
  const bottomInset = useContentBottomInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()
  const layout = useMobilePoolProjection(readLayout, EMPTY_LAYOUT)
  const readSections = useCallback((graph: MobxPool) => graph.mobileWork.sections(layout), [layout])
  const split = useMobilePoolProjection(readSections, EMPTY_MOBILE_SPLIT)
  const { issueCount, pinnedCount, attentionCount } = split
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searching = query.trim().length > 0
  const sectionKeys = useMemo(() => split.sections.map((section) => section.key), [split.sections])
  const { collapsed: collapsedKeys, toggle: toggleCollapsed } = useCollapsedSet(
    sectionKeys,
    workGroupFoldKey,
  )
  const [searchSections] = useState(() => new MobileSearchSections())
  const readSearch = useCallback(
    (graph: MobxPool) =>
      searchMobileSections(
        graph,
        graph.mobileWork.sections(layout).sections,
        query,
        searchSections,
      ),
    [layout, query, searchSections],
  )
  const visibleSections = useMobilePoolProjection(readSearch, EMPTY_MOBILE_SECTIONS)
  const [nativeSections] = useState(() => new MobileNativeSections())
  const displaySections = useMemo(
    () => nativeSections.update(visibleSections, collapsedKeys, searching),
    [collapsedKeys, nativeSections, searching, visibleSections],
  )
  const reduceMotion = useReduceMotion()
  const toggleFold = useCallback(
    (key: string) => {
      configureFoldAnimation(reduceMotion)
      toggleCollapsed(key)
    },
    [reduceMotion, toggleCollapsed],
  )
  const [pendingNav, setPendingNav] = useState<string | null>(null)
  useFocusEffect(
    useCallback(() => {
      setPendingNav(null)
      return () => setPendingNav(null)
    }, []),
  )
  const openIssue = useCallback(
    (issue: IssueNavigationModel) => {
      setPendingNav(issue.id)
      router.push(`/mission/${encodeURIComponent(issue.id)}`)
      setTimeout(() => void markIssueRead(issue.id), 0)
    },
    [markIssueRead, router],
  )
  const openSession = useCallback(
    (sessionId: SessionId, rowKey: string) => {
      setPendingNav(rowKey)
      router.push(sessionHref(sessionId, '/work'))
    },
    [router],
  )
  const [menu, setMenu] = useState<PoolWorkMenuData | null>(null)
  const openMenu = useCallback(
    (issue: IssueNavigationModel, lane: WorkIssueMenuTarget['lane'] = 'live') => {
      if (!pool) return
      setMenu(resolvePoolWorkMenu(pool, issue.id, lane))
    },
    [pool],
  )
  const openLiveMenu = useCallback((issue: IssueNavigationModel) => openMenu(issue), [openMenu])
  const tuck = useCallback((id: string) => void setIssueTucked(id, true), [setIssueTucked])
  const renderItem = useCallback(
    ({ item }: { item: MobileWorkRef }) => (
      <PoolWorkRowSlot
        item={item}
        navPending={pendingNav === item.id}
        onOpenIssue={openIssue}
        onOpenSession={openSession}
        onLongPress={openLiveMenu}
        onTuck={tuck}
      />
    ),
    [openIssue, openLiveMenu, openSession, pendingNav, tuck],
  )
  const loading = booting || pool === null || split.pending > 0
  return (
    <Screen
      large
      monoSubtitle
      title="Work"
      subtitle={
        <>
          <Text style={attentionCount > 0 ? styles.headerAttention : undefined}>
            {attentionCount} NEED YOU
          </Text>
          {` · ${pinnedCount} PINNED · ${issueCount} TASKS`}
        </>
      }
      right={
        <>
          {usesNativeHeader ? null : (
            <HeaderButton
              label={searchOpen ? 'Close search' : 'Search work'}
              size={34}
              onPress={() => {
                setSearchOpen((open) => !open)
                if (searchOpen) setQuery('')
              }}
            >
              <Icon as={searchOpen ? X : Search} size={17} color={color.textDim} />
            </HeaderButton>
          )}
          <NewWorkButton size={34} />
          <HeaderButton label="Settings" size={34} onPress={() => router.push('/settings')}>
            <Icon as={Settings} size={17} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      {usesNativeHeader ? (
        <Stack.SearchBar
          placeholder="Search tasks"
          hideWhenScrolling
          onChangeText={(event) => setQuery(event.nativeEvent.text)}
          onCancelButtonPress={() => setQuery('')}
        />
      ) : null}
      {!usesNativeHeader && searchOpen ? (
        <View style={styles.searchBand}>
          <Icon as={Search} size={15} color={color.textFaint} />
          <TextInput
            autoFocus
            accessibilityLabel="Search work"
            value={query}
            onChangeText={setQuery}
            placeholder="Search tasks…"
            placeholderTextColor={color.textFaint}
            style={styles.searchInput}
            returnKeyType="search"
          />
        </View>
      ) : null}
      <BootstrapCrossfade resolved={!loading} placeholder={<WorkSkeleton />}>
        <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
          <SectionList<MobileWorkRef, MobileWorkSection>
            ref={listRef as never}
            sections={displaySections}
            keyExtractor={mobileListKey}
            refreshControl={refreshControl}
            contentInsetAdjustmentBehavior="automatic"
            automaticallyAdjustKeyboardInsets
            keyboardDismissMode="interactive"
            contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset + space.lg }]}
            ListHeaderComponent={
              <View style={styles.listNotices}>
                <StorageNoticeAlert />
                <RefreshOffer />
                <WorkspaceContinuityNotice />
              </View>
            }
            {...refreshAccessibilityProps}
            {...minimizeOnScroll}
            stickySectionHeadersEnabled
            renderSectionHeader={({ section }) => (
              <GroupHeader
                section={section}
                collapsed={!searching && collapsedKeys.has(section.key)}
                onToggle={() => toggleFold(section.key)}
              />
            )}
            renderItem={renderItem}
            renderSectionFooter={({ section }) => (
              <View style={styles.folds}>
                {section.snoozedIds.length > 0 ? (
                  <PoolFold
                    storageKey={`podium:sidebar:snoozed-fold:${section.key}`}
                    label="Snoozed"
                    ids={section.snoozedIds}
                    lane="snoozed"
                    onOpen={openIssue}
                    onLongPress={openMenu}
                  />
                ) : null}
                {section.closedIds.length > 0 ? (
                  <PoolFold
                    storageKey={`podium:sidebar:closed-fold:${section.key}`}
                    label="Closed"
                    ids={section.closedIds}
                    lane="closed"
                    onOpen={openIssue}
                    onLongPress={openMenu}
                  />
                ) : null}
              </View>
            )}
            ListEmptyComponent={
              loading ? null : (
                <EmptyState
                  title={query.trim() ? 'No matching work' : 'No work yet'}
                  body={
                    query.trim()
                      ? 'Try another task title, reference, or status.'
                      : 'Tasks and their agents appear here as soon as work begins.'
                  }
                />
              )
            }
          />
        </PullToRefreshBoundary>
      </BootstrapCrossfade>
      {menu ? <WorkIssueMenu {...menu} onClose={() => setMenu(null)} /> : null}
    </Screen>
  )
}

function PoolFold({
  storageKey,
  label,
  ids,
  lane,
  onOpen,
  onLongPress,
}: {
  storageKey: string
  label: string
  ids: readonly string[]
  lane: 'closed' | 'snoozed'
  onOpen: (issue: IssueNavigationModel) => void
  onLongPress: (issue: IssueNavigationModel, lane: WorkIssueMenuTarget['lane']) => void
}) {
  const [collapsed, toggle] = useCollapsed(storageKey, true)
  const reduceMotion = useReduceMotion()
  return (
    <View style={styles.fold}>
      <PressableScale
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        aria-expanded={!collapsed}
        accessibilityLabel={`${collapsed ? 'Show' : 'Hide'} ${label.toLowerCase()} · ${ids.length}`}
        onPress={() => {
          configureFoldAnimation(reduceMotion)
          toggle()
        }}
        style={({ pressed }) => [styles.foldToggle, pressed && styles.pressed]}
      >
        <Icon as={collapsed ? ChevronRight : ChevronDown} size={11} color={color.textMicro} />
        <Text style={styles.foldToggleText}>{`${label} · ${ids.length}`}</Text>
        <View style={styles.foldRule} />
      </PressableScale>
      {collapsed
        ? null
        : ids.map((id) => (
            <PoolFoldRow key={id} id={id} lane={lane} onOpen={onOpen} onLongPress={onLongPress} />
          ))}
    </View>
  )
}

const PoolFoldRow = memo(function PoolFoldRow({
  id,
  lane,
  onOpen,
  onLongPress,
}: {
  id: string
  lane: 'closed' | 'snoozed'
  onOpen: (issue: IssueNavigationModel) => void
  onLongPress: (issue: IssueNavigationModel, lane: WorkIssueMenuTarget['lane']) => void
}) {
  const read = useCallback(
    (pool: MobxPool) => {
      const value = pool.mobileWork.row({ id, kind: 'issue' })
      if (!value || typeof value === 'symbol' || !value.sidebar) return null
      const issue = value.sidebar.issue as unknown as IssueNavigationModel
      return {
        title: value.label,
        ref: issueDisplayRef(issue),
        marker: foldedMarker(issue, lane, mobilePaintNow(pool)),
      }
    },
    [id, lane],
  )
  const value = useMobilePoolProjection(read, null)
  if (!value) return <View accessibilityLabel="Loading work" />
  const issue = { id } as IssueNavigationModel
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${value.ref} ${value.title}`}
      onPress={() => onOpen(issue)}
      onLongPress={() => onLongPress(issue, lane)}
      delayLongPress={350}
      style={({ pressed }) => [styles.foldedRow, pressed && styles.pressed]}
    >
      <Text style={styles.foldedRef}>{value.ref}</Text>
      <NotSavedMark kind="issue" id={id} />
      <Text style={styles.foldedTitle} numberOfLines={1}>
        {value.title}
      </Text>
      <Text style={[styles.foldedMarker, value.marker === 'merged' && styles.foldedMerged]}>
        {value.marker}
      </Text>
    </PressableScale>
  )
})

/**
 * A band's sticky header — the whole bar is the fold control [POD-724].
 *
 * The count sits OUTSIDE the fold so a collapsed band still says how much is
 * in it (compression, not concealment), and the chevron is the same
 * spring-rotated disclosure the Tasks tab's StageHeader draws, snapping
 * instantly under Reduce Motion.
 */
function GroupHeader({
  section,
  collapsed,
  onToggle,
}: {
  section: Pick<MobileWorkSection, 'key' | 'label' | 'kind' | 'total'>
  collapsed: boolean
  onToggle: () => void
}) {
  const reduceMotion = useReduceMotion()
  const spin = useRef(new Animated.Value(collapsed ? 0 : 1)).current
  useEffect(() => {
    if (reduceMotion) {
      spin.setValue(collapsed ? 0 : 1)
      return
    }
    Animated.spring(spin, {
      toValue: collapsed ? 0 : 1,
      useNativeDriver: true,
      ...spring.snappy,
    }).start()
  }, [collapsed, reduceMotion, spin])
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['-90deg', '0deg'] })
  return (
    <PressableScale
      accessibilityRole="button"
      // `aria-expanded` beside `accessibilityState`: react-native-web 0.21 reads
      // only the former, so the web build announced no state at all. [POD-1664]
      accessibilityState={{ expanded: !collapsed }}
      aria-expanded={!collapsed}
      accessibilityLabel={`${section.label} · ${section.total}`}
      accessibilityHint={collapsed ? 'Show this group' : 'Fold this group away'}
      onPress={onToggle}
      scaleTo={1}
      style={({ pressed }) => [styles.groupLabel, pressed && styles.groupLabelPressed]}
    >
      {section.kind === 'attention' ? <View style={styles.attentionDot} /> : null}
      {section.kind === 'pinned' ? <Icon as={Pin} size={10} color={color.textFaint} /> : null}
      <Text
        style={[
          styles.groupLabelText,
          section.kind === 'attention' && styles.groupLabelTextAttention,
        ]}
        numberOfLines={1}
      >
        {section.label}
      </Text>
      <View style={styles.rule} />
      <Text style={styles.groupCount}>{section.total}</Text>
      <Animated.View style={[styles.groupChevron, { transform: [{ rotate }] }]}>
        <Icon as={ChevronDown} size={13} color={color.textFaint} />
      </Animated.View>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  headerAttention: {
    color: color.needsYouText,
  },
  searchBand: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: color.bar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairlineBar,
  },
  searchInput: {
    ...sans(400),
    flex: 1,
    minWidth: 0,
    color: color.text,
    fontSize: font.body,
    paddingVertical: 0,
  },
  listContent: {
    flexGrow: 1,
    backgroundColor: color.engraved,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  listNotices: {
    gap: space.sm,
    paddingVertical: space.sm,
  },
  // A sticky FOLD CONTROL now, not a passive label: 44pt for the thumb, opaque
  // `color.bar` so rows travel BEHIND it, and — the sticky geometry rule — no
  // external margin, because native pins a sticky header by translating it to
  // the viewport top and any margin stays behind as a see-through gap.
  groupLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: space.lg,
    backgroundColor: color.bar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineBar,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
    overflow: 'hidden',
    zIndex: 1,
  },
  groupLabelPressed: {
    backgroundColor: color.bgSunken,
  },
  groupChevron: {
    width: 18,
    alignItems: 'center',
  },
  attentionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.needsYou,
  },
  groupLabelText: {
    ...monoLabel(10),
    color: color.label,
    flexShrink: 1,
  },
  groupLabelTextAttention: {
    color: color.needsYouText,
  },
  groupCount: {
    ...mono(500),
    color: color.textMicro,
    fontSize: font.micro,
  },
  rule: {
    flex: 1,
    minWidth: 16,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  folds: {
    gap: 2,
  },
  fold: {
    minWidth: 0,
  },
  foldToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 31,
    paddingHorizontal: space.lg,
  },
  foldToggleText: {
    ...mono(500),
    color: color.textMicro,
    fontSize: font.tiny,
    letterSpacing: 0.35,
  },
  foldRule: {
    flex: 1,
    minWidth: 16,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  foldedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 34,
    paddingHorizontal: space.lg,
  },
  foldedRef: {
    ...mono(600),
    color: color.textMicro,
    fontSize: font.micro,
  },
  foldedTitle: {
    ...sans(400),
    flex: 1,
    minWidth: 0,
    color: color.textFaint,
    fontSize: font.small,
  },
  foldedMarker: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
  },
  foldedMerged: {
    color: alpha(color.info, 0.7),
  },
  pressed: {
    opacity: 0.65,
  },
})
