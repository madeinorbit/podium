/**
 * THE WORK TAB'S ROW (POD-4421) — extracted from `WorkScreen.tsx` VERBATIM,
 * then narrowed.
 *
 * The row used to receive the whole `issues`/`sessions`/`allWorktreePaths`
 * arrays plus `now`, so — in its own author's words — "a snapshot tick still
 * repaints everything (its arrays and `now` are new)". It now receives its
 * row object (stable across publishes via `reuseUnifiedWorkRows` in the
 * screen) plus the scalars it displays, computed once per list: label,
 * progress, origin seq, status line, stamp, snooze marks and a stable per-id
 * tuck thunk. An unrelated publish leaves every prop referentially equal and
 * the row stays cold; a clock tick still updates the rows whose strings
 * actually moved.
 *
 * Its own module so the render-count probe can import the row without loading
 * the screen's navigation/store/sheet graph.
 */
import { relativeTime } from '@podium/client-core/focus'
import {
  formatClock,
  type IssueNavigationModel,
  isDraftAgentVessel,
  type MissionProgress,
  rowHasWorkingSession,
  rowMotionPhase,
  rowMotionTiming,
  rowPendingDecision,
  rowUnreadEmphasized,
  rowWaitingCount,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model'
import type { MobileRowValues } from '@podium/client-graph/worklist/mobile-row'
import { issueDisplayRef } from '@podium/protocol'
import { memo, useCallback, useMemo, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Icon } from '../components/Icon'
import { AlarmClock, ArrowDownToLine, Pin } from '../components/icons'
import { PressableScale } from '../components/PressableScale'
import { FleetSummary, GitStampLine, RowProgressMeter } from '../components/WorkRowParts'
import type { NativeGitStamp } from '../components/WorkRowParts'
import { WorkingMark } from '../components/WorkingMark'
import { workRowId, mobileRowPaint, mobilePaintNow, type MobileRowPaint } from '../lib/work-sections'
import type { MobxPool } from '@podium/client-graph/pool'
import type { MobileWorkRef } from '@podium/client-graph/worklist/mobile'
import type { SessionView } from '@podium/client-core/session-values'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

/** Standard delay-before-show for the row's open loader: below this an open
 *  reads as instant and a spinner would only be a flash. */
export const NAV_LOADER_DELAY_MS = 150

/** True once `active` has held for `delayMs`; false the moment it drops. */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
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
export function timeStamp(row: UnifiedWorkRow, now: number): string | null {
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

export interface WorkListRowProps {
  row: UnifiedWorkRow
  /** Narrow display title, computed once per list. */
  label: string
  /** Narrow progress (the row's own rollup, fallback computed per list). */
  progress: MissionProgress | null
  /** Narrow spin-off origin seq; null = no tick. */
  originSeq: number | null
  /** Narrow status phrase for `now`, computed once per list. */
  statusLine: string
  /** Narrow timer stamp for `now`, computed once per list. */
  stamp: string | null
  /** Narrow snooze marks for `now`, computed once per list. */
  snoozed: boolean
  unsnoozed: boolean
  /** Stable per-id tuck thunk; absent = not tuckable. */
  onTuck?: () => void
  /** This row's open is in flight — show the delayed native loader. */
  navPending: boolean
  onOpenIssue: (issue: IssueNavigationModel) => void
  onOpenSession: (sessionId: SessionId, rowKey: string) => void
  onLongPress: (issue: IssueNavigationModel) => void
  /** Pool slots resolve hidden navigation through their reader on the press. */
  onOpen?: () => void
  /** Pool facts bypass the legacy row derivations; the markup stays shared. */
  display?: Pick<MobileRowValues, 'working' | 'waitingCount' | 'decision' | 'unread' | 'draftOnly' | 'fleet'> & {
    phase: MobileRowValues['timing']['phase']
    gitStamp: NativeGitStamp
  }
}

/**
 * MEMOIZED OVER NARROW PROPS (POD-4421). Default shallow compare is the whole
 * contract: `row` is stable via `reuseUnifiedWorkRows`, every display value
 * is a scalar, `progress` keeps a stable reference for unchanged rows, and
 * every callback is a stable reference.
 */
export const WorkRow = memo(function WorkRow({
  row,
  label,
  progress,
  originSeq,
  statusLine,
  stamp,
  snoozed,
  unsnoozed,
  onTuck,
  navPending,
  onOpenIssue,
  onOpenSession,
  onLongPress,
  onOpen,
  display,
}: WorkListRowProps) {
  const issue = row.kind === 'issue' ? row.issue : undefined
  const sessions = row.kind === 'issue' ? row.sessions : row.worktree.sessions
  // The row speaks for its whole branch: descendants have no row of their own
  // here, so the fleet stack reads the bubbled aggregate.
  const fleetSessions = row.kind === 'issue' ? (row.aggregateSessions ?? sessions) : sessions
  const hex = issue ? issueColorHex(issue.color) : undefined
  const rowBg = hex ? flow.rowBg(hex) : color.engraved
  const phase = display?.phase ?? rowMotionPhase(row)
  // An ask outranks work in the phase, so the phase alone cannot answer "is an
  // agent computing" — and on a one-row-per-mission list that left a running
  // fleet reading as stopped (POD-703). Every working texture gates on this.
  const working = display?.working ?? rowHasWorkingSession(row)
  const waiting = display?.waitingCount ?? rowWaitingCount(row)
  // The ask treatment follows the ROW, not the band it landed in: a waiting
  // row stays put when pinned (see ../lib/work-sections.ts), so the tint, the
  // count and the Answer/Review action must travel with the fact itself.
  const attention = waiting > 0
  const decision = display ? display.decision : row.kind === 'issue' ? rowPendingDecision(row) : null
  const rowUnread = display?.unread ?? rowUnreadEmphasized(row)
  // A draft vessel's only content is its agents — its row IS the agent, so it
  // clicks straight into the session (desktop POD-282).
  const draftOnly = display?.draftOnly ?? (issue ? isDraftAgentVessel(issue, sessions) : false)
  // A freshly minted draft is not news to the person who just minted it: no
  // unread dot or bold until its agent actually reports runtime state — the
  // same gate the chats list applies (SessionCard's hidesDraftDot, round 2).
  const draftQuiet =
    !display && draftOnly && !sessions[0]?.busy && (sessions[0]?.agentState?.phase ?? 'unknown') === 'unknown'
  const unread = rowUnread && !draftQuiet
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
        rowStyles.row,
        attention ? rowStyles.rowAttention : hex ? { backgroundColor: rowBg } : null,
        phase === 'queued' && rowStyles.rowQueued,
        phase === 'done' && !onTuck && rowStyles.rowDone,
        issue?.audience === 'agent' && rowStyles.rowInternal,
      ]}
    >
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={issue ? `${issueDisplayRef(issue)} ${label}` : `Worktree ${label}`}
        onPress={onOpen ?? press}
        onLongPress={issue ? () => onLongPress(issue) : undefined}
        delayLongPress={350}
        scaleTo={0.99}
        style={({ pressed }) => [
          rowStyles.rowMain,
          attention && rowStyles.rowMainAttention,
          pressed && rowStyles.pressed,
        ]}
      >
        <View style={rowStyles.rowText}>
          <View style={rowStyles.rowTitleLine}>
            <Text
              style={[
                rowStyles.rowTitle,
                unread && rowStyles.rowTitleUnread,
                hex ? { color: flow.text(hex) } : null,
              ]}
              numberOfLines={1}
            >
              {label}
            </Text>
            {unread ? <View style={rowStyles.unreadDot} /> : null}
            {issue?.audience === 'agent' ? <Text style={rowStyles.internal}>internal</Text> : null}
            {snoozed ? <Icon as={AlarmClock} size={10} color={color.textMicro} /> : null}
            {unsnoozed ? <Text style={rowStyles.unsnoozed}>Unsnoozed</Text> : null}
          </View>
          <View style={rowStyles.rowStatusLine}>
            {issue ? <Text style={rowStyles.rowRef}>{issueDisplayRef(issue)}</Text> : null}
            {attention ? <Text style={rowStyles.rowWaitCount}>{waiting}</Text> : null}
            {issue?.pinned ? <Icon as={Pin} size={9} color={color.textMicro} /> : null}
            {draftOnly ? null : <FleetSummary sessions={fleetSessions} display={display?.fleet} />}
            <Text
              style={[
                rowStyles.status,
                decision ? rowStyles.statusDecision : null,
                !decision && phase === 'working' ? rowStyles.statusWorking : null,
                !decision && phase === 'done' ? rowStyles.statusDone : null,
              ]}
              numberOfLines={1}
            >
              {statusLine}
            </Text>
            {originSeq !== null ? <Text style={rowStyles.origin}>{`⤷ ${originSeq}`}</Text> : null}
            {issue ? (
              <GitStampLine
                branch={issue.branch}
                git={issue.gitState}
                suppressAhead={decision === 'merge'}
                display={display?.gitStamp}
              />
            ) : null}
            <View style={rowStyles.spacer} />
            <View style={rowStyles.rowDatum}>
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
                    <Text style={rowStyles.stamp} numberOfLines={1}>
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
          onPress={onOpen ?? press}
          style={({ pressed }) => [
            rowStyles.attentionAction,
            decision ? rowStyles.reviewAction : rowStyles.answerAction,
            pressed && rowStyles.pressed,
          ]}
        >
          <Text style={[rowStyles.actionText, decision && rowStyles.reviewActionText]}>
            {decision ? 'Review' : 'Answer'}
          </Text>
        </PressableScale>
      ) : null}
      {onTuck ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Tuck ${label} into Closed`}
          onPress={onTuck}
          style={({ pressed }) => [rowStyles.tuck, pressed && rowStyles.pressed]}
        >
          <Icon as={ArrowDownToLine} size={11} color={color.textMicro} />
          <Text style={rowStyles.tuckText}>Tuck</Text>
        </PressableScale>
      ) : null}
    </View>
  )
})

/**
 * The row's own geometry and ink, moved with the row (POD-4421). `pressed`
 * stays paired with the screen's copy (same value, same name) because the
 * folded rows there still read it.
 */
const rowStyles = StyleSheet.create({
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
  pressed: {
    opacity: 0.65,
  },
})

type PoolRowSnapshot = { readonly paint: MobileRowPaint | 'loading' | null; readonly reader: MobxPool['mobileWork'] | null }
const EMPTY_POOL_ROW: PoolRowSnapshot = Object.freeze({ paint: 'loading', reader: null })

export const PoolWorkRowSlot = memo(function PoolWorkRowSlot({ item, onTuck, ...callbacks }: {
  item: MobileWorkRef
  navPending: boolean
  onOpenIssue: (issue: IssueNavigationModel) => void
  onOpenSession: (sessionId: SessionId, rowKey: string) => void
  onLongPress: (issue: IssueNavigationModel) => void
  onTuck: (id: string) => void
}) {
  const read = useCallback((pool: MobxPool): PoolRowSnapshot => {
    const value = pool.mobileWork.row({ id: item.id, kind: item.kind })
    const paint = typeof value === 'symbol' ? 'loading' : value ? mobileRowPaint(value, mobilePaintNow(pool)) : null
    return { paint, reader: pool.mobileWork }
  }, [item.id, item.kind])
  const { paint, reader } = useMobilePoolProjection(read, EMPTY_POOL_ROW)
  const tuck = useCallback(() => onTuck(item.id), [item.id, onTuck])
  const openRow = useCallback(() => {
    const current = reader?.row({ id: item.id, kind: item.kind })
    if (!current || typeof current === 'symbol' || !current.navigation) return
    if (current.navigation.kind === 'session') callbacks.onOpenSession(current.navigation.id as SessionId, item.id)
    else if (current.sidebar) callbacks.onOpenIssue(current.sidebar.issue as IssueNavigationModel)
  }, [callbacks.onOpenIssue, callbacks.onOpenSession, item.id, item.kind, reader])
  const row = useMemo((): UnifiedWorkRow | null => {
    if (!paint || paint === 'loading') return null
    const sessions: SessionView[] = []
    if (paint.kind === 'issue') return { kind: 'issue', issue: { id: paint.id, displayRef: paint.ref,
      color: paint.color, audience: paint.internal ? 'agent' : 'human', pinned: paint.pinned,
      branch: paint.branch } as IssueNavigationModel, sessions, activityAt: 0 }
    return { kind: 'worktree', worktree: { path: paint.id, sessions } as Extract<UnifiedWorkRow, { kind: 'worktree' }>['worktree'], activityAt: 0 }
  }, [paint])
  if (paint === 'loading') return <View accessibilityLabel="Loading work" />
  if (!paint || !row) return null
  return <WorkRow row={row} label={paint.label} progress={paint.progress} originSeq={paint.originSeq}
    statusLine={paint.statusLine} stamp={paint.stamp} snoozed={paint.snoozed} unsnoozed={paint.unsnoozed}
    display={paint.display} onOpen={openRow} onTuck={paint.tuckable ? tuck : undefined} {...callbacks} />
}, (a, b) => a.item.id === b.item.id && a.item.kind === b.item.kind && a.item.listKey === b.item.listKey
  && a.navPending === b.navPending && a.onTuck === b.onTuck && a.onOpenIssue === b.onOpenIssue
  && a.onOpenSession === b.onOpenSession && a.onLongPress === b.onLongPress)
