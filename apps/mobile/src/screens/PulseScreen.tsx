import {
  capacityView,
  // Pure filters despite the `use` prefix; aliased so they can run in a memo.
  useGrantedHostMetrics as grantedHostMetrics,
  useGrantedMachineQuota as grantedMachineQuota,
  groupQuotaByAccount,
  issueRepoName,
  projectCostRows,
  usageSummary,
  visibleFleetOperations,
} from '@podium/client-core/values'
import { readPageIssue } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph/pool'
import type { TaskCostRowWire } from '@podium/model'
import { router } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { useMobilePoolProjection } from '../client/mobile-pool'
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
  pulseSubtitle,
  quotaRows,
  quotaVerdict,
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
 * The Quota header carries client-core's capacity headline, which never reads
 * "Room to run" while a provider is out; Top projects groups the same priced
 * `cost.tasks` rows by each issue's repository, read off the pool's issue
 * model (`projectCostRows`, shared with the desktop) [POD-2385].
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
  const taskProjects = useTaskProjects(feed.taskCosts)
  const derived = useMemo(() => {
    const grantedHosts = grantedHostMetrics(feed.machines, feed.hosts)
    const grantedQuota = grantedMachineQuota(feed.machines, feed.quota ?? [])
    const summary = usageSummary(feed.buckets ?? [], feed.nowMs)
    return {
      summary,
      quota: quotaRows(groupQuotaByAccount(grantedQuota), feed.nowMs),
      verdict:
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
      projects: feed.taskCosts
        ? projectCostRows(
            feed.taskCosts,
            (issueId) => taskProjects[issueId],
            summary.week.estCostUsd,
          )
        : null,
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
    taskProjects,
  ])
  const hero = useMemo(() => pulseHero(derived.summary, range), [derived.summary, range])

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
            summary={derived.summary}
            quota={derived.quota}
            verdict={derived.verdict}
            projects={derived.projects}
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

const NO_PROJECTS: Readonly<Record<string, string>> = {}

/**
 * Each priced task's project, read off the pool's shared issue model
 * (`repoName`, the same field the task screen prints). Only tasks with spend in
 * the window are looked up: they are the only ones `projectCostRows` groups. An
 * issue still loading, or one this principal cannot see, has no entry and so
 * stays unattributed until it does.
 */
function useTaskProjects(rows: readonly TaskCostRowWire[] | null) {
  const read = useCallback(
    (pool: MobxPool) => {
      if (!rows) return NO_PROJECTS
      const names: Record<string, string> = {}
      for (const row of rows) {
        if (row.windowModels.length === 0) continue
        const issue = readPageIssue(pool, row.issueId)
        if (!issue || typeof issue === 'symbol') continue
        const name = issueRepoName(issue)
        if (name) names[row.issueId] = name
      }
      return names
    },
    [rows],
  )
  return useMobilePoolProjection(read, NO_PROJECTS)
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
