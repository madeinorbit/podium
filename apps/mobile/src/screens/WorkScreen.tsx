import { relativeTime } from '@podium/client-core/focus'
import { useSlice } from '@podium/client-core/react'
import {
  formatClock,
  type IssueNavigationModel,
  isDraftAgentVessel,
  issueDisplayTitle,
  missionProgress,
  pendingDecisionLabel,
  rowAwaitsTuck,
  rowCanBringBack,
  rowHasWorkingSession,
  rowMotionPhase,
  rowMotionTiming,
  rowPendingDecision,
  rowStatusLine,
  rowUnreadEmphasized,
  rowWaitingCount,
  type UnifiedIssueRow,
  type UnifiedWorkRow,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import {
  canonicalIssueCloseReason,
  ISSUE_STATUS_LABELS,
  isIssueDeferred,
  issueReturnedFromDefer,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Stack, useFocusEffect, useRouter } from 'expo-router'
import {
  AlarmClock,
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  Pin,
  Search,
  X,
} from '../components/icons'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
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
import { BootstrapCrossfade, WorkSkeleton } from '../components/LaunchPlaceholders'
import { NewWorkButton } from '../components/NewWorkButton'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { HeaderButton, Screen } from '../components/Screen'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { EmptyState } from '../components/ui'
import { WorkIssueMenu, type WorkIssueMenuTarget } from '../components/WorkIssueMenu'
import { WorkingMark } from '../components/WorkingMark'
import { FleetSummary, GitStampLine, RowProgressMeter } from '../components/WorkRowParts'
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
import { flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space, spring } from '../theme/theme'

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

/** Standard delay-before-show for the row's open loader: below this an open
 *  reads as instant and a spinner would only be a flash. */
const NAV_LOADER_DELAY_MS = 150

/** True once `active` has held for `delayMs`; false the moment it drops. */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!active) {
      setOn(false)
      return
    }
    const timer = setTimeout(() => setOn(true), delayMs)
    return () => clearTimeout(timer)
  }, [active, delayMs])
  return on
}

/** Line 2's timer stamp — the desktop PhaseTimer's exact vocabulary: a running
 *  `m:ss` clock while working, a frozen "10h ago" while waiting, the `∑` compute
 *  total once done, and NOTHING while queued (the dimmed row already says it). */
function timeStamp(row: UnifiedWorkRow, now: number): string | null {
  const timing = rowMotionTiming(row)
  if (timing.phase === 'done') {
    return timing.totalMs !== undefined ? `∑ ${formatClock(timing.totalMs)}` : null
  }
  if (!Number.isFinite(timing.sinceMs) || timing.sinceMs <= 0) return null
  if (timing.phase === 'working') {
    return formatClock(Math.max(0, now - timing.sinceMs) + (timing.baseMs ?? 0))
  }
  if (timing.phase === 'waiting') return relativeTime(new Date(timing.sinceMs).toISOString(), now)
  return null
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
    () => buildWorkSections(pinned, groups),
    [pinned, groups],
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
            contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset + space.lg }]}
            contentInsetAdjustmentBehavior="automatic"
            automaticallyAdjustKeyboardInsets
            keyboardDismissMode="interactive"
            contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset + space.lg }]}
            ListHeaderComponent={<StorageNoticeAlert />}
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
            renderItem={({ item }) => (
              <WorkRow
                row={item}
                issues={issues}
                sessions={sessionsAll}
                allWorktreePaths={allWorktreePaths}
                now={now}
                navPending={pendingNav !== null && pendingNav === workRowId(item)}
                onOpenIssue={openIssue}
                onOpenSession={openSessionFromRow}
                onLongPress={openRowMenu}
                onTuckIssue={tuckIssue}
              />
            )}
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

/**
 * MEMOIZED, and the callbacks above are stable for exactly this reason: a fold
 * toggle, a search keystroke or a row loader used to re-render every row in the
 * list, which is most of why folding read as sluggish on a full board. With
 * `memo`, local screen state touches only the rows whose props actually moved;
 * a snapshot tick still repaints everything (its arrays and `now` are new).
 */
const WorkRow = memo(function WorkRow({
  row,
  issues,
  sessions: allSessions,
  allWorktreePaths,
  now,
  navPending,
  onOpenIssue,
  onOpenSession,
  onLongPress,
  onTuckIssue,
}: {
  row: UnifiedWorkRow
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  allWorktreePaths: string[]
  now: number
  /** This row's open is in flight — show the delayed native loader. */
  navPending: boolean
  onOpenIssue: (issue: IssueWire) => void
  onOpenSession: (sessionId: SessionId, rowKey: string) => void
  onLongPress: (issue: IssueNavigationModel) => void
  onTuckIssue: (issueId: string) => void
}) {
  const issue = row.kind === 'issue' ? row.issue : undefined
  const worktree = row.kind === 'worktree' ? row.worktree : undefined
  const sessions = row.kind === 'issue' ? row.sessions : row.worktree.sessions
  // The row speaks for its whole branch: descendants have no row of their own
  // here, so the fleet stack reads the bubbled aggregate.
  const fleetSessions = row.kind === 'issue' ? (row.aggregateSessions ?? sessions) : sessions
  const hex = issue ? issueColorHex(issue.color) : undefined
  const rowBg = hex ? flow.rowBg(hex) : color.engraved
  const phase = rowMotionPhase(row)
  // An ask outranks work in the phase, so the phase alone cannot answer "is an
  // agent computing" — and on a one-row-per-mission list that left a running
  // fleet reading as stopped (POD-703). Every working texture gates on this.
  const working = rowHasWorkingSession(row)
  const waiting = rowWaitingCount(row)
  // The ask treatment follows the ROW, not the band it landed in: a waiting
  // row stays put when pinned (see ../lib/work-sections.ts), so the tint, the
  // count and the Answer/Review action must travel with the fact itself.
  const attention = waiting > 0
  const decision = row.kind === 'issue' ? rowPendingDecision(row) : null
  const rowUnread = rowUnreadEmphasized(row)
  // The row's own progress, at the scope it speaks for: its whole mission. The
  // deck's derivation, imported rather than restated — the two must never
  // disagree about how far a mission is.
  // UNSPREAD ON PURPOSE: `missionProgress` memoizes in a WeakMap keyed on the
  // ARRAY IDENTITIES of the slices, so passing the stable store arrays directly
  // is what lets every visible row share one compute per snapshot. A defensive
  // `[...]` copy here minted fresh identities per row per render and turned the
  // memo into a guaranteed miss (O(board) per row).
  const progress = useMemo(
    () => (issue ? missionProgress(issues, allSessions, issue.id) : null),
    [allSessions, issue, issues],
  )
  // A draft vessel's only content is its agents — its row IS the agent, so it
  // clicks straight into the session (desktop POD-282).
  const draftOnly = issue ? isDraftAgentVessel(issue, sessions) : false
  // A freshly minted draft is not news to the person who just minted it: no
  // unread dot or bold until its agent actually reports runtime state — the
  // same gate the chats list applies (SessionCard's hidesDraftDot, round 2).
  const draftQuiet =
    draftOnly && !sessions[0]?.busy && (sessions[0]?.agentState?.phase ?? 'unknown') === 'unknown'
  const unread = rowUnread && !draftQuiet
  const label = issue
    ? issueDisplayTitle(issue, allSessions, allWorktreePaths)
    : `${worktree?.repoName ?? ''}${worktree?.branch ? ` · ${worktree.branch}` : ''}`
  const stamp = timeStamp(row, now)
  const statusLine =
    issue && decision ? pendingDecisionLabel(issue, decision) : rowStatusLine(row, now, 0)
  // Spin-off provenance (POD-85): an outgoing discovered-from edge names the
  // issue this one was spun off from — one quiet ⤷ tick on line 2.
  const originDep = issue?.deps.find((d) => d.type === 'discovered-from')
  const origin = originDep ? issues.find((i) => i.id === originDep.id) : undefined
  const snoozed = issue ? isIssueDeferred(issue, now) : false
  const unsnoozed = issue ? issueReturnedFromDefer(issue, now) : false
  // Computed here rather than passed as a closure so the memo above can work:
  // an inline `onTuck` arrow from renderItem would be new every list render.
  const onTuck =
    issue && rowAwaitsTuck(row, null, false, now) ? () => onTuckIssue(issue.id) : undefined
  // Native, theme-tinted, and DELAYED: feedback only when the open is actually
  // taking a beat, so a fast push never flashes a spinner (standard ~150ms).
  const navLoader = useDelayedFlag(navPending, NAV_LOADER_DELAY_MS)

  const press = () => {
    if (issue) {
      if (draftOnly && sessions[0]) onOpenSession(sessions[0].sessionId, workRowId(row))
      else onOpenIssue(issue)
      return
    }
    if (sessions[0]) onOpenSession(sessions[0].sessionId, workRowId(row))
  }

  return (
    <View
      style={[
        styles.row,
        attention ? styles.rowAttention : hex ? { backgroundColor: rowBg } : null,
        phase === 'queued' && styles.rowQueued,
        phase === 'done' && !onTuck && styles.rowDone,
        issue?.audience === 'agent' && styles.rowInternal,
      ]}
    >
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={issue ? `${issueDisplayRef(issue)} ${label}` : `Worktree ${label}`}
        onPress={press}
        onLongPress={issue ? () => onLongPress(issue) : undefined}
        delayLongPress={350}
        scaleTo={0.99}
        style={({ pressed }) => [
          styles.rowMain,
          attention && styles.rowMainAttention,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.rowText}>
          <View style={styles.rowTitleLine}>
            <Text
              style={[
                styles.rowTitle,
                unread && styles.rowTitleUnread,
                hex ? { color: flow.text(hex) } : null,
              ]}
              numberOfLines={1}
            >
              {label}
            </Text>
            {unread ? <View style={styles.unreadDot} /> : null}
            {issue?.audience === 'agent' ? <Text style={styles.internal}>internal</Text> : null}
            {snoozed ? <Icon as={AlarmClock} size={10} color={color.textMicro} /> : null}
            {unsnoozed ? <Text style={styles.unsnoozed}>Unsnoozed</Text> : null}
          </View>
          <View style={styles.rowStatusLine}>
            {issue ? <Text style={styles.rowRef}>{issueDisplayRef(issue)}</Text> : null}
            {attention ? <Text style={styles.rowWaitCount}>{waiting}</Text> : null}
            {issue?.pinned ? <Icon as={Pin} size={9} color={color.textMicro} /> : null}
            {draftOnly ? null : <FleetSummary sessions={fleetSessions} />}
            <Text
              style={[
                styles.status,
                decision ? styles.statusDecision : null,
                !decision && phase === 'working' ? styles.statusWorking : null,
                !decision && phase === 'done' ? styles.statusDone : null,
              ]}
              numberOfLines={1}
            >
              {statusLine}
            </Text>
            {origin ? <Text style={styles.origin}>{`⤷ ${origin.seq}`}</Text> : null}
            {issue ? (
              <GitStampLine
                branch={issue.branch}
                git={issue.gitState}
                suppressAhead={decision === 'merge'}
              />
            ) : null}
            <View style={styles.spacer} />
            <View style={styles.rowDatum}>
              {navLoader ? (
                <ActivityIndicator
                  accessibilityLabel="Opening"
                  size="small"
                  color={color.textDim}
                />
              ) : (
                <>
                  {working ? <WorkingMark size={11} /> : null}
                  {stamp ? (
                    <Text style={styles.stamp} numberOfLines={1}>
                      {stamp}
                    </Text>
                  ) : null}
                </>
              )}
            </View>
          </View>
          {progress ? <RowProgressMeter progress={progress} working={working} /> : null}
        </View>
      </PressableScale>
      {attention && issue ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${decision ? 'Review' : 'Answer'} ${issueDisplayRef(issue)}`}
          onPress={press}
          style={({ pressed }) => [
            styles.attentionAction,
            decision ? styles.reviewAction : styles.answerAction,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.actionText, decision && styles.reviewActionText]}>
            {decision ? 'Review' : 'Answer'}
          </Text>
        </PressableScale>
      ) : null}
      {onTuck ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Tuck ${label} into Closed`}
          onPress={onTuck}
          style={({ pressed }) => [styles.tuck, pressed && styles.pressed]}
        >
          <Icon as={ArrowDownToLine} size={11} color={color.textMicro} />
          <Text style={styles.tuckText}>Tuck</Text>
        </PressableScale>
      ) : null}
    </View>
  )
})

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
  // TINT, NOT OUTLINE. The issue colour arrives as a row BACKGROUND — the same
  // `flow.rowBg` recipe the desktop row uses — and nothing draws a coloured
  // border around it: four outlined rows in four different hues read as a stack
  // of cards, which is precisely what a worklist must not look like. The 3pt gap
  // is the separator.
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 62,
    backgroundColor: color.engraved,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
    overflow: 'hidden',
  },
  rowAttention: {
    minHeight: 68,
    backgroundColor: alpha(color.needsYou, 0.05),
    // The stock hairline DISAPPEARS on this tint: #24272d composites to about
    // 1.06:1 against the bisque-washed ground (vs 1.16:1 on plain engraved).
    // Deriving the seam from the tint itself — 16% bisque — lands it at about
    // 1.4:1 on that ground, clearly above the plain list's own separator.
    borderBottomColor: alpha(color.needsYou, 0.16),
  },
  rowQueued: {
    opacity: 0.72,
  },
  rowDone: {
    opacity: 0.75,
  },
  rowInternal: {
    opacity: 0.8,
  },
  rowMain: {
    flex: 1,
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingLeft: space.lg,
    paddingRight: space.md,
    paddingVertical: 9,
  },
  rowMainAttention: {
    minHeight: 68,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowTitle: {
    ...sans(600),
    flexShrink: 1,
    color: color.body,
    fontSize: 15,
  },
  rowTitleUnread: {
    ...sans(600),
    color: color.text,
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.info,
    flexShrink: 0,
  },
  internal: {
    ...monoLabel(9),
    color: color.textMicro,
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: radius.xs,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.textMicro, 0.5),
  },
  unsnoozed: {
    ...monoLabel(9),
    color: color.accentTint,
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: radius.xs,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentBorder,
  },
  rowStatusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  rowDatum: {
    width: 58,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  rowRef: {
    ...mono(600),
    flexShrink: 0,
    color: color.textMicro,
    fontSize: font.micro,
  },
  rowWaitCount: {
    ...mono(600),
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
    borderRadius: radius.full,
    backgroundColor: color.needsYou,
    color: color.onAccent,
    fontSize: font.micro,
    textAlign: 'center',
  },
  spacer: {
    flex: 1,
    minWidth: 4,
  },
  status: {
    ...mono(500),
    flexShrink: 1,
    color: color.textFaint,
    fontSize: font.tiny,
  },
  statusDecision: {
    ...mono(600),
    color: color.needsYouText,
  },
  statusWorking: {
    color: color.workingText,
  },
  statusDone: {
    color: color.textMicro,
  },
  origin: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
  },
  // The clock never wraps: `12m ago` breaking onto a second line pushed the
  // meter down and made two adjacent rows different heights.
  stamp: {
    ...mono(400),
    flexShrink: 0,
    color: color.textMicro,
    fontSize: font.micro,
  },
  attentionAction: {
    alignSelf: 'center',
    minWidth: 58,
    height: 34,
    marginRight: space.lg,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  answerAction: {
    backgroundColor: color.needsYou,
  },
  reviewAction: {
    backgroundColor: color.surfaceHigh,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
  },
  actionText: {
    ...sans(700),
    color: color.onAccent,
    fontSize: font.tiny,
  },
  reviewActionText: {
    color: color.body,
  },
  // A chip, not a slab (desktop POD-293): the control is a quiet right-edge
  // action on a finished row, so it must not out-weigh the row it dismisses.
  tuck: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 4,
    height: 26,
    marginRight: 6,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceHigh,
  },
  tuckText: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    letterSpacing: 0.2,
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
