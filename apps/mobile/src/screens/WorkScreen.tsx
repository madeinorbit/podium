import { useSlice } from '@podium/client-core/react'
import {
  type IssueNavigationModel,
  issueDisplayTitle,
  missionProgress,
  type MissionProgress,
  rowAwaitsTuck,
  rowCanBringBack,
  rowStatusLine,
  type UnifiedIssueRow,
  type UnifiedWorkRow,
  worklistSlice,
  reuseUnifiedWorkRows,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionId } from '@podium/model'
import {
  canonicalIssueCloseReason,
  ISSUE_STATUS_LABELS,
  isIssueDeferred,
  issueReturnedFromDefer,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Stack, useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useBooting, useIssues, useSessions, useStoreActions } from '../client/hooks'
import { Icon } from '../components/Icon'
import {
  ChevronDown,
  ChevronRight,
  Pin,
  Search,
  Settings,
  X,
} from '../components/icons'
import { BootstrapCrossfade, WorkSkeleton } from '../components/LaunchPlaceholders'
import { NewWorkButton } from '../components/NewWorkButton'
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
import { sessionHref } from '../lib/session-route'
import {
  buildWorkSections,
  foldWorkSections,
  type WorkSection,
  workGroupFoldKey,
  workRowId,
  workRowListKey,
} from '../lib/work-sections'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space, spring } from '../theme/theme'
import { WorkRow, timeStamp } from './WorkListRow'

const usesNativeHeader = process.env.EXPO_OS !== 'web'

/**
 * Work — the desktop sidebar, on the phone [POD-338, POD-724].
 *
 * The rows come from the PUBLISHED worklist slice the wide sidebar reads
 * (POD-331). Mobile adds one deliberate triage projection, derived in
 * `../lib/work-sections.ts`: pinned rows first, then every ask in Needs You —
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
function foldedMarker(issue: IssueWire, lane: 'closed' | 'snoozed', now: number): string {
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

export function WorkScreen() {
  const router = useRouter()
  // Actions only — identity-stable, so this subscription never re-renders the
  // screen; the data below arrives through field-level selectors and slices.
  const { markIssueRead, setIssueTucked } = useStoreActions()
  const sessionsAll = useSessions()
  const issues = useIssues()
  const booting = useBooting()
  const { listRef, refreshControl, refreshAccessibilityProps, refreshing, onRefresh, connected } =
    useRefreshableTab('work')
  const bottomInset = useContentBottomInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()
  // THE SAME LIST THE DESKTOP SIDEBAR RENDERS, DERIVED ONCE (POD-331/POD-332):
  // one derivation per snapshot, carrying the clock it was derived against, so
  // the phone and the desk cannot disagree about whether a snooze has lapsed.
  const { pinned, groups, allWorktreePaths, now } = useSlice(worklistSlice)
  // ROW IDENTITY REUSE (POD-4421). The published slice builds fresh row
  // objects per derivation, so without this every snapshot tick hands the list
  // all-new row identities and `memo` on WorkRow can never hit. Reusing
  // unchanged rows here is the same stabilization the desktop sidebar applies
  // in its transition layer — consumer-side, so the slice itself is untouched.
  const stableAllRef = useRef<UnifiedWorkRow[]>([])
  const { stablePinned, stableGroups } = useMemo(() => {
    const nextFlat: UnifiedWorkRow[] = [
      ...pinned,
      ...groups.flatMap((g) => [...g.rows, ...g.snoozedRows, ...g.closedRows]),
    ]
    const stableFlat = reuseUnifiedWorkRows(stableAllRef.current, nextFlat)
    stableAllRef.current = stableFlat
    const byKey = new Map(stableFlat.map((r) => [workRowId(r), r]))
    const pick = <T extends UnifiedWorkRow>(r: T): T => (byKey.get(workRowId(r)) ?? r) as T
    return {
      stablePinned: pinned.map(pick),
      stableGroups: groups.map((g) => ({
        ...g,
        rows: g.rows.map(pick),
        snoozedRows: g.snoozedRows.map(pick),
        closedRows: g.closedRows.map(pick),
      })),
    }
  }, [pinned, groups])
  // Per-row issue lookup for the origin tick, built once per publish.
  const mobileIssueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const [menuTarget, setMenuTarget] = useState<WorkIssueMenuTarget | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const displayTitleFor = useCallback(
    // The slice arrays pass through UNSPREAD: `issueDisplayTitle` reads them
    // and its memoization upstream is identity-keyed, so a defensive copy here
    // would defeat the shared per-snapshot cache (POD round: cache-bust P0).
    (issue: IssueNavigationModel) => issueDisplayTitle(issue, sessionsAll, allWorktreePaths),
    [allWorktreePaths, sessionsAll],
  )

  const { sections, issueCount, pinnedCount, attentionCount } = useMemo(
    () => buildWorkSections(stablePinned, stableGroups),
    [stablePinned, stableGroups],
  )

  const searching = query.trim().length > 0
  const visibleSections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sections
    return sections
      .map((section) => {
        const data = section.data.filter((row) =>
          workRowSearchText(row, now, displayTitleFor).includes(needle),
        )
        return {
          ...section,
          data,
          // While searching, the header count is the MATCH count — a band
          // saying "12" over two visible hits reads as ten hidden ones.
          total: data.length,
          snoozedRows: section.snoozedRows.filter((row) =>
            `${issueDisplayRef(row.issue)} ${displayTitleFor(row.issue)}`
              .toLowerCase()
              .includes(needle),
          ),
          closedRows: section.closedRows.filter((row) =>
            `${issueDisplayRef(row.issue)} ${displayTitleFor(row.issue)}`
              .toLowerCase()
              .includes(needle),
          ),
        }
      })
      .filter(
        (section) =>
          section.data.length + section.snoozedRows.length + section.closedRows.length > 0,
      )
  }, [displayTitleFor, now, query, sections])

  /**
   * Per-band fold state, in the replicated `sidebar.section.*` family the
   * desktop's section collapses live in. Not `useCollapsed`: the band list is
   * DYNAMIC (one entry per project), and hooks cannot be called in a loop over
   * it, so the keys are read as one set and looked up per band. The flip is
   * optimistic and the ui-state write is deferred off the tap frame (see
   * `useCollapsedSet` for why that ordering is the fix); an external write
   * (the desk folding a band) still lands on the next ui-state tick.
   */
  const sectionKeys = useMemo(() => sections.map((section) => section.key), [sections])
  const { collapsed: collapsedKeys, toggle: toggleCollapsed } = useCollapsedSet(
    sectionKeys,
    workGroupFoldKey,
  )
  const reduceMotion = useReduceMotion()
  const toggleFold = useCallback(
    (key: string) => {
      configureFoldAnimation(reduceMotion)
      toggleCollapsed(key)
    },
    [reduceMotion, toggleCollapsed],
  )

  /**
   * ROW-LEVEL NAVIGATION FEEDBACK. Pushing /mission mounts a heavy first
   * frame (conversation + deck — see MissionScreen), so a tap can sit visually
   * unacknowledged past the pressed state. The tapped row shows a native
   * ActivityIndicator, but only once the open has taken noticeably long
   * (NAV_LOADER_DELAY_MS): a fast push never flashes it. The blur cleanup is
   * the "navigation committed" signal, and the focus body clears any stale
   * loader on the way back in.
   */
  const [pendingNav, setPendingNav] = useState<string | null>(null)
  useFocusEffect(
    useCallback(() => {
      setPendingNav(null)
      return () => setPendingNav(null)
    }, []),
  )

  const displaySections = useMemo(
    () => foldWorkSections(visibleSections, collapsedKeys, searching),
    [collapsedKeys, searching, visibleSections],
  )

  /**
   * A mission row opens its MISSION — the transcript of whoever is on it, with
   * the flight deck one pull away [POD-724]. The mission screen resolves the row
   * to its root itself, so tapping a child anywhere lands on the same spine the
   * desktop's second column draws.
   */
  const openIssue = useCallback(
    (issue: IssueWire) => {
      setPendingNav(issue.id)
      router.push(`/mission/${encodeURIComponent(issue.id)}`)
      // Mark-read AFTER the push is dispatched: the outbox enqueue and its
      // durable persist used to run inside the tap frame, ahead of the
      // transition's first frame. A macrotask later is invisible to the badge
      // and buys the navigation its whole frame budget.
      setTimeout(() => void markIssueRead(issue.id), 0)
    },
    [router, markIssueRead],
  )

  /** Session opens (draft vessels, worktree rows) get the same row loader —
   *  keyed by the row's canonical id so both copies of a duplicated row agree. */
  const openSessionFromRow = useCallback(
    (sessionId: SessionId, rowKey: string) => {
      setPendingNav(rowKey)
      router.push(sessionHref(sessionId, '/work'))
    },
    [router],
  )
  const openRowMenu = useCallback(
    (issue: IssueNavigationModel) => setMenuTarget({ issue, lane: 'live' }),
    [],
  )
  const tuckIssue = useCallback(
    (issueId: string) => void setIssueTucked(issueId, true),
    [setIssueTucked],
  )
  // Stable per-id tuck thunks (POD-4421): `onTuck={() => tuck(id)}` would mint
  // a fresh closure per row per render and defeat the memo below.
  const tuckIssueStable = useRef(tuckIssue)
  tuckIssueStable.current = tuckIssue
  const tuckCacheRef = useRef(new Map<string, () => void>())
  const tuckFor = useCallback((issueId: string): (() => void) => {
    let fn = tuckCacheRef.current.get(issueId)
    if (!fn) {
      fn = () => tuckIssueStable.current(issueId)
      tuckCacheRef.current.set(issueId, fn)
    }
    return fn
  }, [])
  // NARROW PER-ROW DATA, COMPUTED ONCE PER LIST (POD-4421). Each row used to
  // receive the whole `issues`/`sessions`/`allWorktreePaths` arrays plus `now`
  // and then run its own `issues.find`, `issueDisplayTitle` and
  // `missionProgress` fallback — and the memo above it compared those arrays
  // by identity, so a snapshot tick repainted everything. The maps below run
  // once per publish; each row receives scalars with stable references.
  const narrowById = useMemo(() => {
    const label = new Map<string, string>()
    const progress = new Map<string, MissionProgress | null>()
    const originSeq = new Map<string, number | null>()
    const status = new Map<string, string>()
    const stamp = new Map<string, string | null>()
    const tuckable = new Map<string, boolean>()
    const snoozed = new Map<string, boolean>()
    const unsnoozed = new Map<string, boolean>()
    const all: UnifiedWorkRow[] = [
      ...stablePinned,
      ...stableGroups.flatMap((g) => [...g.rows, ...g.snoozedRows, ...g.closedRows]),
    ]
    for (const r of all) {
      const id = workRowId(r)
      if (r.kind === 'issue') {
        label.set(id, issueDisplayTitle(r.issue, sessionsAll, allWorktreePaths))
        progress.set(id, r.missionRollup?.progress ?? missionProgress(issues, sessionsAll, r.issue.id))
        const dep = r.issue.deps.find((d) => d.type === 'discovered-from')
        originSeq.set(id, dep ? (mobileIssueById.get(dep.id)?.seq ?? null) : null)
      } else {
        label.set(
          id,
          `${r.worktree.repoName ?? ''}${r.worktree.branch ? ` · ${r.worktree.branch}` : ''}`,
        )
        progress.set(id, null)
        originSeq.set(id, null)
      }
      status.set(id, rowStatusLine(r, now, 0))
      stamp.set(id, timeStamp(r, now))
      tuckable.set(id, r.kind === 'issue' ? rowAwaitsTuck(r, null, false, now) : false)
      snoozed.set(id, r.kind === 'issue' ? isIssueDeferred(r.issue, now) : false)
      unsnoozed.set(id, r.kind === 'issue' ? issueReturnedFromDefer(r.issue, now) : false)
    }
    return { label, progress, originSeq, status, stamp, tuckable, snoozed, unsnoozed }
  }, [
    stablePinned,
    stableGroups,
    sessionsAll,
    allWorktreePaths,
    issues,
    mobileIssueById,
    now,
  ])
  // Prune tuck thunks for rows that left the list.
  {
    const live = new Set<string>([
      ...stablePinned.map(workRowId),
      ...stableGroups.flatMap((g) =>
        [...g.rows, ...g.snoozedRows, ...g.closedRows].map(workRowId),
      ),
    ])
    for (const key of tuckCacheRef.current.keys()) {
      if (!live.has(key)) tuckCacheRef.current.delete(key)
    }
  }

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
      {/* Crossfade OUTSIDE the refresh boundary: while the replica is still
          resolving there is nothing to pull-to-refresh, so the skeleton should
          cover the refresh affordance too rather than invite a gesture that
          would race the bootstrap. */}
      <BootstrapCrossfade resolved={!booting} placeholder={<WorkSkeleton />}>
        <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
          <SectionList
            ref={listRef as never}
            sections={displaySections}
            // The list flattens its sections, so keys must stay unique even
            // when a pinned ask renders in both Pinned and Needs you.
            keyExtractor={workRowListKey}
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
            // STICKY, and the header style must stay margin-free for it: native
            // pins a sticky child by translating it to the viewport top, and an
            // external margin stays in the layout — rows scroll through the gap
            // above the pinned bar. The header is opaque `color.bar` for the
            // same reason (see IssuesScreen's StageHeader note).
            stickySectionHeadersEnabled
            renderSectionHeader={({ section }) => (
              <GroupHeader
                section={section}
                collapsed={!searching && collapsedKeys.has(section.key)}
                onToggle={() => toggleFold(section.key)}
              />
            )}
            renderItem={({ item }) => {
              const id = workRowId(item)
              const isIssue = item.kind === 'issue'
              return (
                <WorkRow
                  row={item}
                  label={narrowById.label.get(id) ?? ''}
                  progress={narrowById.progress.get(id) ?? null}
                  originSeq={narrowById.originSeq.get(id) ?? null}
                  statusLine={narrowById.status.get(id) ?? ''}
                  stamp={narrowById.stamp.get(id) ?? null}
                  snoozed={narrowById.snoozed.get(id) ?? false}
                  unsnoozed={narrowById.unsnoozed.get(id) ?? false}
                  onTuck={isIssue && narrowById.tuckable.get(id) ? tuckFor(id) : undefined}
                  navPending={pendingNav !== null && pendingNav === id}
                  onOpenIssue={openIssue}
                  onOpenSession={openSessionFromRow}
                  onLongPress={openRowMenu}
                />
              )
            }}
            renderSectionFooter={({ section }) => (
              <View style={styles.folds}>
                {section.snoozedRows.length > 0 ? (
                  <Fold
                    storageKey={`podium:sidebar:snoozed-fold:${section.key}`}
                    label="Snoozed"
                    rows={section.snoozedRows}
                    displayTitleFor={displayTitleFor}
                    lane="snoozed"
                    now={now}
                    onOpen={openIssue}
                    onLongPress={(row) => setMenuTarget({ issue: row.issue, lane: 'snoozed' })}
                  />
                ) : null}
                {section.closedRows.length > 0 ? (
                  <Fold
                    storageKey={`podium:sidebar:closed-fold:${section.key}`}
                    label="Closed"
                    rows={section.closedRows}
                    displayTitleFor={displayTitleFor}
                    lane="closed"
                    now={now}
                    onOpen={openIssue}
                    onLongPress={(row) =>
                      setMenuTarget({
                        issue: row.issue,
                        lane: 'closed',
                        canBringBack: rowCanBringBack(row, now),
                      })
                    }
                  />
                ) : null}
              </View>
            )}
            ListEmptyComponent={
              // Guarded on `booting` even though the crossfade covers this
              // screen: ListEmptyComponent is rendered by the list whenever its
              // data is empty, with no notion of whether loading has finished, so
              // without this the empty state is CONSTRUCTED during bootstrap and
              // sits in the tree — and in the accessibility tree — underneath an
              // opaque placeholder. The crossfade stops it being SEEN; this stops
              // it being built. Related conditions, not the same one.
              booting ? null : (
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
      {menuTarget ? (
        <WorkIssueMenu
          target={menuTarget}
          issues={issues}
          sessions={sessionsAll}
          onClose={() => setMenuTarget(null)}
        />
      ) : null}
    </Screen>
  )
}

function workRowSearchText(
  row: UnifiedWorkRow,
  now: number,
  displayTitleFor: (issue: IssueNavigationModel) => string,
): string {
  if (row.kind === 'issue') {
    return `${issueDisplayRef(row.issue)} ${displayTitleFor(row.issue)} ${rowStatusLine(row, now, 0)}`.toLowerCase()
  }
  return `${row.worktree.repoName ?? ''} ${row.worktree.branch ?? ''} ${rowStatusLine(row, now, 0)}`.toLowerCase()
}

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
  section: WorkSection
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

/** A project-local disclosure (Snoozed / Closed): the collapsed default and the
 *  one-line folded rows of the desktop fold, at thumb size. */
function Fold({
  storageKey,
  label,
  rows,
  displayTitleFor,
  lane,
  now,
  onOpen,
  onLongPress,
}: {
  storageKey: string
  label: string
  rows: UnifiedIssueRow[]
  displayTitleFor: (issue: IssueNavigationModel) => string
  lane: 'closed' | 'snoozed'
  now: number
  onOpen: (issue: IssueWire) => void
  onLongPress: (row: UnifiedIssueRow) => void
}) {
  const [collapsed, toggle] = useCollapsed(storageKey, true)
  const reduceMotion = useReduceMotion()
  return (
    <View style={styles.fold}>
      <PressableScale
        accessibilityRole="button"
        // `aria-expanded` beside `accessibilityState`: react-native-web 0.21 reads
        // only the former, so the web build announced no state at all. [POD-1664]
        accessibilityState={{ expanded: !collapsed }}
        aria-expanded={!collapsed}
        accessibilityLabel={`${collapsed ? 'Show' : 'Hide'} ${label.toLowerCase()} · ${rows.length}`}
        onPress={() => {
          configureFoldAnimation(reduceMotion)
          toggle()
        }}
        style={({ pressed }) => [styles.foldToggle, pressed && styles.pressed]}
      >
        <Icon as={collapsed ? ChevronRight : ChevronDown} size={11} color={color.textMicro} />
        <Text style={styles.foldToggleText}>{`${label} · ${rows.length}`}</Text>
        <View style={styles.foldRule} />
      </PressableScale>
      {collapsed
        ? null
        : rows.map((row) => {
            const title = displayTitleFor(row.issue)
            return (
              <PressableScale
                key={row.issue.id}
                accessibilityRole="button"
                accessibilityLabel={`${issueDisplayRef(row.issue)} ${title}`}
                onPress={() => onOpen(row.issue)}
                onLongPress={() => onLongPress(row)}
                delayLongPress={350}
                style={({ pressed }) => [styles.foldedRow, pressed && styles.pressed]}
              >
                <Text style={styles.foldedRef}>{issueDisplayRef(row.issue)}</Text>
                <Text style={styles.foldedTitle} numberOfLines={1}>
                  {title}
                </Text>
                <Text
                  style={[
                    styles.foldedMarker,
                    foldedMarker(row.issue, lane, now) === 'merged' && styles.foldedMerged,
                  ]}
                >
                  {foldedMarker(row.issue, lane, now)}
                </Text>
              </PressableScale>
            )
          })}
    </View>
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
