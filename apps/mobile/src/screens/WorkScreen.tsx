import { relativeTime } from '@podium/client-core/focus'
import { useSlice } from '@podium/client-core/react'
import {
  agentBadge,
  draftIssueLabel,
  formatClock,
  isDraftAgentVessel,
  type MotionPhase,
  pendingDecisionLabel,
  rowAwaitsTuck,
  rowMotionPhase,
  rowMotionTiming,
  rowPendingDecision,
  rowStatusLine,
  rowUnreadEmphasized,
  rowWaitingCount,
  sessionDotTone,
  sessionTitle,
  type UnifiedIssueRow,
  type UnifiedWorkRow,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { ArrowDownToLine, ChevronDown, ChevronRight, Pin } from 'lucide-react-native'
import { useCallback, useMemo, useState } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { useBooting, useMobileStore, useSessions } from '../client/hooks'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { Icon } from '../components/Icon'
import { IdSquare, type IdSquareState } from '../components/IdSquare'
import { NewWorkButton } from '../components/NewWorkButton'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { Screen } from '../components/Screen'
import { BrailleSpinner } from '../components/StatusGlyphs'
import { TaskPeekSheet } from '../components/TaskPeekSheet'
import { EmptyState, ListSkeleton, StatusDot } from '../components/ui'
import { useCollapsed } from '../hooks/useCollapsed'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { useTabBarInset } from '../hooks/useTabBarInset'
import { sessionHref } from '../lib/session-route'
import { FLOW_SLATE, flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

/**
 * Work — the desktop sidebar, on the phone [POD-338].
 *
 * Not an approximation and no longer even a re-derivation: the rows come from
 * the PUBLISHED worklist slice the wide sidebar reads (POD-331), so pinned band,
 * project groups, manual sort order, agent rosters, tuck-away, and the Snoozed /
 * Closed folds all behave exactly as they do at the desk — and cannot drift,
 * because there is one derivation rather than one per platform. Only the row
 * CHROME is native: one thumb-sized two-line row per task, tapping through to
 * the task screen.
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
  const booting = useBooting()
  const { listRef, refreshControl, refreshAccessibilityProps, refreshing, onRefresh, connected } =
    useRefreshableTab('work')
  const tabBarInset = useTabBarInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()
  // THE SAME LIST THE DESKTOP SIDEBAR RENDERS, DERIVED ONCE (POD-331/POD-332).
  // This screen used to call `sidebarSections` → `unifiedWorkList` →
  // `splitPinnedWork` → `groupUnifiedWorkRows` itself, on a private
  // `useNow(30_000)` clock. Two consequences, and the second is the one that
  // mattered: the derivation ran per consumer, and the phone's clock was its
  // own, so mobile and every other reader could disagree about whether a snooze
  // had lapsed. The published slice derives once per snapshot and carries the
  // clock it was derived against.
  const { pinned, groups, allWorktreePaths, now } = useSlice(worklistSlice)
  const [peek, setPeek] = useState<IssueWire | null>(null)
  const [menuIssue, setMenuIssue] = useState<IssueWire | null>(null)

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

  const openIssue = useCallback(
    (issue: IssueWire) => {
      void store.markIssueRead(issue.id)
      router.push(`/issue/${encodeURIComponent(issue.id)}`)
    },
    [store.markIssueRead, router],
  )

  const menuActions = useMemo<SheetAction[]>(() => {
    const issue = menuIssue
    if (!issue) return []
    return [
      { label: 'Open task', onPress: () => openIssue(issue) },
      { label: 'Peek', onPress: () => setPeek(issue) },
      {
        label: issue.pinned ? 'Unpin' : 'Pin to top',
        onPress: () => {
          void store.trpc.issues.update
            .mutate({ id: issue.id, patch: { pinned: !issue.pinned } })
            .catch(() => {})
        },
      },
      ...(issue.tuckedAt != null
        ? [
            {
              label: 'Bring back from Closed',
              onPress: () => void store.setIssueTucked(issue.id, false),
            },
          ]
        : []),
    ]
  }, [menuIssue, openIssue, store.trpc, store.setIssueTucked])

  const renderRow = (row: UnifiedWorkRow) => (
    <WorkRow
      row={row}
      allWorktreePaths={allWorktreePaths}
      now={now}
      onOpenIssue={openIssue}
      onOpenSession={(sessionId) => router.push(sessionHref(sessionId, '/work'))}
      onLongPress={(issue) => setMenuIssue(issue)}
      onTuck={
        row.kind === 'issue' && rowAwaitsTuck(row, null, false, now)
          ? () => void store.setIssueTucked(row.issue.id, true)
          : undefined
      }
    />
  )

  return (
    <Screen
      large
      title="Work"
      subtitle={`${issueCount} task${issueCount === 1 ? '' : 's'} · ${agentCount} agent${agentCount === 1 ? '' : 's'}`}
      right={<NewWorkButton />}
    >
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
              {section.pinned ? <Icon as={Pin} size={9} color={color.accent} /> : null}
              <Text style={styles.groupLabelText} numberOfLines={1}>
                {section.label}
              </Text>
              <View style={styles.rule} />
            </View>
          )}
          renderItem={({ item }) => renderRow(item)}
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
            booting ? (
              <ListSkeleton />
            ) : (
              <EmptyState
                title="No work yet"
                body="Tasks and their agents appear here — the same list, in the same order, as the desktop sidebar."
              />
            )
          }
        />
      </PullToRefreshBoundary>
      <TaskPeekSheet issue={peek} sessions={sessionsAll} onClose={() => setPeek(null)} />
      <ActionSheet
        visible={menuIssue !== null}
        title={menuIssue ? `${issueDisplayRef(menuIssue)} ${menuIssue.title}` : ''}
        actions={menuActions}
        onClose={() => setMenuIssue(null)}
      />
    </Screen>
  )
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
  allWorktreePaths,
  now,
  depth = 0,
  onOpenIssue,
  onOpenSession,
  onLongPress,
  onTuck,
}: {
  row: UnifiedWorkRow
  allWorktreePaths: string[]
  now: number
  depth?: number
  onOpenIssue: (issue: IssueWire) => void
  onOpenSession: (sessionId: SessionId) => void
  onLongPress: (issue: IssueWire) => void
  onTuck?: (() => void) | undefined
}) {
  const issue = row.kind === 'issue' ? row.issue : undefined
  const worktree = row.kind === 'worktree' ? row.worktree : undefined
  const sessions = row.kind === 'issue' ? row.sessions : row.worktree.sessions
  const hex = issue ? issueColorHex(issue.color) : undefined
  const accent = hex ?? FLOW_SLATE
  const phase = rowMotionPhase(row)
  const waiting = rowWaitingCount(row)
  const decision = row.kind === 'issue' ? rowPendingDecision(row) : null
  const unread = rowUnreadEmphasized(row)
  const startedByChildren = row.kind === 'issue' ? (row.startedByChildren ?? []) : []
  // A draft vessel's only content is its agents — its row IS the agent, so it
  // clicks straight into the session and never folds out (desktop POD-282).
  const draftOnly = issue ? isDraftAgentVessel(issue, sessions) : false
  const label = issue
    ? draftOnly
      ? draftIssueLabel(issue, sessions, allWorktreePaths)
      : issue.title
    : `${worktree?.repoName ?? ''}${worktree?.branch ? ` · ${worktree.branch}` : ''}`
  const expandable = !draftOnly && sessions.length > 0
  const [collapsed, toggle] = useCollapsed(
    issue
      ? `podium:sidebar:unified-issue:${issue.id}`
      : `podium:sidebar:wt:${worktree?.path ?? ''}`,
    !(issue?.pinned ?? false),
  )
  const stamp = timeStamp(row, now)
  const statusLine =
    issue && decision ? pendingDecisionLabel(issue, decision) : rowStatusLine(row, now, 1)

  const press = () => {
    if (issue) {
      if (draftOnly && sessions[0]) onOpenSession(sessions[0].sessionId)
      else onOpenIssue(issue)
      return
    }
    if (sessions[0]) onOpenSession(sessions[0].sessionId)
  }

  return (
    <View style={[styles.rowBlock, depth > 0 && styles.rowNested]}>
      <View
        style={[
          styles.row,
          hex ? { backgroundColor: flow.rowBg(hex) } : null,
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
          style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
        >
          {issue ? (
            <IdSquare
              issue={issue}
              state={SQUARE_STATE[phase]}
              ringColor={hex ? flow.rowBg(hex) : color.surface}
              {...(waiting > 0 ? { badge: { kind: 'waiting' as const, count: waiting } } : {})}
            />
          ) : (
            <View style={styles.worktreeSquare}>
              <Text style={styles.worktreeGlyph}>⌥</Text>
            </View>
          )}
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
              {sessions.length > 0 ? (
                <Text style={styles.fleet}>{`${sessions.length}⏣`}</Text>
              ) : null}
            </View>
            <View style={styles.rowStatusLine}>
              {phase === 'working' ? <BrailleSpinner size={9} /> : null}
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
              {stamp ? <Text style={styles.stamp}>{stamp}</Text> : null}
            </View>
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
        ) : expandable ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityState={{ expanded: !collapsed }}
            accessibilityLabel={`${collapsed ? 'Show' : 'Hide'} agents on ${label}`}
            onPress={toggle}
            style={({ pressed }) => [styles.chevron, pressed && styles.pressed]}
          >
            <Icon as={collapsed ? ChevronRight : ChevronDown} size={14} color={color.textFaint} />
          </PressableScale>
        ) : null}
      </View>
      {expandable && !collapsed ? (
        <View style={styles.roster}>
          <View style={styles.rosterGuide} />
          <Text style={styles.rosterLabel}>{`AGENTS · ${sessions.length}`}</Text>
          {sessions.map((session) => (
            <AgentRow
              key={session.sessionId}
              session={session}
              issue={issue}
              onPress={() => onOpenSession(session.sessionId)}
            />
          ))}
        </View>
      ) : null}
      {startedByChildren.map((child) => (
        <WorkRow
          key={child.issue.id}
          row={child}
          allWorktreePaths={allWorktreePaths}
          now={now}
          depth={depth + 1}
          onOpenIssue={onOpenIssue}
          onOpenSession={onOpenSession}
          onLongPress={onLongPress}
        />
      ))}
      {hex && !collapsed && expandable ? (
        <View
          style={[styles.cardEdge, { borderColor: alpha(accent, 0.34) }]}
          pointerEvents="none"
        />
      ) : null}
    </View>
  )
}

/** One agent under its task: identity, one status word, one dot. */
function AgentRow({
  session,
  issue,
  onPress,
}: {
  session: SessionMeta
  issue: IssueWire | undefined
  onPress: () => void
}) {
  const badge = agentBadge(session, issue)
  const dot = sessionDotTone(session)
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Open session ${sessionTitle(session)}`}
      onPress={onPress}
      style={({ pressed }) => [styles.agentRow, pressed && styles.pressed]}
    >
      <View style={styles.agentStub} />
      <Text style={styles.agentName} numberOfLines={1}>
        {sessionTitle(session)}
      </Text>
      {badge?.label ? (
        <Text
          style={[
            styles.agentMeta,
            badge.tone === 'attention' && styles.agentMetaAttention,
            badge.tone === 'error' && styles.agentMetaError,
          ]}
          numberOfLines={1}
        >
          {badge.label}
        </Text>
      ) : null}
      {dot === 'working' ? (
        <BrailleSpinner size={9} />
      ) : (
        <StatusDot
          size={6}
          toneKey={dot === 'attention' ? 'needsYou' : dot === 'error' ? 'danger' : 'idle'}
        />
      )}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  listContent: {
    flexGrow: 1,
    paddingHorizontal: space.sm + 2,
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
  rowBlock: {
    marginBottom: 3,
    borderRadius: radius.md + 1,
    overflow: 'hidden',
  },
  rowNested: {
    marginLeft: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: radius.md + 1,
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
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingLeft: 9,
    paddingRight: 6,
    paddingVertical: 6,
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
    fontSize: font.body,
  },
  rowTitleUnread: {
    ...sans(600),
    color: color.text,
  },
  fleet: {
    ...mono(400),
    marginLeft: 'auto',
    color: color.textMicro,
    fontSize: font.micro,
  },
  rowStatusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  status: {
    ...mono(500),
    flexShrink: 1,
    color: color.textFaint,
    fontSize: font.tiny,
  },
  statusDecision: {
    ...mono(600),
    color: color.needsYou,
  },
  statusWorking: {
    color: color.working,
  },
  statusDone: {
    color: color.textMicro,
  },
  stamp: {
    ...mono(400),
    marginLeft: 'auto',
    color: color.textMicro,
    fontSize: font.micro,
  },
  chevron: {
    width: 34,
    alignItems: 'center',
    justifyContent: 'center',
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
  roster: {
    position: 'relative',
    paddingLeft: 26,
    paddingBottom: 4,
    backgroundColor: color.rail,
  },
  rosterGuide: {
    position: 'absolute',
    left: 17,
    top: 6,
    bottom: 8,
    width: 1.5,
    borderRadius: 1,
    backgroundColor: '#2b3550',
  },
  rosterLabel: {
    ...monoLabel(),
    color: color.label,
    paddingTop: 4,
    paddingBottom: 2,
  },
  agentRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingRight: 10,
  },
  agentStub: {
    width: 7,
    height: 1,
    backgroundColor: '#2b3550',
  },
  agentName: {
    ...sans(400),
    flexShrink: 1,
    color: color.body,
    fontSize: font.small,
  },
  agentMeta: {
    ...mono(400),
    marginLeft: 'auto',
    color: color.textMicro,
    fontSize: font.micro,
  },
  agentMetaAttention: {
    color: color.needsYou,
  },
  agentMetaError: {
    color: color.danger,
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
  cardEdge: {
    ...StyleSheet.absoluteFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md + 1,
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
