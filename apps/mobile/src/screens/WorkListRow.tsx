import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import type { WorklistWorktree } from '@podium/client-graph/worklist/worktree'
import { useWorklistModel } from '@podium/client-graph/react'
/** Native work-row paint from one addressed pool projection. */
import type { IssueNavigationModel } from '@podium/client-core/values'
import type { MobileWorkRef } from '@podium/client-graph/worklist/mobile'
import { issueDisplayRef } from '@podium/protocol'
import type { IssueGitState, SessionId } from '@podium/model'
import { observer } from 'mobx-react-lite'
import { memo, useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import { Icon } from '../components/Icon'
import { AlarmClock, ArrowDownToLine, Pin } from '../components/icons'
import { PressableScale } from '../components/PressableScale'
import { NotSavedMark } from '../components/NotSavedMark'
import { WorkingMark } from '../components/WorkingMark'
import { FleetSummary, GitStampLine, RowProgressMeter } from '../components/WorkRowParts'
import { mobilePaintNow, mobileRowStamp, worklistRowStatus } from '../lib/work-sections'
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

/** A row paints only the addressed pool projection. Gesture targets are read
 * from the same reader at the moment of the press. */
export interface WorkListRowProps {
  row: WorklistIssue | WorklistWorktree
  onTuck?: () => void
  navPending: boolean
  onOpen: () => void
  onLongPress: () => void
}

export const WorkRow = observer(function WorkRow({
  row,
  onTuck,
  navPending,
  onOpen,
  onLongPress,
}: WorkListRowProps) {
  const navLoader = useDelayedFlag(navPending, NAV_LOADER_DELAY_MS)
  if (typeof row.ready === 'symbol') return <View accessibilityLabel="Loading work" />
  if (!row.ready) return null
  const isIssue = 'issue' in row
  const issue = isIssue ? row.issue : undefined
  const ref = issue ? issueDisplayRef(issue) : null
  const issueColor = issue?.color
  const internal = issue?.audience === 'agent'
  const pinned = issue?.pinned === true
  const label = row.title
  const progressValue = isIssue ? row.progress : null
  const progress = progressValue && typeof progressValue !== 'symbol' && progressValue.total >= 2 ? progressValue : null
  const originSeq = isIssue ? row.origin?.seq ?? null : null
  const statusLine = worklistRowStatus(row, mobilePaintNow(row.worklist.pool))
  const stamp = mobileRowStamp(row.timing, mobilePaintNow(row.worklist.pool))
  const snoozed = issue?.deferred === true
  const unsnoozed = isIssue && row.returnedFromDefer
  const hex = isIssue ? issueColorHex(issueColor) : undefined
  const rowBg = hex ? flow.rowBg(hex) : color.engraved
  const phase = row.timing.phase, working = row.visibleWorking, waiting = row.waitingCount
  const decision = isIssue ? row.decision : null
  const unread = isIssue ? row.emphasizeUnread : row.visibleUnread
  const draftOnly = isIssue && row.sessionOnlyDraft
  const attention = waiting > 0

  return (
    <View
      style={[
        rowStyles.row,
        attention ? rowStyles.rowAttention : hex ? { backgroundColor: rowBg } : null,
        phase === 'queued' && rowStyles.rowQueued,
        phase === 'done' && !onTuck && rowStyles.rowDone,
        internal && rowStyles.rowInternal,
      ]}
    >
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={isIssue ? `${ref} ${label}` : `Worktree ${label}`}
        onPress={onOpen}
        onLongPress={isIssue ? onLongPress : undefined}
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
            {internal ? <Text style={rowStyles.internal}>internal</Text> : null}
            {snoozed ? <Icon as={AlarmClock} size={10} color={color.textMicro} /> : null}
            {unsnoozed ? <Text style={rowStyles.unsnoozed}>Unsnoozed</Text> : null}
          </View>
          <View style={rowStyles.rowStatusLine}>
            {isIssue ? <NotSavedMark kind="issue" id={row.id} /> : null}
            {isIssue ? <Text style={rowStyles.rowRef}>{ref}</Text> : null}
            {attention ? <Text style={rowStyles.rowWaitCount}>{waiting}</Text> : null}
            {pinned ? <Icon as={Pin} size={9} color={color.textMicro} /> : null}
            {draftOnly ? null : <FleetSummary display={row.visibleFleet} />}
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
            {isIssue ? <GitStampLine branch={issue?.branch} git={issue?.gitState as IssueGitState | undefined} suppressAhead={decision === 'merge'} /> : null}
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
      {attention && isIssue ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${decision ? 'Review' : 'Answer'} ${ref}`}
          onPress={onOpen}
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

export const PoolWorkRowSlot = memo(
  observer(function PoolWorkRowSlot({
    item,
    onTuck,
    ...callbacks
  }: {
    item: MobileWorkRef
    navPending: boolean
    onOpenIssue: (issue: IssueNavigationModel) => void
    onOpenSession: (sessionId: SessionId, rowKey: string) => void
    onLongPress: (issue: IssueNavigationModel) => void
    onTuck: (id: string) => void
  }) {
    const pool = useMobilePool()
    const context = useWorklistModel()
    const model = context ?? (pool ? worklistView(pool) : null)
    const entity = pool && item.kind === 'worktree' ? pool.model('worktree', item.id) : undefined
    const row = item.kind === 'issue' ? model?.knownRow(item.id) : entity ? model?.tree(entity) : undefined
    const value = row?.ready
    const reader = pool ? mobileWorkView(pool) : undefined
    const tuck = useCallback(() => onTuck(item.id), [item.id, onTuck])
    const openRow = useCallback(() => {
      const current = reader?.mobileRow({ id: item.id, kind: item.kind })
      if (!current || typeof current === 'symbol' || !current.navigation) return
      if (current.navigation.kind === 'session')
        callbacks.onOpenSession(current.navigation.id as SessionId, item.id)
      else if ('issue' in current) callbacks.onOpenIssue(current.issue as unknown as IssueNavigationModel)
    }, [callbacks.onOpenIssue, callbacks.onOpenSession, item.id, item.kind, reader])
    const longPress = useCallback(() => {
      const current = reader?.mobileRow({ id: item.id, kind: item.kind })
      if (current && typeof current !== 'symbol' && 'issue' in current)
        callbacks.onLongPress(current.issue as unknown as IssueNavigationModel)
    }, [callbacks.onLongPress, item.id, item.kind, reader])
    if (!pool || typeof value === 'symbol') return <View accessibilityLabel="Loading work" />
    if (!row || !value) return null
    return (
      <WorkRow
        row={row}
        navPending={callbacks.navPending}
        onOpen={openRow}
        onLongPress={longPress}
        onTuck={'issue' in row && row.canTuck ? tuck : undefined}
      />
    )
  }),
  (a, b) =>
    a.item.id === b.item.id &&
    a.item.kind === b.item.kind &&
    a.item.listKey === b.item.listKey &&
    a.navPending === b.navPending &&
    a.onTuck === b.onTuck &&
    a.onOpenIssue === b.onOpenIssue &&
    a.onOpenSession === b.onOpenSession &&
    a.onLongPress === b.onLongPress,
)
