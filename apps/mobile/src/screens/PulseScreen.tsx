import {
  formatUsd,
  // Pure filters despite the `use` prefix; aliased so they can run in a memo.
  useGrantedHostMetrics as grantedHostMetrics,
  useGrantedMachineQuota as grantedMachineQuota,
  groupQuotaByAccount,
  type MachineOperationsView,
  type TaskCostRowView,
  type UsageSummaryView,
  usageSummary,
  visibleFleetOperations,
} from '@podium/client-core/values'
import { issueDisplayRef } from '@podium/protocol'
import { router } from 'expo-router'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { NativePicker } from '../components/action-sheet-native'
import { Icon } from '../components/Icon'
import { ChevronDown } from '../components/icons'
import {
  CARD_INSET,
  Card,
  HourTrace,
  Meter,
  type MeterTone,
  rowDivider,
  SectionHeader,
} from '../components/instruments'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { Screen } from '../components/Screen'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { useBuildStamp } from '../lib/build-stamp'
import { color, font, mono, sans, space } from '../theme/theme'
import {
  formatPercent,
  type ModelRowView,
  modelRows,
  PULSE_RANGES,
  type PulseHero,
  type PulseRange,
  pulseHero,
  type QuotaRowView,
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

// ---------------------------------------------------------------------------
// Body — presentational, so harnesses and tests can render it from fixtures
// ---------------------------------------------------------------------------

type Fleet = ReturnType<typeof visibleFleetOperations>
type SectionKey = 'quota' | 'projects' | 'tasks' | 'models' | 'machines'

export interface PulseBodyProps {
  range: PulseRange
  hero: PulseHero
  summary: UsageSummaryView
  quota: QuotaRowView[]
  tasks: TaskCostRowView[]
  tasksCold: boolean
  models: ModelRowView[]
  fleet: Fleet
  cold: boolean
  /** Cold AND the last read failed: nothing truthful to draw. */
  failed: boolean
  onRetry: () => void
  onOpenTask: (issueId: string) => void
  buildStamp: string
  /** P5 seam: the Top projects section, once the user approves its rule. */
  projects?: ReactNode
}

export function PulseBody(props: PulseBodyProps) {
  const { range, hero, summary, cold } = props
  const [closed, setClosed] = useState<ReadonlySet<SectionKey>>(new Set())
  const toggle = (key: SectionKey) =>
    setClosed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const open = (key: SectionKey) => !closed.has(key)
  // Quota, tasks and models have no five-hour reading; say which window they are.
  const weekNote = range === 'fiveHour' ? 'Last 7 days' : undefined

  if (props.failed) {
    return (
      <View style={styles.page}>
        <Text style={styles.subtitle}>No reading</Text>
        <Card>
          <View style={styles.message}>
            <Text style={styles.messageText}>
              Couldn’t reach the daemon for usage or quota. Pull down to try again.
            </Text>
            <Pressable accessibilityRole="button" onPress={props.onRetry} hitSlop={8}>
              <Text style={styles.retry}>Try Again</Text>
            </Pressable>
          </View>
        </Card>
      </View>
    )
  }

  return (
    <View style={styles.page}>
      {/* The large title's subtitle line (Music, Podcasts). It scrolls with the
          content until the Shell task's header carries an inline subtitle. */}
      <Text style={styles.subtitle} numberOfLines={1}>
        {cold
          ? 'Taking a reading…'
          : `${formatUsd(hero.costUsd)} in the ${rangeLabel(range).toLowerCase()}`}
      </Text>

      <Card>
        <HeroBlock hero={hero} cold={cold} />
        <View style={styles.stats}>
          <Stat
            label="Per active day"
            value={
              cold || summary.costPerActiveDayUsd === null
                ? '—'
                : formatUsd(summary.costPerActiveDayUsd)
            }
          />
          {range === 'week' ? (
            <Stat
              label="Last 5 hours"
              value={cold ? '—' : formatUsd(summary.fiveHour.estCostUsd)}
            />
          ) : (
            <Stat label="Last 7 days" value={cold ? '—' : formatUsd(summary.week.estCostUsd)} />
          )}
          <Stat label="Cache saved" value={cold ? '—' : formatUsd(summary.cacheSavingsUsd)} />
        </View>
      </Card>

      <SectionHeader title="Quota" open={open('quota')} onToggle={() => toggle('quota')} />
      {open('quota') ? (
        <Card>
          {props.quota.length === 0 ? (
            <Message
              text={
                cold
                  ? 'Reading quota…'
                  : 'No machine is signed in to a provider that reports plan limits.'
              }
            />
          ) : (
            props.quota.map((row, i) => <QuotaRow key={row.key} row={row} first={i === 0} />)
          )}
        </Card>
      ) : null}

      {props.projects}

      <SectionHeader
        title="Top tasks"
        open={open('tasks')}
        onToggle={() => toggle('tasks')}
        trailing={weekNote}
      />
      {open('tasks') ? (
        <Card>
          {props.tasks.length === 0 ? (
            <Message
              text={props.tasksCold ? 'Reading task costs…' : 'No task spent anything this week.'}
            />
          ) : (
            props.tasks.map((task, i) => (
              <TaskRow
                key={task.issueId}
                task={task}
                first={i === 0}
                onPress={() => props.onOpenTask(task.issueId)}
              />
            ))
          )}
        </Card>
      ) : null}

      <SectionHeader
        title="Models"
        open={open('models')}
        onToggle={() => toggle('models')}
        trailing={weekNote}
      />
      {open('models') ? (
        <Card>
          {props.models.length === 0 ? (
            <Message
              text={cold ? 'Reading usage…' : 'No harness transcripts in the last seven days.'}
            />
          ) : (
            props.models.map((model, i) => (
              <ModelRow key={model.model} model={model} first={i === 0} />
            ))
          )}
        </Card>
      ) : null}

      <SectionHeader
        title="Machines"
        open={open('machines')}
        onToggle={() => toggle('machines')}
        trailing={props.fleet.machines.length > 0 ? props.fleet.fleetLabel : undefined}
      />
      {open('machines') ? <Machines fleet={props.fleet} /> : null}

      <Text style={styles.foot}>
        Public list prices per model. Cost a subscription covers is shown as if billed by the API.
        {summary.unpricedModels.length === 1
          ? ` ${summary.unpricedModels[0]} has no price on file and uses the fallback rate.`
          : summary.unpricedModels.length > 1
            ? ` ${summary.unpricedModels.length} models have no price on file and use the fallback rate.`
            : ''}
      </Text>
      {/* Which server, and what both ends run (POD-2006). Quiet, last. */}
      <Text style={styles.buildStamp} selectable numberOfLines={3}>
        {props.buildStamp}
      </Text>
    </View>
  )
}

/** Whole dollars under the trace: seven columns at 11pt have no room for cents. */
function compactUsd(n: number): string {
  if (n <= 0) return '$0'
  if (n < 10) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function HeroBlock({ hero, cold }: { hero: PulseHero; cold: boolean }) {
  const daysLabel = hero.days.map((d) => `${d.weekday} ${compactUsd(d.costUsd)}`).join(', ')
  return (
    <View style={styles.hero}>
      <Text style={styles.heroKey}>API-equivalent cost · {hero.spanLabel}</Text>
      <Text style={styles.heroValue}>
        {cold ? '—' : formatUsd(hero.costUsd)}
        <Text style={styles.heroUnit}> list price</Text>
      </Text>
      <HourTrace
        slots={hero.slots}
        dayEvery={hero.days.length > 0 ? 24 : undefined}
        label={
          hero.days.length > 0
            ? `Hourly cost over the last seven days. ${daysLabel}`
            : 'Hourly cost over the last five hours'
        }
      />
      {hero.days.length > 0 ? (
        <View style={styles.days} accessibilityElementsHidden importantForAccessibility="no">
          {hero.days.map((day) => (
            <View key={day.key} style={styles.day}>
              <Text style={styles.dayName}>{day.weekday}</Text>
              <Text style={styles.dayCost}>{cold ? '—' : compactUsd(day.costUsd)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

function Message({ text }: { text: string }) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>{text}</Text>
    </View>
  )
}

function QuotaRow({ row, first }: { row: QuotaRowView; first: boolean }) {
  const readable = row.usedPercent !== null
  return (
    <View style={[styles.quota, !first && rowDivider]}>
      <View style={styles.line}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {row.title}
        </Text>
        {readable ? (
          <Text style={[styles.rowFigure, row.out && styles.signal]}>
            {row.out ? 'Out' : formatPercent(row.usedPercent ?? 0)}
          </Text>
        ) : null}
      </View>
      {readable ? (
        <Meter
          pct={row.usedPercent ?? 0}
          tone={row.out ? 'signal' : 'ink'}
          marker={row.elapsedPercent}
        />
      ) : null}
      <View style={styles.line}>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {row.paceText}
        </Text>
        {row.resetText ? <Text style={styles.rowMeta}>{row.resetText}</Text> : null}
      </View>
      {row.modelNote ? <Text style={styles.rowMeta}>{row.modelNote}</Text> : null}
    </View>
  )
}

function TaskRow({
  task,
  first,
  onPress,
}: {
  task: TaskCostRowView
  first: boolean
  onPress: () => void
}) {
  const ref = issueDisplayRef(task)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ref} ${task.title}, ${formatUsd(task.windowCostUsd)}`}
      onPress={onPress}
      style={({ pressed }) => [styles.task, !first && rowDivider, pressed && styles.pressed]}
    >
      <Text style={styles.taskRef} numberOfLines={1}>
        {ref}
      </Text>
      <Text style={styles.taskTitle} numberOfLines={1}>
        {task.title}
      </Text>
      <Text style={styles.taskCost}>{formatUsd(task.windowCostUsd)}</Text>
    </Pressable>
  )
}

function ModelRow({ model, first }: { model: ModelRowView; first: boolean }) {
  return (
    <View style={[styles.share, !first && rowDivider]}>
      <View style={styles.line}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {model.model}
        </Text>
        <Text style={styles.rowFigure}>{formatUsd(model.costUsd)}</Text>
      </View>
      <Meter pct={model.barPercent} muted />
      <View style={styles.line}>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {model.provider} · {model.messages.toLocaleString('en-US')}{' '}
          {model.messages === 1 ? 'reply' : 'replies'}
        </Text>
        <Text style={[styles.rowMeta, styles.mono]}>{formatPercent(model.sharePercent)}</Text>
      </View>
    </View>
  )
}

const SEVERITY_TONE: Record<'ok' | 'warn' | 'critical', MeterTone> = {
  ok: 'ink',
  warn: 'signal',
  critical: 'crit',
}

const PREVIEW_MACHINES = 12

function Machines({ fleet }: { fleet: Fleet }) {
  const [visible, setVisible] = useState(PREVIEW_MACHINES)
  if (fleet.machines.length === 0) {
    return (
      <Card>
        <Message text="Machines appear here when this account can see a fleet member." />
      </Card>
    )
  }
  const shown = fleet.machines.slice(0, visible)
  const remaining = fleet.machines.length - shown.length
  return (
    <Card>
      {shown.map((machine, i) => (
        <MachineRow key={machine.id} machine={machine} first={i === 0} />
      ))}
      {remaining > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setVisible((n) => n + PREVIEW_MACHINES)}
          style={({ pressed }) => [styles.more, rowDivider, pressed && styles.pressed]}
        >
          <Text style={styles.moreText}>Show {Math.min(PREVIEW_MACHINES, remaining)} More</Text>
        </Pressable>
      ) : null}
    </Card>
  )
}

function diskState(machine: MachineOperationsView): string {
  if (machine.capacityDetail === 'loading') return 'Reading…'
  if (machine.capacityDetail === 'stale') return 'Last sample'
  if (machine.capacityDetail === 'restricted') return 'No access'
  if (machine.capacityDetail === 'offline') return 'Offline'
  return 'Not reported'
}

function MachineRow({ machine, first }: { machine: MachineOperationsView; first: boolean }) {
  const load = machine.load?.perCore != null ? machine.load : null
  return (
    <View style={[styles.machine, !first && rowDivider]}>
      <View style={styles.line}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {machine.name}
        </Text>
        <Text style={styles.rowStatus}>{capitalise(machine.statusLabel)}</Text>
      </View>
      <MachineMetric
        label="Memory"
        pct={machine.memory?.pct ?? null}
        severity={machine.memory?.severity ?? 'ok'}
        value={machine.memory?.label ?? 'Not reported'}
      />
      <MachineMetric
        label="Disk"
        pct={machine.disk?.pct ?? null}
        severity={machine.disk?.severity ?? 'ok'}
        value={machine.disk ? machine.disk.freeLabel : diskState(machine)}
      />
      <MachineMetric
        label="Load"
        pct={load ? load.meterPct : null}
        severity={load?.severity ?? 'ok'}
        value={load ? `${load.label} per core` : 'Not reported'}
      />
    </View>
  )
}

function MachineMetric({
  label,
  pct,
  severity,
  value,
}: {
  label: string
  pct: number | null
  severity: 'ok' | 'warn' | 'critical'
  value: string
}) {
  return (
    <View style={styles.metric} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.metricLabel}>{label}</Text>
      <View style={styles.metricMeter}>
        {pct !== null ? <Meter pct={pct} tone={SEVERITY_TONE[severity]} /> : null}
      </View>
      <Text
        style={[styles.metricValue, severity === 'critical' && pct !== null && styles.crit]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  )
}

function capitalise(text: string): string {
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : text
}

const tabular = { fontVariant: ['tabular-nums' as const] }

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
  },
  page: {
    paddingTop: 0,
  },
  subtitle: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: 20,
    marginBottom: space.sm + 2,
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
  hero: {
    paddingHorizontal: CARD_INSET,
    paddingVertical: CARD_INSET,
    gap: space.sm,
  },
  heroKey: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: 16,
  },
  heroValue: {
    ...sans(700),
    ...tabular,
    color: color.text,
    fontSize: 34,
    lineHeight: 40,
    letterSpacing: -0.5,
  },
  heroUnit: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.small,
    letterSpacing: 0,
  },
  days: {
    flexDirection: 'row',
  },
  day: {
    flex: 1,
  },
  dayName: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.micro,
    lineHeight: 14,
  },
  dayCost: {
    ...sans(400),
    ...tabular,
    color: color.textDim,
    fontSize: font.micro,
    lineHeight: 14,
  },
  stats: {
    flexDirection: 'row',
    ...rowDivider,
  },
  stat: {
    flex: 1,
    paddingHorizontal: CARD_INSET,
    paddingVertical: space.sm,
    gap: 2,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: color.hairline,
    marginLeft: -StyleSheet.hairlineWidth,
  },
  statLabel: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.micro,
    lineHeight: 14,
  },
  statValue: {
    ...sans(600),
    ...tabular,
    color: color.text,
    fontSize: font.small,
    lineHeight: 20,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  quota: {
    paddingHorizontal: CARD_INSET,
    paddingVertical: space.sm,
    gap: 6,
  },
  share: {
    paddingHorizontal: CARD_INSET,
    paddingVertical: space.sm,
    gap: 6,
  },
  rowTitle: {
    ...sans(400),
    flex: 1,
    color: color.text,
    fontSize: font.small,
    lineHeight: 20,
  },
  rowFigure: {
    ...sans(400),
    ...tabular,
    color: color.textDim,
    fontSize: font.tiny,
  },
  rowStatus: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  rowMeta: {
    ...sans(400),
    flexShrink: 1,
    color: color.textFaint,
    fontSize: 12,
    lineHeight: 16,
  },
  mono: {
    ...mono(400),
  },
  signal: {
    color: color.accentTint,
  },
  crit: {
    color: color.dangerText,
  },
  task: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: CARD_INSET,
  },
  taskRef: {
    ...mono(400),
    width: 64,
    color: color.textFaint,
    fontSize: font.micro,
  },
  taskTitle: {
    ...sans(400),
    flex: 1,
    color: color.text,
    fontSize: font.small,
  },
  taskCost: {
    ...sans(400),
    ...tabular,
    color: color.text,
    fontSize: font.tiny,
  },
  pressed: {
    backgroundColor: color.cardPressed,
  },
  machine: {
    paddingHorizontal: CARD_INSET,
    paddingVertical: space.sm,
    gap: 6,
  },
  metric: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  metricLabel: {
    ...sans(400),
    width: 56,
    color: color.textFaint,
    fontSize: 12,
    lineHeight: 16,
  },
  metricMeter: {
    flex: 1,
  },
  metricValue: {
    ...sans(400),
    ...tabular,
    width: 112,
    textAlign: 'right',
    color: color.textDim,
    fontSize: 12,
    lineHeight: 16,
  },
  more: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: {
    ...sans(400),
    color: color.accentTint,
    fontSize: font.small,
  },
  message: {
    paddingHorizontal: CARD_INSET,
    paddingVertical: CARD_INSET,
    gap: space.sm,
  },
  messageText: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: 20,
  },
  retry: {
    ...sans(400),
    color: color.accentTint,
    fontSize: font.small,
  },
  foot: {
    ...sans(400),
    color: color.textFaint,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: CARD_INSET,
    paddingTop: space.sm,
  },
  buildStamp: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    textAlign: 'center',
    paddingTop: space.xl,
  },
})
