import {
  capacityView,
  gatingQuotaRows,
  // Pure filters despite the `use` prefix; aliased so they can run in a memo.
  useGrantedHostMetrics as grantedHostMetrics,
  useGrantedMachineQuota as grantedMachineQuota,
  groupQuotaByAccount,
  modelShares,
  projectCostShares,
  usageSummary,
  visibleFleetOperations,
} from '@podium/client-core/values'
import { useOpeningView } from '@podium/client-graph/react'
import { createTaskCostView } from '@podium/client-graph/task-cost-view'
import { router } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
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
  PULSE_RANGES,
  type PulseRange,
  pulseHero,
  pulseSubtitle,
  quotaVerdict,
  rangeLabel,
  rangeShort,
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
 * The Quota header carries client-core's capacity headline, which never reads
 * "Room to run" while a provider is out; Top projects groups the same priced
 * `cost.tasks` rows by each issue's repository, read off the pool's issue
 * model [POD-2385].
 *
 * TASK COSTS ARE A SHARED REQUEST ANSWER (`TaskCostView`, client-graph): the
 * view owns the `cost.tasks` answer for as long as the tab is open, fences
 * overlapping polls, and caches the pricing, the ranking and the project
 * grouping as separate fields. Each region below is its own memo over only
 * its inputs, so a streamed host-metric update rebuilds the machine card and
 * the verdict and never reprices a task.
 */

export const PulseScreen = observer(function PulseScreen() {
  const costs = useOpeningView(useMobilePool(), createTaskCostView)
  const feed = usePulseFeed(costs)
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
  const summary = useMemo(
    () => usageSummary(feed.buckets ?? [], feed.nowMs),
    [feed.buckets, feed.nowMs],
  )
  const hero = useMemo(() => pulseHero(summary, range), [summary, range])
  const models = useMemo(() => modelShares(summary, 6), [summary])
  const grantedQuota = useMemo(
    () => grantedMachineQuota(feed.machines, feed.quota ?? []),
    [feed.machines, feed.quota],
  )
  const grantedHosts = useMemo(
    () => grantedHostMetrics(feed.machines, feed.hosts),
    [feed.machines, feed.hosts],
  )
  const quota = useMemo(
    () => gatingQuotaRows(groupQuotaByAccount(grantedQuota), feed.nowMs),
    [grantedQuota, feed.nowMs],
  )
  const verdict = useMemo(
    () =>
      feed.quota === null
        ? null
        : quotaVerdict(
            capacityView({
              machines: grantedQuota,
              hosts: grantedHosts,
              loadPerCore: feed.loadPerCore,
              nowMs: feed.nowMs,
            }),
          ),
    [feed.quota, grantedQuota, grantedHosts, feed.loadPerCore, feed.nowMs],
  )
  const fleet = useMemo(
    () =>
      visibleFleetOperations({
        machines: feed.machines,
        hosts: grantedHosts,
        capacityReadings: feed.capacityReadings,
        loadPerCore: feed.loadPerCore,
        nowMs: feed.nowMs,
      }),
    [feed.machines, grantedHosts, feed.capacityReadings, feed.loadPerCore, feed.nowMs],
  )
  // The grouping is the view's cached field; only the share against the
  // separately-polled week total is computed here.
  const projectGroups = costs?.projectGroups ?? null
  const weekUsd = summary.week.estCostUsd
  const projects = useMemo(
    () => (projectGroups ? projectCostShares(projectGroups, weekUsd) : null),
    [projectGroups, weekUsd],
  )
  const tasks = costs?.topTasks ?? NO_TASKS
  const onOpenTask = useCallback(
    (issueId: string) => router.push(`/issue/${encodeURIComponent(issueId)}`),
    [],
  )

  return (
    <Screen
      title="Pulse"
      large
      subtitle={cold && feed.failed ? 'No reading' : pulseSubtitle(hero, range, cold)}
      right={<RangeButton range={range} onChange={setRange} />}
    >
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
            summary={summary}
            quota={quota}
            verdict={verdict}
            projects={projects}
            tasks={tasks}
            tasksCold={costs?.answer === undefined}
            models={models}
            fleet={fleet}
            cold={cold}
            failed={cold && feed.failed}
            onRetry={feed.reload}
            onOpenTask={onOpenTask}
            buildStamp={buildStamp.text}
          />
        </ScrollView>
      </PullToRefreshBoundary>
    </Screen>
  )
})

const NO_TASKS: never[] = []

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
