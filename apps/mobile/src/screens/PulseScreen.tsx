import {
  capacityView,
  gatingQuotaRows,
  // Pure filters despite the `use` prefix; aliased so they can run in a memo.
  useGrantedHostMetrics as grantedHostMetrics,
  useGrantedMachineQuota as grantedMachineQuota,
  groupQuotaByAccount,
  usageSummary,
  visibleFleetOperations,
} from '@podium/client-core/values'
import { createPulseView } from '@podium/client-graph/pulse-view'
import { useOpeningView } from '@podium/client-graph/react'
import { router } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useCallback, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { DEMO_HOST_METRICS, DEMO_MACHINES, demoEnabled } from '../client/demoData'
import { useMobilePool } from '../client/mobile-pool'
import { usePulseLive } from '../client/use-inbox-data'
import { NativePicker } from '../components/action-sheet-native'
import { Icon } from '../components/Icon'
import { ChevronDown } from '../components/icons'
import { SectionHeader } from '../components/instruments'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { Screen } from '../components/Screen'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { useBuildStamp } from '../lib/build-stamp'
import { color, font, sans, space } from '../theme/theme'
import { Machines, PulseBody } from './PulseBody'
import {
  PULSE_RANGES,
  type PulseRange,
  pulseHero,
  pulseSubtitle,
  quotaVerdict,
  rangeLabel,
  rangeShort,
} from './pulse-view'
import { type PulseFeed, usePulseFeed } from './usePulseFeed'

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
  const pool = useMobilePool()
  const pulse = useOpeningView(pool, createPulseView)
  const costs = pulse?.costs
  const feed = usePulseFeed(pulse)
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

  const cold = feed.buckets === null
  const summary = pulse?.summary ?? EMPTY_SUMMARY
  const hero = useMemo(() => pulseHero(summary, range), [summary, range])
  const models = pulse?.models ?? NO_MODELS
  const grantedQuota = useMemo(
    () => grantedMachineQuota(feed.machines, feed.quota ?? []),
    [feed.machines, feed.quota],
  )
  const quota = useMemo(
    () => gatingQuotaRows(groupQuotaByAccount(grantedQuota), feed.nowMs),
    [grantedQuota, feed.nowMs],
  )
  const projects = pulse?.projects ?? null
  const quotaHeader = useCallback(
    (open: boolean, onToggle: () => void) => (
      <LiveQuotaHeader feed={feed} open={open} onToggle={onToggle} />
    ),
    [feed],
  )
  const machinesSection = useCallback(
    (open: boolean, onToggle: () => void) => (
      <LiveMachines feed={feed} open={open} onToggle={onToggle} />
    ),
    [feed],
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
            verdict={null}
            quotaHeader={quotaHeader}
            projects={projects}
            tasks={tasks}
            tasksCold={costs?.answer === undefined}
            models={models}
            fleet={EMPTY_FLEET}
            machinesSection={machinesSection}
            pool={pool}
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

// Host samples subscribe only at the two regions that display them.
function useHostReadings() {
  const live = usePulseLive()
  const machines = demoEnabled() ? DEMO_MACHINES : live.machines
  const hosts = demoEnabled() ? DEMO_HOST_METRICS : live.hosts
  return { machines, hosts: grantedHostMetrics(machines, hosts) }
}

function LiveQuotaHeader({
  feed,
  open,
  onToggle,
}: {
  feed: PulseFeed
  open: boolean
  onToggle: () => void
}) {
  const { machines, hosts } = useHostReadings()
  const verdict =
    feed.quota === null
      ? null
      : quotaVerdict(
          capacityView({
            machines: grantedMachineQuota(machines, feed.quota),
            hosts,
            loadPerCore: feed.loadPerCore,
            nowMs: feed.nowMs,
          }),
        )
  return (
    <SectionHeader
      title="Quota"
      open={open}
      onToggle={onToggle}
      trailing={verdict?.text}
      trailingSignal={verdict?.signal}
    />
  )
}

function LiveMachines({
  feed,
  open,
  onToggle,
}: {
  feed: PulseFeed
  open: boolean
  onToggle: () => void
}) {
  const { machines, hosts } = useHostReadings()
  const fleet = visibleFleetOperations({
    machines,
    hosts,
    capacityReadings: feed.capacityReadings,
    loadPerCore: feed.loadPerCore,
    nowMs: feed.nowMs,
  })
  return (
    <>
      <SectionHeader
        title="Machines"
        open={open}
        onToggle={onToggle}
        trailing={fleet.machines.length > 0 ? fleet.fleetLabel : undefined}
      />
      {open ? <Machines fleet={fleet} /> : null}
    </>
  )
}

const EMPTY_FLEET = visibleFleetOperations({
  machines: [],
  hosts: [],
  capacityReadings: {},
  loadPerCore: null,
  nowMs: 0,
})

const NO_TASKS: never[] = []
const NO_MODELS: never[] = []
const EMPTY_SUMMARY = { ...usageSummary([], 0), days: [] }

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
