import {
  // Pure filters despite the `use` prefix; aliased so they can run in a memo.
  useGrantedHostMetrics as grantedHostMetrics,
  useGrantedMachineQuota as grantedMachineQuota,
  groupQuotaByAccount,
  usageSummary,
  visibleFleetOperations,
} from '@podium/client-core/values'
import { router } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { NativePicker } from '../components/action-sheet-native'
import { Icon } from '../components/Icon'
import { ChevronDown } from '../components/icons'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { Screen } from '../components/Screen'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { useBuildStamp } from '../lib/build-stamp'
import { color, font, sans, space } from '../theme/theme'
import { PulseBody } from './PulseBody'
import {
  modelRows,
  PULSE_RANGES,
  type PulseRange,
  pulseHero,
  quotaRows,
  rangeLabel,
  rangeShort,
  topTasks,
} from './pulse-view'
import { usePulseFeed } from './usePulseFeed'

/**
 * PULSE — what the agents cost, and what can still run [POD-2379].
 *
 * Built to the redesign's Pulse and PulseMore boards: a cost hero with the
 * hourly trace, then grouped cards for quota, top tasks, models and machines.
 * Every figure is a projection of a read the app already makes — the usage
 * summary, the quota summary, the desktop's `cost.tasks` rows and the machine
 * readings — computed by the same client-core functions the desktop uses.
 *
 * COST IS API-EQUIVALENT. It is what these tokens would cost at list price,
 * not a bill, and the hero says "list price" on the number itself.
 *
 * Two board rows wait on the user's OK and have seams here rather than code:
 * P4 (the verdict reading "out" when a launchable provider window is used up —
 * `QuotaRowView.out` is the input it needs) and P5 (Top projects, which mounts
 * through `PulseBody`'s `projects` slot between Quota and Top tasks).
 */

export function PulseScreen() {
  const feed = usePulseFeed()
  const [range, setRange] = useState<PulseRange>('week')
  const bottomInset = useContentBottomInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()
  const reload = feed.reload
  const buildStamp = useBuildStamp()
  const reloadStamp = buildStamp.reload
  const onPull = useCallback(() => {
    reloadStamp()
    return reload()
  }, [reload, reloadStamp])
  const { listRef, refreshControl, refreshAccessibilityProps, refreshing, onRefresh, connected } =
    useRefreshableTab('pulse', onPull)

  const cold = feed.quota === null && feed.buckets === null
  const derived = useMemo(() => {
    const grantedHosts = grantedHostMetrics(feed.machines, feed.hosts)
    const grantedQuota = grantedMachineQuota(feed.machines, feed.quota ?? [])
    const summary = usageSummary(feed.buckets ?? [], feed.nowMs)
    return {
      summary,
      quota: quotaRows(groupQuotaByAccount(grantedQuota), feed.nowMs),
      tasks: topTasks(feed.taskCosts),
      models: modelRows(summary),
      fleet: visibleFleetOperations({
        machines: feed.machines,
        hosts: grantedHosts,
        capacityReadings: feed.capacityReadings,
        loadPerCore: feed.loadPerCore,
        nowMs: feed.nowMs,
      }),
    }
  }, [
    feed.quota,
    feed.buckets,
    feed.taskCosts,
    feed.hosts,
    feed.machines,
    feed.capacityReadings,
    feed.loadPerCore,
    feed.nowMs,
  ])
  const hero = useMemo(() => pulseHero(derived.summary, range), [derived.summary, range])

  return (
    <Screen title="Pulse" large right={<RangeButton range={range} onChange={setRange} />}>
      <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
        <ScrollView
          ref={listRef as never}
          refreshControl={refreshControl}
          // The native large-title header is translucent and floats over the
          // content. Without this the first rows sat under the status bar and
          // took its taps (POD-2347 "Pulse segments hidden under the status bar").
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + space.lg }]}
          {...refreshAccessibilityProps}
          {...minimizeOnScroll}
        >
          <PulseBody
            range={range}
            hero={hero}
            summary={derived.summary}
            quota={derived.quota}
            tasks={derived.tasks}
            tasksCold={feed.taskCosts === null}
            models={derived.models}
            fleet={derived.fleet}
            cold={cold}
            failed={cold && feed.failed}
            onRetry={feed.reload}
            onOpenTask={(issueId) => router.push(`/issue/${encodeURIComponent(issueId)}`)}
            buildStamp={buildStamp.text}
          />
        </ScrollView>
      </PullToRefreshBoundary>
    </Screen>
  )
}

// ---------------------------------------------------------------------------
// Range button
// ---------------------------------------------------------------------------

/**
 * "7 days ⌄" on the title row. On iOS a real UIMenu with a checked picker; on
 * web and Android, where the native menu does not exist, a tap flips between
 * the only two windows there are.
 */
function RangeButton({
  range,
  onChange,
}: {
  range: PulseRange
  onChange: (range: PulseRange) => void
}) {
  return (
    <NativePicker
      label="Range"
      options={PULSE_RANGES.map((r) => ({ value: r.value, label: r.label }))}
      selected={range}
      onSelect={(value) => onChange(value as PulseRange)}
      onOpenFallback={() => onChange(range === 'week' ? 'fiveHour' : 'week')}
    >
      {(onPress) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Range: ${rangeLabel(range)}`}
          onPress={onPress}
          style={styles.rangeButton}
        >
          <Text style={styles.rangeText}>{rangeShort(range)}</Text>
          <Icon as={ChevronDown} size={11} color={color.text} />
        </Pressable>
      )}
    </NativePicker>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
  },
  rangeButton: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  rangeText: {
    ...sans(400),
    color: color.text,
    fontSize: font.small,
  },
})
