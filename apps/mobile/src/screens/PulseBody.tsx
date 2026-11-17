import {
  formatCostRounded,
  formatShare,
  formatUsd,
  type MachineOperationsView,
  type ProjectCostRow,
  type ProjectCostView,
  type QuotaRowView,
  USAGE_PROVIDER_LABEL,
  type UsageModelShare,
  type UsageSummaryView,
  type visibleFleetOperations,
  type WindowTaskCostRow,
} from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph/loading'
import { isGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { observer } from 'mobx-react-lite'
import { memo, type ReactNode, useState } from 'react'
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import {
  CARD_INSET,
  Card,
  HourTrace,
  Meter,
  type MeterTone,
  rowDivider,
  SEPARATOR,
  SectionHeader,
} from '../components/instruments'
import { useRowPress } from '../hooks/useRowPress'
import { color, font, mono, sans, space } from '../theme/theme'
import {
  attributedLabel,
  type PulseHero,
  type PulseRange,
  projectSubtitle,
  type QuotaVerdict,
} from './pulse-view'

/**
 * Pulse figures arrive from shared views. Each task row observes its identity
 * in the pool; the WebKit harness supplies a synthetic pool for the same path.
 * PulseScreen owns the opening, feed and native header.
 */

export type Fleet = ReturnType<typeof visibleFleetOperations>
type SectionKey = 'quota' | 'projects' | 'tasks' | 'models' | 'machines'

export interface PulseBodyProps {
  range: PulseRange
  pool: MobxPool | null
  quotaHeader?: (open: boolean, onToggle: () => void) => ReactNode
  machinesSection?: (open: boolean, onToggle: () => void) => ReactNode
  hero: PulseHero
  summary: UsageSummaryView
  quota: QuotaRowView[]
  /** The capacity headline for the Quota header; null before any reading. */
  verdict: QuotaVerdict | null
  /** Top projects; null until the task costs have answered. */
  projects: ProjectCostView | null
  tasks: WindowTaskCostRow[]
  tasksCold: boolean
  models: UsageModelShare[]
  fleet: Fleet
  cold: boolean
  /** Usage failure, independent of quota, costs and live machines. */
  failed: boolean
  quotaCold?: boolean
  quotaFailed?: boolean
  tasksFailed?: boolean
  onRetry: (reading: 'usage' | 'quota') => void
  onOpenTask: (issueId: string) => void
  buildStamp: string
}

export const PulseBody = memo(function PulseBody(props: PulseBodyProps) {
  const { range, hero, summary, cold } = props
  const { fontScale } = useWindowDimensions()
  const stackedStats = fontScale >= STACKED_STATS_SCALE
  const [closed, setClosed] = useState<ReadonlySet<SectionKey>>(new Set())
  const toggle = (key: SectionKey) =>
    setClosed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const open = (key: SectionKey) => !closed.has(key)
  // Quota, projects, tasks and models have no five-hour reading; say which window they are.
  const weekNote = range === 'fiveHour' ? 'Last 7 days' : undefined

  return (
    // Rebuild native text measurements without resetting the section folds above.
    <View key={fontScale} style={styles.page}>
      <Card>
        {props.failed ? (
          <ReadingFailure label="usage" stale={!cold} onRetry={() => props.onRetry('usage')} />
        ) : null}
        <HeroBlock hero={hero} cold={cold} />
        <View style={[styles.stats, stackedStats && styles.statsStacked]}>
          <Stat
            first
            stacked={stackedStats}
            label="Per active day"
            value={
              cold || summary.costPerActiveDayUsd === null
                ? '—'
                : formatUsd(summary.costPerActiveDayUsd)
            }
          />
          {range === 'week' ? (
            <Stat
              stacked={stackedStats}
              label="Last 5 hours"
              value={cold ? '—' : formatUsd(summary.fiveHour.estCostUsd)}
            />
          ) : (
            <Stat
              stacked={stackedStats}
              label="Last 7 days"
              value={cold ? '—' : formatUsd(summary.week.estCostUsd)}
            />
          )}
          <Stat
            stacked={stackedStats}
            label="Cache saved"
            value={cold ? '—' : formatUsd(summary.cacheSavingsUsd)}
          />
        </View>
      </Card>

      {props.quotaHeader ? (
        props.quotaHeader(open('quota'), () => toggle('quota'))
      ) : (
        <SectionHeader
          title="Quota"
          open={open('quota')}
          onToggle={() => toggle('quota')}
          trailing={props.verdict?.text}
          trailingSignal={props.verdict?.signal}
        />
      )}
      {open('quota') ? (
        <Card>
          {props.quotaFailed ? (
            <ReadingFailure
              label="quota"
              stale={!props.quotaCold}
              onRetry={() => props.onRetry('quota')}
            />
          ) : null}
          {props.quota.length === 0 ? (
            props.quotaFailed ? null : (
              <Message
                text={
                  (props.quotaCold ?? cold)
                    ? 'Reading quota…'
                    : 'No machine is signed in to a provider that reports plan limits.'
                }
              />
            )
          ) : (
            props.quota.map((row, i) => <QuotaRow key={row.key} row={row} first={i === 0} />)
          )}
        </Card>
      ) : null}

      <SectionHeader
        title="Top projects"
        open={open('projects')}
        onToggle={() => toggle('projects')}
        trailing={
          [weekNote, attributedLabel(props.projects)].filter(Boolean).join(' · ') || undefined
        }
      />
      {open('projects') ? (
        <Card>
          {props.tasksFailed ? (
            <ReadingFailure
              label="task costs"
              stale={!props.tasksCold}
              onRetry={() => props.onRetry('usage')}
            />
          ) : null}
          {props.projects === null || props.projects.rows.length === 0 ? (
            props.tasksFailed ? null : (
              <Message
                text={
                  props.projects === null
                    ? 'Reading task costs…'
                    : 'No task with a known project spent anything this week.'
                }
              />
            )
          ) : (
            props.projects.rows.map((project, i) => (
              <ProjectRow
                key={project.projectKey ?? project.project}
                project={project}
                first={i === 0}
              />
            ))
          )}
        </Card>
      ) : null}

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
              text={
                props.tasksCold
                  ? props.tasksFailed
                    ? 'Task costs unavailable.'
                    : 'Reading task costs…'
                  : 'No task spent anything this week.'
              }
            />
          ) : (
            props.tasks.map((task, i) => (
              <LiveTaskRow
                key={task.issueId}
                pool={props.pool}
                issueId={task.issueId}
                costUsd={task.windowCostUsd}
                first={i === 0}
                onOpen={props.onOpenTask}
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
              text={
                cold
                  ? props.failed
                    ? 'Usage unavailable.'
                    : 'Reading usage…'
                  : 'No harness transcripts in the last seven days.'
              }
            />
          ) : (
            props.models.map((model, i) => (
              <ModelRow key={model.model} model={model} first={i === 0} />
            ))
          )}
        </Card>
      ) : null}

      {props.machinesSection ? (
        props.machinesSection(open('machines'), () => toggle('machines'))
      ) : (
        <>
          <SectionHeader
            title="Machines"
            open={open('machines')}
            onToggle={() => toggle('machines')}
            trailing={props.fleet.machines.length > 0 ? props.fleet.fleetLabel : undefined}
          />
          {open('machines') ? <Machines fleet={props.fleet} /> : null}
        </>
      )}

      <Text style={styles.foot}>
        {range === 'fiveHour'
          ? 'Quota, projects, top tasks and models cover the last 7 days. '
          : ''}
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
})

const HeroBlock = memo(function HeroBlock({ hero, cold }: { hero: PulseHero; cold: boolean }) {
  const daysLabel = hero.days.map((d) => `${d.weekday} ${formatCostRounded(d.costUsd)}`).join(', ')
  return (
    <View style={styles.hero}>
      <Text style={styles.heroKey}>API-equivalent cost · {hero.spanLabel}</Text>
      {/* A wrapping row, not nested text: at large sizes the unit drops to its own
          line at its own height instead of inheriting the figure's line height. */}
      <View style={styles.heroLine}>
        {/* One line, shrinking at the largest sizes, as Stocks does for a quote:
            a cost broken across lines ("$0.0" / "0") misreads. */}
        <Text
          style={styles.heroValue}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.5}
        >
          {cold ? '—' : formatUsd(hero.costUsd)}
        </Text>
        <Text style={styles.heroUnit}>list price</Text>
      </View>
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
              <Text style={styles.dayName} numberOfLines={1} maxFontSizeMultiplier={AXIS_MAX_SCALE}>
                {day.weekday}
              </Text>
              <Text style={styles.dayCost} numberOfLines={1} maxFontSizeMultiplier={AXIS_MAX_SCALE}>
                {cold ? '—' : formatCostRounded(day.costUsd)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
})

function ReadingFailure({
  label,
  stale,
  onRetry,
}: {
  label: string
  stale: boolean
  onRetry: () => void
}) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>
        {stale ? `Couldn’t refresh ${label}. Showing the last reading.` : `Couldn’t read ${label}.`}
      </Text>
      <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8}>
        <Text style={styles.retry}>Try Again</Text>
      </Pressable>
    </View>
  )
}

function Stat({
  label,
  value,
  first = false,
  stacked = false,
}: {
  label: string
  value: string
  first?: boolean
  /** Accessibility sizes: one full-width line each, label leading and value trailing. */
  stacked?: boolean
}) {
  return (
    <View
      style={[
        styles.stat,
        stacked && styles.statStacked,
        !first && (stacked ? styles.statDividedStacked : styles.statDivided),
      ]}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text
        style={[styles.statLabel, stacked && styles.statLabelStacked]}
        numberOfLines={stacked ? 0 : 1}
      >
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

function QuotaRowBase({ row, first }: { row: QuotaRowView; first: boolean }) {
  const readable = row.usedPercent !== null
  return (
    <View style={[styles.quota, !first && rowDivider]}>
      <View style={styles.line}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {row.title}
        </Text>
        {readable ? (
          <Text style={[styles.rowFigure, row.out && styles.signal]}>
            {row.out ? 'Out' : `${Math.round(row.usedPercent ?? 0)}%`}
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

interface TaskRowProps {
  issueId: string
  costUsd: number
  first: boolean
  onOpen: (issueId: string) => void
}

const LiveTaskRow = observer(function LiveTaskRow({
  pool,
  ...props
}: TaskRowProps & { pool: MobxPool | null }) {
  const issue = pool?.model('issue', props.issueId) ?? LOADING
  if (isGone(issue)) return <TaskRow {...props} title="Task unavailable" displayRef="" disabled />
  if (issue === LOADING) return <TaskRow {...props} title="Loading task…" displayRef="" disabled />
  return <TaskRow {...props} title={issue.title} displayRef={issue.displayRef} />
})

function TaskRowBase({
  issueId,
  title,
  displayRef,
  costUsd,
  first,
  onOpen,
  disabled = false,
}: TaskRowProps & { title: string; displayRef: string; disabled?: boolean }) {
  const press = useRowPress(() => onOpen(issueId))
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${displayRef} ${title}, ${formatCostRounded(costUsd)}`}
      disabled={disabled}
      {...press}
      style={({ pressed }) => [styles.task, pressed && styles.pressed]}
    >
      {first ? null : <View style={styles.taskDivider} />}
      <Text style={styles.taskRef} numberOfLines={1}>
        {displayRef}
      </Text>
      <Text style={styles.taskTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.taskCost}>{formatCostRounded(costUsd)}</Text>
    </Pressable>
  )
}

function ProjectRowBase({ project, first }: { project: ProjectCostRow; first: boolean }) {
  return (
    <View
      style={[styles.share, !first && rowDivider]}
      accessible
      accessibilityLabel={`${project.project}, ${formatUsd(project.costUsd)}, ${formatShare(project.sharePercent, 100)} of the week, ${projectSubtitle(project)}`}
    >
      <View style={styles.line}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {project.project}
        </Text>
        <Text style={styles.rowFigure}>{formatUsd(project.costUsd)}</Text>
      </View>
      <Meter pct={project.barPercent} muted />
      <View style={styles.line}>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {projectSubtitle(project)}
        </Text>
        <Text style={[styles.rowMeta, styles.mono]}>{formatShare(project.sharePercent, 100)}</Text>
      </View>
    </View>
  )
}

function ModelRowBase({ model, first }: { model: UsageModelShare; first: boolean }) {
  return (
    <View style={[styles.share, !first && rowDivider]}>
      <View style={styles.line}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {model.model}
        </Text>
        <Text style={styles.rowFigure}>{formatUsd(model.estCostUsd)}</Text>
      </View>
      <Meter pct={model.barPercent} muted />
      <View style={styles.line}>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {USAGE_PROVIDER_LABEL[model.provider]} · {model.messages.toLocaleString('en-US')}{' '}
          {model.messages === 1 ? 'reply' : 'replies'}
        </Text>
        <Text style={[styles.rowMeta, styles.mono]}>{formatShare(model.sharePercent, 100)}</Text>
      </View>
    </View>
  )
}

// Rows re-render only when their own reading changes: the shared view model
// hands back the same row objects until its answer does, so a streamed
// host-metric update repaints the machines card and nothing else here.
const QuotaRow = memo(QuotaRowBase)
const ProjectRow = memo(ProjectRowBase)
const TaskRow = memo(TaskRowBase)
const ModelRow = memo(ModelRowBase)

const SEVERITY_TONE: Record<'ok' | 'warn' | 'critical', MeterTone> = {
  ok: 'ink',
  warn: 'signal',
  critical: 'crit',
}

const PREVIEW_MACHINES = 12

export function Machines({ fleet }: { fleet: Fleet }) {
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

const TASK_REF_WIDTH = 64
const TASK_TITLE_X = CARD_INSET + TASK_REF_WIDTH + space.sm

const tabular = { fontVariant: ['tabular-nums' as const] }

/**
 * Chart axis labels: seven day columns share the card width, so their text stops
 * growing at the cap the deck and mission bar use, and never wraps a weekday.
 */
const AXIS_MAX_SCALE = 1.35

/** From the first accessibility size the three stats stack instead of truncating. */
const STACKED_STATS_SCALE = 1.6

const styles = StyleSheet.create({
  page: {
    paddingTop: 0,
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
  heroLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: 6,
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
  },
  statDivided: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: SEPARATOR,
  },
  statsStacked: {
    flexDirection: 'column',
  },
  statStacked: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: space.sm,
  },
  statDividedStacked: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: SEPARATOR,
  },
  statLabelStacked: {
    flexShrink: 1,
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
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: CARD_INSET,
  },
  taskDivider: {
    position: 'absolute',
    top: 0,
    right: 0,
    left: TASK_TITLE_X,
    height: StyleSheet.hairlineWidth,
    backgroundColor: SEPARATOR,
  },
  taskRef: {
    ...mono(400),
    width: TASK_REF_WIDTH,
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
