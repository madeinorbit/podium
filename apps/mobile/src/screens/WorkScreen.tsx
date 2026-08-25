import { relativeTime } from '@podium/client-core/focus'
import { useSlice } from '@podium/client-core/react'
import {
  draftIssueLabel,
  formatClock,
  type IssueNavigationModel,
  isDraftAgentVessel,
  missionProgress,
  pendingDecisionLabel,
  planReorderKeys,
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
import { useRouter } from 'expo-router'
import {
  AlarmClock,
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  Pin,
  Search,
  X,
} from 'lucide-react-native'
import { useCallback, useMemo, useState } from 'react'
import { SectionList, StyleSheet, Text, TextInput, View } from 'react-native'
import { useBooting, useIssues, useMobileStore, useSessions } from '../client/hooks'
import { Icon } from '../components/Icon'
import { BootstrapCrossfade, WorkSkeleton } from '../components/LaunchPlaceholders'
import { NewWorkButton } from '../components/NewWorkButton'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { HeaderButton, Screen } from '../components/Screen'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { TaskSheet } from '../components/TaskSheet'
import { EmptyState } from '../components/ui'
import { WorkIssueMenu, type WorkIssueMenuTarget } from '../components/WorkIssueMenu'
import { WorkingMark } from '../components/WorkingMark'
import { FleetSummary, GitStampLine, RowProgressMeter } from '../components/WorkRowParts'
import { useCollapsed } from '../hooks/useCollapsed'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { useTabBarInset } from '../hooks/useTabBarInset'
import { sessionHref } from '../lib/session-route'
import { flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

/**
 * Work — the desktop sidebar, on the phone [POD-338, POD-724].
 *
 * The rows come from the PUBLISHED worklist slice the wide sidebar reads
 * (POD-331). Mobile adds one deliberate triage projection: asking rows lift
 * into Needs You, then pinned rows, then their project bands. Source order is
 * preserved inside each band, and reordering still writes in the original
 * project/pinned scope; tuck-away and the Snoozed / Closed folds stay shared.
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

interface WorkSection {
  key: string
  label: string
  kind: 'attention' | 'pinned' | 'project'
  data: UnifiedWorkRow[]
  snoozedRows: UnifiedIssueRow[]
  closedRows: UnifiedIssueRow[]
}

export function WorkScreen() {
  const router = useRouter()
  const store = useMobileStore()
  const sessionsAll = useSessions()
  const issues = useIssues()
  const booting = useBooting()
  const { listRef, refreshControl, refreshAccessibilityProps, refreshing, onRefresh, connected } =
    useRefreshableTab('work')
  const tabBarInset = useTabBarInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()
  // THE SAME LIST THE DESKTOP SIDEBAR RENDERS, DERIVED ONCE (POD-331/POD-332):
  // one derivation per snapshot, carrying the clock it was derived against, so
  // the phone and the desk cannot disagree about whether a snooze has lapsed.
  const { pinned, groups, allWorktreePaths, now } = useSlice(worklistSlice)
  const [peek, setPeek] = useState<IssueWire | null>(null)
  const [menuTarget, setMenuTarget] = useState<WorkIssueMenuTarget | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  const { sections, orderingSections, issueCount, pinnedCount, attentionCount } = useMemo(() => {
    const list: WorkSection[] = []
    const ordering: WorkSection[] = []
    const attentionRows = [...pinned, ...groups.flatMap((group) => group.rows)].filter(
      (row) => rowWaitingCount(row) > 0,
    )
    if (attentionRows.length > 0) {
      list.push({
        key: 'needs-you',
        label: 'Needs you',
        kind: 'attention',
        data: attentionRows,
        snoozedRows: [],
        closedRows: [],
      })
    }
    if (pinned.length > 0) {
      const section: WorkSection = {
        key: 'pinned',
        label: 'Pinned',
        kind: 'pinned',
        data: pinned.filter((row) => rowWaitingCount(row) === 0),
        snoozedRows: [],
        closedRows: [],
      }
      ordering.push({ ...section, data: pinned })
      if (section.data.length > 0) list.push(section)
    }
    for (const group of groups) {
      if (group.rows.length + group.snoozedRows.length + group.closedRows.length === 0) continue
      const section: WorkSection = {
        key: group.key,
        label: group.label,
        kind: 'project',
        data: group.rows.filter((row) => rowWaitingCount(row) === 0),
        snoozedRows: group.snoozedRows,
        closedRows: group.closedRows,
      }
      ordering.push({ ...section, data: group.rows })
      if (section.data.length + section.snoozedRows.length + section.closedRows.length > 0) {
        list.push(section)
      }
    }
    const open = [...pinned, ...groups.flatMap((g) => g.rows)]
    return {
      sections: list,
      orderingSections: ordering,
      issueCount: open.filter((row) => row.kind === 'issue').length,
      pinnedCount: pinned.length,
      attentionCount: attentionRows.length,
    }
  }, [pinned, groups])

  const visibleSections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sections
    return sections
      .map((section) => ({
        ...section,
        data: section.data.filter((row) => workRowSearchText(row, now).includes(needle)),
        snoozedRows: section.snoozedRows.filter((row) =>
          `${issueDisplayRef(row.issue)} ${row.issue.title}`.toLowerCase().includes(needle),
        ),
        closedRows: section.closedRows.filter((row) =>
          `${issueDisplayRef(row.issue)} ${row.issue.title}`.toLowerCase().includes(needle),
        ),
      }))
      .filter(
        (section) =>
          section.data.length + section.snoozedRows.length + section.closedRows.length > 0,
      )
  }, [now, query, sections])

  /**
   * A mission row opens its MISSION — the transcript of whoever is on it, with
   * the flight deck one pull away [POD-724]. The mission screen resolves the row
   * to its root itself, so tapping a child anywhere lands on the same spine the
   * desktop's second column draws.
   */
  const openIssue = useCallback(
    (issue: IssueWire) => {
      void store.markIssueRead(issue.id)
      router.push(`/mission/${encodeURIComponent(issue.id)}`)
    },
    [store.markIssueRead, router],
  )

  /** Desktop's context-menu Open goes to the task page. The row tap still opens
   * the mission transcript; keeping those as separate verbs is why Peek remains
   * useful on a phone rather than turning Open into a second name for the tap. */
  const openIssuePage = useCallback(
    (issue: IssueWire) => {
      void store.markIssueRead(issue.id)
      router.push(`/issue/${encodeURIComponent(issue.id)}`)
    },
    [router, store.markIssueRead],
  )

  /**
   * Manual order, from the phone, in the SHARED key space [POD-168].
   *
   * The desktop moves a row by dragging its grip; a thumb on a 44pt row cannot
   * borrow that gesture without stealing the scroll, so the phone spends the
   * long-press menu on it instead. What it writes is identical — fractional
   * `sortKey` patches planned by `planReorderKeys`, the same function the drag
   * uses — so an issue lifted to the top here is at the top of the desk's
   * sidebar before the sheet has finished closing, and vice versa. The scope is
   * the row's own section, which is the only place a key means anything.
   */
  const move = useCallback(
    (issue: IssueWire, to: 'top' | 'up' | 'down') => {
      const section = orderingSections.find((s) => s.data.some((r) => rowIssueId(r) === issue.id))
      if (!section) return
      const order = section.data.map(rowIssueId).filter((id): id is string => id !== null)
      const from = order.indexOf(issue.id)
      if (from < 0) return
      const target = to === 'top' ? 0 : to === 'up' ? from - 1 : from + 1
      if (target < 0 || target >= order.length) return
      const next = [...order]
      next.splice(from, 1)
      next.splice(target, 0, issue.id)
      const keyOf = (id: string) => issues.find((candidate) => candidate.id === id)?.sortKey
      for (const patch of planReorderKeys(next, issue.id, keyOf)) {
        void store.trpc.issues.update
          .mutate({ id: patch.id, patch: { sortKey: patch.sortKey } })
          .catch(() => {})
      }
    },
    [issues, orderingSections, store.trpc],
  )

  const menuMoves = useMemo(() => {
    if (menuTarget?.lane !== 'live') return { top: false, up: false, down: false }
    const section = orderingSections.find((candidate) =>
      candidate.data.some((row) => rowIssueId(row) === menuTarget.issue.id),
    )
    const index = section?.data.findIndex((row) => rowIssueId(row) === menuTarget.issue.id) ?? -1
    const length = section?.data.length ?? 0
    return { top: index > 0, up: index > 0, down: index >= 0 && index < length - 1 }
  }, [menuTarget, orderingSections])

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
          <NewWorkButton size={34} />
        </>
      }
    >
      {/* Never silent (ADR 6 D4.4): storage degradation is owed to the user, not
          a log line. Outside the crossfade so the skeleton cannot hide it. */}
      <StorageNoticeAlert />
      {searchOpen ? (
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
            sections={visibleSections}
            keyExtractor={(row) => (row.kind === 'issue' ? row.issue.id : row.worktree.path)}
            refreshControl={refreshControl}
            contentContainerStyle={[styles.listContent, { paddingBottom: tabBarInset + space.lg }]}
            {...refreshAccessibilityProps}
            {...minimizeOnScroll}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) => (
              <View
                style={[
                  styles.groupLabel,
                  section.kind === 'attention' && styles.groupLabelAttention,
                ]}
              >
                {section.kind === 'attention' ? <View style={styles.attentionDot} /> : null}
                {section.kind === 'pinned' ? (
                  <Icon as={Pin} size={10} color={color.textFaint} />
                ) : null}
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
                <Text style={styles.groupCount}>{section.data.length}</Text>
              </View>
            )}
            renderItem={({ item, section }) => (
              <WorkRow
                row={item}
                attention={section.kind === 'attention'}
                issues={issues}
                sessions={sessionsAll}
                allWorktreePaths={allWorktreePaths}
                now={now}
                onOpenIssue={openIssue}
                onOpenSession={(sessionId) => router.push(sessionHref(sessionId, '/work'))}
                onLongPress={(issue) => setMenuTarget({ issue, lane: 'live' })}
                onTuck={
                  item.kind === 'issue' && rowAwaitsTuck(item, null, false, now)
                    ? () => void store.setIssueTucked(item.issue.id, true)
                    : undefined
                }
              />
            )}
            renderSectionFooter={({ section }) => (
              <View style={styles.folds}>
                {section.snoozedRows.length > 0 ? (
                  <Fold
                    storageKey={`podium:sidebar:snoozed-fold:${section.key}`}
                    label="Snoozed"
                    rows={section.snoozedRows}
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
      <TaskSheet
        issue={peek}
        issues={issues}
        sessions={sessionsAll}
        onClose={() => setPeek(null)}
        onOpenSession={(session) => {
          setPeek(null)
          router.push(sessionHref(session.sessionId, '/work'))
        }}
      />
      {menuTarget ? (
        <WorkIssueMenu
          target={menuTarget}
          issues={issues}
          sessions={sessionsAll}
          moves={menuMoves}
          onOpen={openIssuePage}
          onPeek={setPeek}
          onMove={move}
          onClose={() => setMenuTarget(null)}
        />
      ) : null}
    </Screen>
  )
}

function workRowSearchText(row: UnifiedWorkRow, now: number): string {
  if (row.kind === 'issue') {
    return `${issueDisplayRef(row.issue)} ${row.issue.title} ${rowStatusLine(row, now, 0)}`.toLowerCase()
  }
  return `${row.worktree.repoName ?? ''} ${row.worktree.branch ?? ''} ${rowStatusLine(row, now, 0)}`.toLowerCase()
}

function rowIssueId(row: UnifiedWorkRow): string | null {
  return row.kind === 'issue' ? row.issue.id : null
}

/** A project-local disclosure (Snoozed / Closed): the collapsed default and the
 *  one-line folded rows of the desktop fold, at thumb size. */
function Fold({
  storageKey,
  label,
  rows,
  lane,
  now,
  onOpen,
  onLongPress,
}: {
  storageKey: string
  label: string
  rows: UnifiedIssueRow[]
  lane: 'closed' | 'snoozed'
  now: number
  onOpen: (issue: IssueWire) => void
  onLongPress: (row: UnifiedIssueRow) => void
}) {
  const [collapsed, toggle] = useCollapsed(storageKey, true)
  return (
    <View style={styles.fold}>
      <PressableScale
        accessibilityRole="button"
        // `aria-expanded` beside `accessibilityState`: react-native-web 0.21 reads
        // only the former, so the web build announced no state at all. [POD-1664]
        accessibilityState={{ expanded: !collapsed }}
        aria-expanded={!collapsed}
        accessibilityLabel={`${collapsed ? 'Show' : 'Hide'} ${label.toLowerCase()} · ${rows.length}`}
        onPress={toggle}
        style={({ pressed }) => [styles.foldToggle, pressed && styles.pressed]}
      >
        <Icon as={collapsed ? ChevronRight : ChevronDown} size={11} color={color.textMicro} />
        <Text style={styles.foldToggleText}>{`${label} · ${rows.length}`}</Text>
        <View style={styles.foldRule} />
      </PressableScale>
      {collapsed
        ? null
        : rows.map((row) => (
            <PressableScale
              key={row.issue.id}
              accessibilityRole="button"
              accessibilityLabel={`${issueDisplayRef(row.issue)} ${row.issue.title}`}
              onPress={() => onOpen(row.issue)}
              onLongPress={() => onLongPress(row)}
              delayLongPress={350}
              style={({ pressed }) => [styles.foldedRow, pressed && styles.pressed]}
            >
              <Text style={styles.foldedRef}>{issueDisplayRef(row.issue)}</Text>
              <Text style={styles.foldedTitle} numberOfLines={1}>
                {row.issue.title}
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
          ))}
    </View>
  )
}

function WorkRow({
  row,
  attention,
  issues,
  sessions: allSessions,
  allWorktreePaths,
  now,
  onOpenIssue,
  onOpenSession,
  onLongPress,
  onTuck,
}: {
  row: UnifiedWorkRow
  attention: boolean
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  allWorktreePaths: string[]
  now: number
  onOpenIssue: (issue: IssueWire) => void
  onOpenSession: (sessionId: SessionId) => void
  onLongPress: (issue: IssueNavigationModel) => void
  onTuck?: (() => void) | undefined
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
  const decision = row.kind === 'issue' ? rowPendingDecision(row) : null
  const unread = rowUnreadEmphasized(row)
  // The row's own progress, at the scope it speaks for: its whole mission. The
  // deck's derivation, imported rather than restated — the two must never
  // disagree about how far a mission is.
  const progress = useMemo(
    () => (issue ? missionProgress([...issues], [...allSessions], issue.id) : null),
    [allSessions, issue, issues],
  )
  // A draft vessel's only content is its agents — its row IS the agent, so it
  // clicks straight into the session (desktop POD-282).
  const draftOnly = issue ? isDraftAgentVessel(issue, sessions) : false
  const label = issue
    ? draftOnly
      ? draftIssueLabel(issue, [...allSessions], allWorktreePaths)
      : issue.title
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

  const press = () => {
    if (issue) {
      if (draftOnly && sessions[0]) onOpenSession(sessions[0].sessionId)
      else onOpenIssue(issue)
      return
    }
    if (sessions[0]) onOpenSession(sessions[0].sessionId)
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
            {attention && waiting > 0 ? <Text style={styles.rowWaitCount}>{waiting}</Text> : null}
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
              {working ? <WorkingMark size={11} /> : null}
              {stamp ? (
                <Text style={styles.stamp} numberOfLines={1}>
                  {stamp}
                </Text>
              ) : null}
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
  groupLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 31,
    paddingHorizontal: space.lg,
    backgroundColor: color.bar,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  groupLabelAttention: {
    backgroundColor: color.bar,
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
    color: color.working,
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
