import { relativeTime } from '@podium/client-core/focus'
import { useSlice } from '@podium/client-core/react'
import {
  draftIssueLabel,
  formatClock,
  isDraftAgentVessel,
  type MotionPhase,
  missionProgress,
  pendingDecisionLabel,
  planReorderKeys,
  rowAwaitsTuck,
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
import { isIssueDeferred, issueReturnedFromDefer } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useRouter } from 'expo-router'
import {
  AlarmClock,
  ArrowDownToLine,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Pin,
} from 'lucide-react-native'
import { useCallback, useMemo, useState } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { useBooting, useIssues, useMobileStore, useSessions } from '../client/hooks'
import { useMobileShell } from '../client/shell'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { Icon } from '../components/Icon'
import { IdSquare, type IdSquareState } from '../components/IdSquare'
import { IssueColorSheet } from '../components/IssueColorSheet'
import { BootstrapCrossfade, WorkSkeleton } from '../components/LaunchPlaceholders'
import { NewWorkButton } from '../components/NewWorkButton'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { Screen } from '../components/Screen'
import { BrailleSpinner } from '../components/StatusGlyphs'
import { TaskSheet } from '../components/TaskSheet'
import { EmptyState } from '../components/ui'
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
 * (POD-331), so pinned band, project groups, manual sort order, tuck-away and
 * the Snoozed / Closed folds cannot drift.
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

const SQUARE_STATE: Record<MotionPhase, IdSquareState> = {
  working: 'working',
  waiting: 'waiting',
  done: 'done',
  queued: 'queued',
}

/** How a folded row ended, in one dim mono word — twin of the desktop's
 *  `foldedMarker`. Nothing here is an ask, so none of it is amber. */
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
  switch (issue.closedReason) {
    case 'superseded':
      return 'superseded'
    case 'duplicate':
      return 'duplicate'
    case 'wontfix':
      return "won't fix"
    default:
      return 'closed'
  }
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
  pinned: boolean
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
  const { notice } = useMobileShell()
  const { listRef, refreshControl, refreshAccessibilityProps, refreshing, onRefresh, connected } =
    useRefreshableTab('work')
  const tabBarInset = useTabBarInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()
  // THE SAME LIST THE DESKTOP SIDEBAR RENDERS, DERIVED ONCE (POD-331/POD-332):
  // one derivation per snapshot, carrying the clock it was derived against, so
  // the phone and the desk cannot disagree about whether a snooze has lapsed.
  const { pinned, groups, allWorktreePaths, now } = useSlice(worklistSlice)
  const [peek, setPeek] = useState<IssueWire | null>(null)
  const [menuIssue, setMenuIssue] = useState<IssueWire | null>(null)
  const [colorIssue, setColorIssue] = useState<IssueWire | null>(null)

  const { sections, issueCount, agentCount } = useMemo(() => {
    const list: WorkSection[] = []
    if (pinned.length > 0) {
      list.push({
        key: 'pinned',
        label: 'Pinned',
        pinned: true,
        data: pinned,
        snoozedRows: [],
        closedRows: [],
      })
    }
    for (const group of groups) {
      if (group.rows.length + group.snoozedRows.length + group.closedRows.length === 0) continue
      list.push({
        key: group.key,
        label: group.label,
        pinned: false,
        data: group.rows,
        snoozedRows: group.snoozedRows,
        closedRows: group.closedRows,
      })
    }
    const open = [...pinned, ...groups.flatMap((g) => g.rows)]
    return {
      sections: list,
      issueCount: open.filter((row) => row.kind === 'issue').length,
      agentCount: new Set(
        open.flatMap((row) =>
          (row.kind === 'issue'
            ? (row.aggregateSessions ?? row.sessions)
            : row.worktree.sessions
          ).map((s) => s.sessionId),
        ),
      ).size,
    }
  }, [pinned, groups])

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
      const section = sections.find((s) => s.data.some((r) => rowIssueId(r) === issue.id))
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
    [issues, sections, store.trpc],
  )

  const menuActions = useMemo<SheetAction[]>(() => {
    const issue = menuIssue
    if (!issue) return []
    return [
      { label: 'Open', hint: 'Transcript, with the flight deck', onPress: () => openIssue(issue) },
      {
        label: 'Peek',
        hint: 'The task inspector, without leaving Work',
        onPress: () => setPeek(issue),
      },
      { label: 'Colour…', onPress: () => setColorIssue(issue) },
      { label: issue.pinned ? 'Unpin' : 'Pin to top', onPress: () => togglePin(issue) },
      { label: 'Move to top', onPress: () => move(issue, 'top') },
      { label: 'Move up', onPress: () => move(issue, 'up') },
      { label: 'Move down', onPress: () => move(issue, 'down') },
      ...(issue.tuckedAt != null
        ? [
            {
              label: 'Bring back from Closed',
              onPress: () => void store.setIssueTucked(issue.id, false),
            },
          ]
        : []),
    ]

    function togglePin(target: IssueWire) {
      void store.trpc.issues.update
        .mutate({ id: target.id, patch: { pinned: !target.pinned } })
        .catch(() => {})
    }
  }, [menuIssue, move, openIssue, store.trpc, store.setIssueTucked])

  return (
    <Screen
      large
      title="Work"
      subtitle={`${issueCount} task${issueCount === 1 ? '' : 's'} · ${agentCount} agent${agentCount === 1 ? '' : 's'}`}
      right={<NewWorkButton />}
    >
      {/* Never silent (ADR 6 D4.4): storage degradation is owed to the user, not
          a log line. Outside the crossfade so the skeleton cannot hide it. */}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {/* Crossfade OUTSIDE the refresh boundary: while the replica is still
          resolving there is nothing to pull-to-refresh, so the skeleton should
          cover the refresh affordance too rather than invite a gesture that
          would race the bootstrap. */}
      <BootstrapCrossfade resolved={!booting} placeholder={<WorkSkeleton />}>
        <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
          <SectionList
            ref={listRef as never}
            sections={sections}
            keyExtractor={(row) => (row.kind === 'issue' ? row.issue.id : row.worktree.path)}
            refreshControl={refreshControl}
            contentContainerStyle={[styles.listContent, { paddingBottom: tabBarInset + space.lg }]}
            {...refreshAccessibilityProps}
            {...minimizeOnScroll}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) => (
              <View style={styles.groupLabel}>
                {section.pinned ? <Icon as={Pin} size={9} color={color.accentTint} /> : null}
                <Text style={styles.groupLabelText} numberOfLines={1}>
                  {section.label}
                </Text>
                <View style={styles.rule} />
              </View>
            )}
            renderItem={({ item }) => (
              <WorkRow
                row={item}
                issues={issues}
                sessions={sessionsAll}
                allWorktreePaths={allWorktreePaths}
                now={now}
                onOpenIssue={openIssue}
                onOpenSession={(sessionId) => router.push(sessionHref(sessionId, '/work'))}
                onLongPress={(issue) => setMenuIssue(issue)}
                onPickColour={(issue) => setColorIssue(issue)}
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
                    onLongPress={setMenuIssue}
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
                    onLongPress={setMenuIssue}
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
                  title="No work yet"
                  body="Tasks and their agents appear here — the same list, in the same order, as the desktop sidebar."
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
      <ActionSheet
        visible={menuIssue !== null}
        title={menuIssue ? `${issueDisplayRef(menuIssue)} ${menuIssue.title}` : ''}
        actions={menuActions}
        onClose={() => setMenuIssue(null)}
      />
      <IssueColorSheet issue={colorIssue} onClose={() => setColorIssue(null)} />
    </Screen>
  )
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
  onLongPress: (issue: IssueWire) => void
}) {
  const [collapsed, toggle] = useCollapsed(storageKey, true)
  return (
    <View style={styles.fold}>
      <PressableScale
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
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
              onLongPress={() => onLongPress(row.issue)}
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
  issues,
  sessions: allSessions,
  allWorktreePaths,
  now,
  onOpenIssue,
  onOpenSession,
  onLongPress,
  onPickColour,
  onTuck,
}: {
  row: UnifiedWorkRow
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  allWorktreePaths: string[]
  now: number
  onOpenIssue: (issue: IssueWire) => void
  onOpenSession: (sessionId: SessionId) => void
  onLongPress: (issue: IssueWire) => void
  onPickColour: (issue: IssueWire) => void
  onTuck?: (() => void) | undefined
}) {
  const issue = row.kind === 'issue' ? row.issue : undefined
  const worktree = row.kind === 'worktree' ? row.worktree : undefined
  const sessions = row.kind === 'issue' ? row.sessions : row.worktree.sessions
  // The row speaks for its whole branch: descendants have no row of their own
  // here, so the fleet stack reads the bubbled aggregate.
  const fleetSessions = row.kind === 'issue' ? (row.aggregateSessions ?? sessions) : sessions
  const hex = issue ? issueColorHex(issue.color) : undefined
  const rowBg = hex ? flow.rowBg(hex) : color.surface
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
        hex ? { backgroundColor: rowBg } : null,
        phase === 'queued' && styles.rowQueued,
        phase === 'done' && !onTuck && styles.rowDone,
        issue?.audience === 'agent' && styles.rowInternal,
      ]}
    >
      {/* THE SQUARE IS ITS OWN CONTROL, AND ITS OWN ELEMENT [POD-724]. On the
          desktop the identity square opens the swatch grid, so it does here too
          — but it cannot be a button nested inside the row's button: on the web
          build that is invalid HTML (React says so out loud), and the browser
          resolves it by dropping one of the two targets. So the square and the
          row body are SIBLINGS, each with its own press area, inside a row that
          is a plain view. The square's own padding is what carries it to a 44pt
          target without widening the row. */}
      {issue ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Colour ${issueDisplayRef(issue)}`}
          onPress={() => onPickColour(issue)}
          onLongPress={() => onLongPress(issue)}
          delayLongPress={350}
          scaleTo={0.9}
          style={({ pressed }) => [styles.squareTap, pressed && styles.pressed]}
        >
          <IdSquare
            issue={issue}
            state={SQUARE_STATE[phase]}
            ringColor={rowBg}
            {...(waiting > 0 ? { badge: { kind: 'waiting' as const, count: waiting } } : {})}
          />
        </PressableScale>
      ) : (
        <View style={styles.squareTap}>
          <View style={styles.worktreeSquare}>
            <Text style={styles.worktreeGlyph}>⌥</Text>
          </View>
        </View>
      )}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={issue ? `${issueDisplayRef(issue)} ${label}` : `Worktree ${label}`}
        onPress={press}
        onLongPress={issue ? () => onLongPress(issue) : undefined}
        delayLongPress={350}
        scaleTo={0.99}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
      >
        <View style={styles.rowText}>
          <View style={styles.rowTitleLine}>
            <Text
              style={[
                styles.rowTitle,
                unread && styles.rowTitleUnread,
                hex ? { color: flow.text(hex) } : null,
              ]}
              numberOfLines={2}
            >
              {label}
            </Text>
            {unread ? <View style={styles.unreadDot} /> : null}
            {issue?.audience === 'agent' ? <Text style={styles.internal}>internal</Text> : null}
            {draftOnly ? null : <FleetSummary sessions={fleetSessions} />}
            {issue?.pinned ? <Icon as={Pin} size={10} color={color.textMicro} /> : null}
            {snoozed ? <Icon as={AlarmClock} size={10} color={color.textMicro} /> : null}
            {unsnoozed ? <Text style={styles.unsnoozed}>Unsnoozed</Text> : null}
          </View>
          <View style={styles.rowStatusLine}>
            {working && phase !== 'working' ? <BrailleSpinner size={9} /> : null}
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
            <View style={styles.spacer} />
            {issue ? (
              <GitStampLine
                branch={issue.branch}
                git={issue.gitState}
                suppressAhead={decision === 'merge'}
              />
            ) : null}
            {stamp ? (
              <Text style={styles.stamp} numberOfLines={1}>
                {stamp}
              </Text>
            ) : null}
          </View>
          {progress ? <RowProgressMeter progress={progress} working={working} /> : null}
        </View>
      </PressableScale>
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
  listContent: {
    flexGrow: 1,
    paddingHorizontal: space.sm + 2,
  },
  notice: {
    color: color.textDim,
    fontSize: font.small,
    paddingHorizontal: space.xl,
    paddingBottom: space.sm,
  },
  groupLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
    paddingTop: space.md,
    paddingBottom: 3,
  },
  groupLabelText: {
    ...monoLabel(),
    color: color.label,
    flexShrink: 1,
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
    marginBottom: 3,
    borderRadius: radius.md + 1,
    backgroundColor: color.surface,
    overflow: 'hidden',
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
  // The square's own touch area: 26pt of ink inside a 44pt target, paid for
  // with padding so the row keeps its height.
  squareTap: {
    justifyContent: 'center',
    paddingLeft: 9,
    paddingRight: 3,
    paddingVertical: 9,
  },
  rowMain: {
    flex: 1,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingLeft: 6,
    paddingRight: 8,
    paddingVertical: 7,
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
    ...sans(400),
    flexShrink: 1,
    color: color.body,
    fontSize: font.small,
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
  worktreeSquare: {
    width: 26,
    height: 26,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  worktreeGlyph: {
    ...mono(400),
    color: color.textFaint,
    fontSize: 11,
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
    paddingHorizontal: 4,
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
    paddingHorizontal: 8,
    borderRadius: radius.sm,
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
