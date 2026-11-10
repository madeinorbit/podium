import {
  formatCostRounded,
  formatUsd,
  type MachineOperationsView,
  type ProjectCostRow,
  type ProjectCostView,
  type TaskCostRowView,
  type UsageSummaryView,
  type visibleFleetOperations,
} from '@podium/client-core/values'
import { issueDisplayRef } from '@podium/protocol'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
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
import { color, font, mono, sans, space } from '../theme/theme'
import {
  attributedLabel,
  formatPercent,
  type ModelRowView,
  type PulseHero,
  type PulseRange,
  projectSubtitle,
  type QuotaRowView,
  type QuotaVerdict,
} from './pulse-view'

/**
 * The Pulse tab's content, presentational [POD-2379]: every figure arrives as
 * a prop, so the WebKit layout harness renders it from fixtures without the
 * router, the feed or the native header. PulseScreen owns the data.
 */

export type Fleet = ReturnType<typeof visibleFleetOperations>
type SectionKey = 'quota' | 'projects' | 'tasks' | 'models' | 'machines'

export interface PulseBodyProps {
  range: PulseRange
  hero: PulseHero
  summary: UsageSummaryView
  quota: QuotaRowView[]
  /** The capacity headline for the Quota header; null before any reading. */
  verdict: QuotaVerdict | null
  /** Top projects; null until the task costs have answered. */
  projects: ProjectCostView | null
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
  // Quota, projects, tasks and models have no five-hour reading; say which window they are.
  const weekNote = range === 'fiveHour' ? 'Last 7 days' : undefined

  if (props.failed) {
    return (
      <View style={styles.page}>
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
      <Card>
        <HeroBlock hero={hero} cold={cold} />
        <View style={styles.stats}>
          <Stat
            first
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

      <SectionHeader
        title="Quota"
        open={open('quota')}
        onToggle={() => toggle('quota')}
        trailing={props.verdict?.text}
        trailingSignal={props.verdict?.signal}
      />
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
          {props.projects === null || props.projects.rows.length === 0 ? (
            <Message
              text={
                props.projects === null
                  ? 'Reading task costs…'
                  : 'No task with a known project spent anything this week.'
              }
            />
          ) : (
            props.projects.rows.map((project, i) => (
              <ProjectRow key={project.project} project={project} first={i === 0} />
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
}

function HeroBlock({ hero, cold }: { hero: PulseHero; cold: boolean }) {
  const daysLabel = hero.days.map((d) => `${d.weekday} ${formatCostRounded(d.costUsd)}`).join(', ')
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
              <Text style={styles.dayCost}>{cold ? '—' : formatCostRounded(day.costUsd)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function Stat({ label, value, first = false }: { label: string; value: string; first?: boolean }) {
  return (
    <View
      style={[styles.stat, !first && styles.statDivided]}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
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
      accessibilityLabel={`${ref} ${task.title}, ${formatCostRounded(task.windowCostUsd)}`}
      onPress={onPress}
      style={({ pressed }) => [styles.task, pressed && styles.pressed]}
    >
      {/* Separator starts at the title column, as list rows inset theirs. */}
      {first ? null : <View style={styles.taskDivider} />}
      <Text style={styles.taskRef} numberOfLines={1}>
        {ref}
      </Text>
      <Text style={styles.taskTitle} numberOfLines={1}>
        {task.title}
      </Text>
      <Text style={styles.taskCost}>{formatCostRounded(task.windowCostUsd)}</Text>
    </Pressable>
  )
}

function ProjectRow({ project, first }: { project: ProjectCostRow; first: boolean }) {
  return (
    <View
      style={[styles.share, !first && rowDivider]}
      accessible
      accessibilityLabel={`${project.project}, ${formatUsd(project.costUsd)}, ${formatPercent(project.sharePercent)} of the week, ${projectSubtitle(project)}`}
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
        <Text style={[styles.rowMeta, styles.mono]}>{formatPercent(project.sharePercent)}</Text>
      </View>
    </View>
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

const TASK_REF_WIDTH = 64
const TASK_TITLE_X = CARD_INSET + TASK_REF_WIDTH + space.sm

const tabular = { fontVariant: ['tabular-nums' as const] }

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
