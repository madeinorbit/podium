/**
 * PULSE LAYOUT HARNESS (POD-2379). Not shipped, not part of the app.
 *
 * Renders the real PulseBody from the shared demo fixtures at phone width in a
 * browser, where react-native-web lays the styles out for real. The native
 * large-title header, the range menu and the tab bar are iOS-drawn and are
 * only sketched here as a static title row; check those in the simulator.
 *
 *   ?range=fiveHour   the short range
 *   ?state=cold       before the first answer
 */
import {
  DEMO_HOST_METRICS,
  DEMO_MACHINES,
  DEMO_MEMORY_BREAKDOWNS,
  DEMO_QUOTA,
  DEMO_USAGE_BUCKETS,
} from '@podium/client-core/demo'
import {
  groupQuotaByAccount,
  type MachineCapacityReadings,
  usageSummary,
  visibleFleetOperations,
} from '@podium/client-core/values'
import type { TaskCostRowWire } from '@podium/model'
import { createRoot } from 'react-dom/client'
import { StyleSheet, Text, View } from 'react-native'
import { PulseBody } from '../src/screens/PulseBody'
import {
  modelRows,
  type PulseRange,
  pulseHero,
  pulseSubtitle,
  quotaRows,
  rangeShort,
  topTasks,
} from '../src/screens/pulse-view'
import { color, sans, space } from '../src/theme/theme'

const params = new URLSearchParams(window.location.search)
const range = (params.get('range') as PulseRange | null) ?? 'week'
const cold = params.get('state') === 'cold'
const nowMs = Date.now()

const TASKS: [string, string, number][] = [
  ['POD-2346', 'iOS App Redesign', 16.8],
  ['PDM-145', 'GitHub Star Tactics', 14.2],
  ['TFT-33', 'AbaNinja shadow and cutover', 13.2],
  ['POD-2317', 'Two-week changelog review', 10.4],
  ['ONA-85', 'Google Ads consent tracking', 7.6],
  ['POD-2001', 'Older task', 3],
]
const taskRows = TASKS.map(
  ([ref, title, mtok], i) =>
    ({
      issueId: `iss_${i}`,
      seq: i,
      displayRef: ref,
      title,
      stage: 'in_progress',
      models: [],
      messages: 0,
      windowModels: [
        {
          model: 'claude-opus-5',
          inputTokens: mtok * 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheCreation1hTokens: 0,
          messages: 10,
        },
      ],
      windowMessages: 10,
      rollupModels: [],
      rollupMessages: 0,
      sessionCount: 1,
      floor: 'none',
      harnesses: ['claude-code'],
      uncostedSessionCount: 0,
    }) as unknown as TaskCostRowWire,
)

const capacityReadings = Object.fromEntries(
  Object.entries(DEMO_MEMORY_BREAKDOWNS).map(([id, value]) => [id, { state: 'ready', value }]),
) as MachineCapacityReadings

const summary = usageSummary(cold ? [] : DEMO_USAGE_BUCKETS, nowMs)

function Harness() {
  return (
    <View style={styles.phone}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Pulse</Text>
        <Text style={styles.cap}>{rangeShort(range)} ⌄</Text>
      </View>
      <Text style={styles.subtitle}>{pulseSubtitle(pulseHero(summary, range), range, cold)}</Text>
      <View style={styles.content}>
        <PulseBody
          range={range}
          hero={pulseHero(summary, range)}
          summary={summary}
          quota={cold ? [] : quotaRows(groupQuotaByAccount(DEMO_QUOTA), nowMs)}
          tasks={cold ? [] : topTasks(taskRows)}
          tasksCold={cold}
          models={modelRows(summary)}
          fleet={visibleFleetOperations({
            machines: DEMO_MACHINES,
            hosts: DEMO_HOST_METRICS,
            capacityReadings,
            loadPerCore: 1.5,
            nowMs,
          })}
          cold={cold}
          failed={false}
          onRetry={() => {}}
          onOpenTask={() => {}}
          buildStamp={'demo.server · harness\nphone 0.3 · server 0.3'}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  phone: { width: 402, backgroundColor: color.bg, paddingTop: 62, paddingBottom: 48 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    minHeight: 44,
    marginBottom: space.xs,
  },
  title: { ...sans(700), flex: 1, color: color.text, fontSize: 34, lineHeight: 40 },
  cap: { ...sans(400), color: color.text, fontSize: 15 },
  subtitle: {
    ...sans(400),
    color: color.textDim,
    fontSize: 15,
    lineHeight: 20,
    paddingHorizontal: space.lg,
    marginBottom: 10,
  },
  content: { paddingHorizontal: space.lg },
})

const root = document.getElementById('root')
if (root) createRoot(root).render(<Harness />)
