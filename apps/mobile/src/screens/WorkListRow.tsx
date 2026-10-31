/** The desktop's calm two-line row, with touch targets for the phone web app. */

import { relativeTime } from '@podium/client-core/focus'
import type { IssueNavigationModel } from '@podium/client-core/values'
import { useWorklistModel } from '@podium/client-graph/react'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import type { MobileWorkRef } from '@podium/client-graph/worklist/mobile'
import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
import type { PhoneWorkLane } from '@podium/client-graph/worklist/phone'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import type { RowTone } from '@podium/client-graph/worklist/voice'
import type { SessionId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { observer } from 'mobx-react-lite'
import { memo, useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import { NotSavedMark } from '../components/NotSavedMark'
import { PressableScale } from '../components/PressableScale'
import { WorkingMark } from '../components/WorkingMark'
import { useAgeNow } from '../lib/clock-hooks'
import { mobileRowStamp } from '../lib/work-sections'
import { alpha } from '../theme/mix'
import { color, mono, sans } from '../theme/theme'
import { workRowMenuEvents } from './work-row-menu-events'

export const NAV_LOADER_DELAY_MS = 150
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

export interface WorkListRowProps {
  row: WorklistIssue
  lane?: PhoneWorkLane
  onTuck?: () => void
  navPending: boolean
  onOpen: () => void
  onLongPress: () => void
}

export const WorkRow = observer(function WorkRow({
  row,
  lane = 'open',
  navPending,
  onOpen,
  onLongPress,
}: WorkListRowProps) {
  const navLoader = useDelayedFlag(navPending, NAV_LOADER_DELAY_MS)
  if (typeof row.ready === 'symbol') return <View accessibilityLabel="Loading work" />
  if (row.ready !== 'ready') return null
  const ref = issueDisplayRef(row.issue)
  const voice = row.voice
  const word =
    lane === 'snoozed'
      ? row.snoozeLabel
      : lane === 'closed'
        ? voice.word === 'Landed'
          ? 'Landed'
          : 'Closed'
        : voice.word
  const tone =
    lane === 'snoozed'
      ? 'idle'
      : lane === 'closed'
        ? word === 'Landed'
          ? 'done'
          : 'closed'
        : voice.tone
  const unread = row.emphasizeUnread
  return (
    <PressableScale
      {...workRowMenuEvents(onLongPress)}
      accessibilityRole="button"
      accessibilityLabel={`${ref} ${row.title}`}
      accessibilityValue={{ text: `${word}${unread ? ' · Unread' : ''}` }}
      accessibilityHint="Open task. Long press for actions."
      onPress={onOpen}
      onLongPress={onLongPress}
      delayLongPress={450}
      scaleTo={1}
      style={({ pressed }) => [
        rowStyles.row,
        row.selected && rowStyles.selected,
        pressed && rowStyles.pressed,
      ]}
    >
      <View style={rowStyles.titleLine}>
        <Text
          style={[
            rowStyles.title,
            unread && rowStyles.unread,
            lane === 'closed' && rowStyles.closed,
          ]}
          numberOfLines={1}
        >
          {row.title}
        </Text>
        {unread ? <View style={rowStyles.unreadDot} /> : null}
        {navLoader ? (
          <ActivityIndicator accessibilityLabel="Opening" size="small" color={color.textDim} />
        ) : (
          <WorkStamp row={row} lane={lane} />
        )}
      </View>
      <View style={rowStyles.statusLine}>
        <StatusMark tone={tone} />
        <Text
          style={[
            rowStyles.status,
            tone === 'needs' && rowStyles.needs,
            tone === 'error' && rowStyles.error,
          ]}
          numberOfLines={1}
        >
          {word}
        </Text>
        {lane === 'open' && voice.sub ? (
          <Text style={rowStyles.fact} numberOfLines={1}>
            {voice.sub}
          </Text>
        ) : null}
        <NotSavedMark kind="issue" id={row.id} />
        <View style={rowStyles.spacer} />
        <Text style={rowStyles.ref}>{ref}</Text>
      </View>
    </PressableScale>
  )
})

export function StatusMark({ tone }: { tone: RowTone }) {
  if (tone === 'working') return <WorkingMark size={10} />
  if (tone === 'done' || tone === 'closed')
    return (
      <Text
        accessibilityElementsHidden
        style={[rowStyles.markText, tone === 'done' && rowStyles.blue]}
      >
        {tone === 'done' ? '✓' : '−'}
      </Text>
    )
  return (
    <View
      accessibilityElementsHidden
      style={[
        rowStyles.mark,
        tone === 'active' && rowStyles.activeMark,
        tone === 'needs' && rowStyles.needsMark,
        tone === 'error' && rowStyles.errorMark,
        tone === 'settled' && rowStyles.settledMark,
        tone === 'draft' && rowStyles.draftMark,
      ]}
    />
  )
}

const rowStyles = StyleSheet.create({
  row: {
    minHeight: 56,
    paddingLeft: 32,
    paddingRight: 16,
    paddingVertical: 10,
    gap: 5,
    backgroundColor: color.bgSunken,
  },
  selected: { backgroundColor: alpha(color.body, 0.045) },
  pressed: { backgroundColor: alpha(color.body, 0.07) },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { ...sans(400), flex: 1, minWidth: 0, color: color.body, fontSize: 15 },
  unread: { ...sans(600) },
  closed: { color: color.textFaint },
  unreadDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: color.info },
  statusLine: { flexDirection: 'row', alignItems: 'center', minWidth: 0, gap: 5 },
  status: { ...sans(400), flexShrink: 1, color: color.textDim, fontSize: 12 },
  needs: { color: color.needsYouText },
  error: { color: color.dangerText },
  fact: { ...sans(400), color: color.textFaint, fontSize: 11, flexShrink: 1 },
  spacer: { flex: 1 },
  ref: { ...mono(400), color: color.textMicro, fontSize: 10 },
  stamp: { ...mono(400), color: color.textFaint, fontSize: 10 },
  workingStamp: { color: color.workingText },
  mark: { width: 6, height: 6, borderRadius: 3, borderWidth: 1, borderColor: color.textMicro },
  activeMark: { borderColor: color.workingText },
  needsMark: { backgroundColor: color.needsYouText, borderColor: color.needsYouText },
  errorMark: { backgroundColor: color.dangerText, borderColor: color.dangerText },
  settledMark: { backgroundColor: color.textFaint, borderColor: color.textFaint },
  draftMark: { borderStyle: 'dashed' },
  markText: { width: 9, fontSize: 10, color: color.textMicro, lineHeight: 12 },
  blue: { color: color.info },
})

export const PoolWorkRowSlot = memo(
  observer(function PoolWorkRowSlot({
    item,
    onTuck,
    lane = 'open',
    ...callbacks
  }: {
    item: MobileWorkRef
    lane?: PhoneWorkLane
    navPending: boolean
    onOpenIssue: (issue: IssueNavigationModel) => void
    onOpenSession: (sessionId: SessionId, rowKey: string) => void
    onLongPress: (issue: IssueNavigationModel, lane?: 'live' | 'snoozed' | 'closed') => void
    onTuck: (id: string) => void
  }) {
    const pool = useMobilePool()
    const context = useWorklistModel()
    const model = context ?? (pool ? worklistView(pool) : null)
    const row = model?.knownRow(item.id)
    const value = row?.ready
    const reader = pool ? mobileWorkView(pool) : undefined
    const tuck = useCallback(() => onTuck(item.id), [item.id, onTuck])
    const openRow = useCallback(() => {
      const current = reader?.mobileRow(item.id)
      if (!current || typeof current === 'symbol') return
      if (current.navigation.kind === 'session')
        callbacks.onOpenSession(current.navigation.id as SessionId, item.id)
      else callbacks.onOpenIssue(current.issue as unknown as IssueNavigationModel)
    }, [callbacks.onOpenIssue, callbacks.onOpenSession, item.id, reader])
    const longPress = useCallback(() => {
      const current = reader?.mobileRow(item.id)
      if (current && typeof current !== 'symbol')
        callbacks.onLongPress(
          current.issue as unknown as IssueNavigationModel,
          lane === 'open' ? 'live' : lane,
        )
    }, [callbacks.onLongPress, item.id, lane, reader])
    if (!pool || typeof value === 'symbol') return <View accessibilityLabel="Loading work" />
    if (!row || !value) return null
    return (
      <WorkRow
        row={row}
        lane={lane}
        navPending={callbacks.navPending}
        onOpen={openRow}
        onLongPress={longPress}
        onTuck={row.canTuck ? tuck : undefined}
      />
    )
  }),
  (a, b) =>
    a.lane === b.lane &&
    a.item.id === b.item.id &&
    a.item.listKey === b.item.listKey &&
    a.navPending === b.navPending &&
    a.onTuck === b.onTuck &&
    a.onOpenIssue === b.onOpenIssue &&
    a.onOpenSession === b.onOpenSession &&
    a.onLongPress === b.onLongPress,
)

const WorkStamp = observer(function WorkStamp({
  row,
  lane,
}: {
  row: WorklistIssue
  lane: PhoneWorkLane
}) {
  const timing = row.timing
  const updated =
    lane === 'closed'
      ? (row.issue.tuckedAt ?? row.issue.closedAt ?? row.issue.updatedAt)
      : row.issue.updatedAt
  const age = Date.parse(updated)
  const live = lane === 'open' && (timing.phase === 'working' || timing.phase === 'waiting')
  const now = useAgeNow(live ? timing.sinceMs : age, live ? (timing.baseMs ?? 0) : 0)
  const stamp = (live ? mobileRowStamp(timing, now) : relativeTime(updated, now))
    ?.replace(/ ago$/, '')
    .replace('just now', 'now')
  return stamp ? (
    <Text
      style={[rowStyles.stamp, live && timing.phase === 'working' && rowStyles.workingStamp]}
      numberOfLines={1}
    >
      {stamp}
    </Text>
  ) : null
})
