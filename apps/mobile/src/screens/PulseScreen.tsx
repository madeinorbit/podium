import {
  type AccountQuotaGroup,
  agentLabel,
  agentShortLabel,
  type CapacityView,
  capacityView,
  formatCostWeightRatio,
  formatReset,
  formatShare,
  formatTokens,
  formatUsd,
  formatWindowSpan,
  groupQuotaByAccount,
  modelLimitNote,
  percentTone,
  type QuotaTone,
  spentModels,
  splitQuotaWindows,
  statusNote,
  type UsageDay,
  type UsageProvider,
  usageSummary,
  windowElapsedPercent,
} from '@podium/client-core/viewmodels'
import type { AgentKind, QuotaWindowWire } from '@podium/model'
import { useCallback, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { BarTrace, Meter, type MeterTone, Readout, SubReadout } from '../components/instruments'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { Screen } from '../components/Screen'
import { EmptyState, SectionHeader } from '../components/ui'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { useTabBarInset } from '../hooks/useTabBarInset'
import {
  color,
  font,
  leading,
  mono,
  monoLabel,
  radius,
  sans,
  space,
  tracking,
} from '../theme/theme'
import { usePulseFeed } from './usePulseFeed'

/**
 * PULSE — capacity now, usage in context [POD-662].
 *
 * The pocket question is not "how many tokens did I spend"; it is *can I safely
 * start more work?* So the screen leads with an answer to that, in a sentence,
 * and the meters under it are the evidence rather than the content. Quota and
 * host pressure are the two things that can stop work, and neither of them
 * previously existed on the phone at all — they lived in the desktop's 44px
 * instrument well, which does not exist here.
 *
 * ONE DESTINATION, TWO TIME SCALES. "Now" is capacity; "7 days" is where the
 * money went. They are the same subject at different distances, so they share a
 * tab and a switch rather than nesting sheets — a switch costs one tap and
 * keeps one mental model, and the alternative was a fourth tab plus a sheet.
 *
 * COST IS ALWAYS API-EQUIVALENT. It is what these tokens would have cost off
 * subscription, not a bill anybody sent, and the caveat rides ON the number in
 * both views. A dollar figure on a phone with no asterisk WILL be read as the
 * invoice.
 */

type Mode = 'now' | 'week'

export function PulseScreen() {
  const feed = usePulseFeed()
  const [mode, setMode] = useState<Mode>('now')
  const tabBarInset = useTabBarInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()
  const reload = feed.reload
  const onPull = useCallback(() => reload(), [reload])
  const { listRef, refreshControl, refreshAccessibilityProps, refreshing, onRefresh, connected } =
    useRefreshableTab('pulse', onPull)

  const cold = feed.quota === null && feed.buckets === null
  const { capacity, groups, summary } = useMemo(
    () => ({
      capacity: capacityView({
        machines: feed.quota,
        hosts: feed.hosts,
        loadPerCore: feed.loadPerCore,
        nowMs: feed.nowMs,
      }),
      groups: groupQuotaByAccount([...(feed.quota ?? [])]),
      summary: usageSummary(feed.buckets ?? [], feed.nowMs),
    }),
    [feed.quota, feed.buckets, feed.hosts, feed.loadPerCore, feed.nowMs],
  )

  const hostCount = feed.hosts.length
  const stamp = feed.failed
    ? 'Last read'
    : cold
      ? 'Reading'
      : `Live · ${hostCount} ${hostCount === 1 ? 'host' : 'hosts'}`

  return (
    <Screen
      title="Pulse"
      large
      right={
        <Text style={styles.stamp} numberOfLines={1}>
          {stamp}
        </Text>
      }
    >
      <ModeSwitch mode={mode} onChange={setMode} />
      <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
        <ScrollView
          ref={listRef as never}
          refreshControl={refreshControl}
          contentContainerStyle={[styles.content, { paddingBottom: tabBarInset + space.lg }]}
          {...refreshAccessibilityProps}
          {...minimizeOnScroll}
        >
          {cold && feed.failed ? (
            <Unreachable onRetry={feed.reload} />
          ) : mode === 'now' ? (
            <NowPanel
              capacity={capacity}
              groups={groups}
              summary={summary}
              cold={cold}
              feedNow={feed.nowMs}
            />
          ) : (
            <WeekPanel summary={summary} cold={cold} />
          )}
        </ScrollView>
      </PullToRefreshBoundary>
    </Screen>
  )
}

// ---------------------------------------------------------------------------
// Now — capacity
// ---------------------------------------------------------------------------

function NowPanel({
  capacity,
  groups,
  summary,
  cold,
  feedNow,
}: {
  capacity: CapacityView
  groups: AccountQuotaGroup[]
  summary: ReturnType<typeof usageSummary>
  cold: boolean
  feedNow: number
}) {
  const rows = useMemo(() => gatingRows(groups), [groups])
  const quota = capacity.quota
  const load = capacity.load
  const weekBars = summary.days.map((d) => d.estCostUsd)

  return (
    <>
      {/* THE ANSWER, BEFORE ANY NUMBER. Both feeds are interpreted into one
          sentence naming whichever is actually the constraint — the meters
          below are what it is based on, not what you have to read first. */}
      <View style={styles.hero}>
        <View style={styles.heroState}>
          <View style={[styles.dot, { backgroundColor: TONE_COLOR[capacity.tone] }]} />
          <Text style={styles.microLabel}>Capacity</Text>
        </View>
        <Text style={styles.heroHeadline}>{cold ? 'Taking a reading' : capacity.headline}</Text>
        <Text style={styles.heroDetail}>
          {cold ? (
            'Quota and host pressure land in a moment.'
          ) : (
            <>
              <Text style={styles.heroLead}>{capacity.lead}</Text> {capacity.detail}
            </>
          )}
        </Text>
      </View>

      <View style={styles.paired}>
        <View style={styles.metric}>
          <Readout
            label="Tightest quota"
            value={quota ? `${Math.round(quota.leftPercent)}% left` : '—'}
          />
          <Meter
            pct={quota ? quota.leftPercent : 0}
            tone={quota ? meterToneForLeft(quota.usedPercent) : 'ok'}
          />
          <SubReadout
            left={quota ? `${quota.agentName} · ${quota.windowLabel}` : 'no readable pool'}
            right={quota ? formatReset(quota.resetsAt, feedNow) : undefined}
          />
        </View>
        <View style={[styles.metric, styles.metricDivided]}>
          <Readout label="Host pressure" value={load ? `${load.label} per core` : '—'} />
          {/* The marker is the auto-park line, so the rail predicts behaviour
              rather than filling toward an arbitrary ceiling. */}
          <Meter
            pct={load ? load.meterPct : 0}
            tone={load ? SEVERITY_TONE[load.severity] : 'ok'}
            marker={load ? 100 : null}
            markerLabel="auto-park threshold"
          />
          <SubReadout
            left={load ? load.hostname : 'load unavailable'}
            right={load ? (load.meterPct >= 100 ? 'parking agents' : 'below park line') : undefined}
          />
        </View>
      </View>

      <SectionHeader
        label="Quota windows"
        right={<Text style={styles.sectionNote}>live from providers</Text>}
      />
      {rows.length === 0 ? (
        <EmptyState
          title={cold ? 'Reading quota' : 'No quota to read'}
          body={
            cold ? undefined : 'No machine is signed in to a provider that reports plan limits.'
          }
        />
      ) : (
        <View style={styles.section}>
          {rows.map((row, i) => (
            <QuotaRow key={row.key} row={row} nowMs={feedNow} first={i === 0} />
          ))}
        </View>
      )}

      <SectionHeader
        label="This week"
        right={
          <Text style={styles.sectionNote}>
            {summary.activeDayCount} active {summary.activeDayCount === 1 ? 'day' : 'days'}
          </Text>
        }
      />
      <View style={[styles.section, styles.weekGlance]}>
        <View style={styles.weekFigures}>
          <Text style={styles.weekNumber}>
            {cold ? '—' : `${formatUsd(summary.week.estCostUsd)}*`}
          </Text>
          <Text style={styles.weekCaption}>
            API-equivalent{'\n'}
            {summary.costPerActiveDayUsd === null
              ? 'nothing ran'
              : `${formatUsd(summary.costPerActiveDayUsd)} / active day`}
          </Text>
        </View>
        <View style={styles.weekChart}>
          <BarTrace values={weekBars} height={56} label="Cost per day over the last seven days" />
        </View>
      </View>
    </>
  )
}

/** One gating window of one pool — the unit a person actually runs out of. */
interface GatingRow {
  key: string
  agent: AgentKind
  agentName: string
  window: QuotaWindowWire
  /** Set when this pool has already lost a model-scoped bucket. */
  modelNote: string | null
}

/**
 * Every readable pool's GATING windows, tightest first, plus a line for each
 * pool we cannot read.
 *
 * Model-scoped windows are not rows: spending one drops that model, not the
 * harness (POD-271), so listing it beside the limits that stop work would
 * overstate it. It becomes a note under the pool that lost it instead — which
 * is still worth saying, because the model you get did change.
 */
function gatingRows(groups: AccountQuotaGroup[]): GatingRow[] {
  const rows: GatingRow[] = []
  for (const group of groups) {
    if (group.status !== 'ok') {
      rows.push({
        key: `${group.key}:status`,
        agent: group.agent,
        agentName: agentLabel(group.agent),
        window: {
          key: 'status',
          label: statusNote(group),
          usedPercent: 0,
          resetsAt: '',
          windowMinutes: 0,
        },
        modelNote: null,
      })
      continue
    }
    const spent = spentModels(group.windows)
    for (const window of splitQuotaWindows(group.windows).gating) {
      rows.push({
        key: `${group.key}:${window.key}`,
        agent: group.agent,
        agentName: agentLabel(group.agent),
        window,
        modelNote: spent.length > 0 ? modelLimitNote(group.agent, group.windows) : null,
      })
    }
  }
  return rows.sort((a, b) => b.window.usedPercent - a.window.usedPercent)
}

function QuotaRow({ row, nowMs, first }: { row: GatingRow; nowMs: number; first: boolean }) {
  const { window: w } = row
  const readable = w.key !== 'status'
  const left = Math.max(0, Math.min(100, 100 - w.usedPercent))
  const elapsed = readable ? windowElapsedPercent(w.resetsAt, w.windowMinutes, nowMs) : null
  return (
    <View style={[styles.quotaRow, !first && styles.rowDivided]}>
      <View style={[styles.mark, { borderColor: markBorder(row.agent) }]}>
        <Text style={[styles.markText, { color: markColor(row.agent) }]}>
          {agentShortLabel(row.agent)}
        </Text>
      </View>
      <View style={styles.quotaBody}>
        <Text style={styles.quotaName} numberOfLines={1}>
          {row.agentName}
        </Text>
        <Text style={styles.quotaDetail} numberOfLines={1}>
          {readable
            ? `${w.label}${w.resetsAt ? ` · ${formatReset(w.resetsAt, nowMs)}` : ''}`
            : w.label}
        </Text>
        {readable ? (
          <Meter
            pct={left}
            tone={meterToneForLeft(w.usedPercent)}
            // The elapsed tick is a pace read: fill behind the mark means the
            // window is outrunning the clock. It reads from the LEFT-hand end
            // because the rail shows what is left, not what is gone.
            marker={elapsed === null ? null : 100 - elapsed}
            markerLabel="share of the window still to run"
          />
        ) : null}
        {row.modelNote ? <Text style={styles.quotaNote}>{row.modelNote}</Text> : null}
      </View>
      {readable ? (
        <View style={styles.quotaFigure}>
          <Text style={styles.quotaPct}>{Math.round(left)}%</Text>
          <Text style={styles.quotaPctLabel}>left</Text>
        </View>
      ) : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// 7 days — analytics
// ---------------------------------------------------------------------------

function WeekPanel({ summary, cold }: { summary: ReturnType<typeof usageSummary>; cold: boolean }) {
  // SIX-HOUR BLOCKS ARE A DISPLAY DECISION, NOT A DERIVATION. The shared module
  // keeps the week at hour resolution, which is right for a desk sheet; 168 bars
  // across a 393pt phone is under 2pt each — a texture, not a chart. So the
  // hours are bucketed here, in the view that has the width problem, and the
  // numbers still come from one place.
  const blocks = useMemo(() => blockify(summary.days), [summary.days])
  const peak = blocks.reduce<Block>(
    (best, b) => (b.estCostUsd > best.estCostUsd ? b : best),
    blocks[0] ?? { startMs: 0, estCostUsd: 0, dayTick: '', label: '' },
  )
  // Only the two costliest classes. A four-row table of token kinds is a
  // different screen; what this one has to land is that output tokens are a
  // sliver of the traffic and a large share of the bill.
  const composition = [...summary.composition]
    .filter((part) => part.tokens > 0)
    .sort((a, b) => b.estCostUsd - a.estCostUsd)
    .slice(0, 2)
  const totalCost = summary.week.estCostUsd

  return (
    <>
      <View style={styles.readoutBlock}>
        <Text style={styles.dateWindow}>{formatWindowSpan(summary.days)}</Text>
        <Text style={styles.money}>
          {cold ? '—' : formatUsd(summary.week.estCostUsd)}
          <Text style={styles.moneyStar}>*</Text>
        </Text>
        <Text style={styles.rate}>
          {summary.costPerActiveDayUsd === null
            ? 'Nothing ran this week'
            : `${formatUsd(summary.costPerActiveDayUsd)} per active day`}{' '}
          · {summary.activeDayCount} of 7 days ran
          {'\n'}
          {formatUsd(summary.fiveHour.estCostUsd)} in the last five hours
        </Text>
        <Text style={styles.caveat}>
          * API list price for the same tokens — not what you were billed.
        </Text>
      </View>

      {/* Cache reads are the one figure that reads as good news, so it gets a
          sentence rather than a rail. */}
      {summary.cacheSavingsUsd > 0 ? (
        <View style={styles.savings}>
          <Text style={styles.savingsText}>
            Cache reads saved{' '}
            <Text style={styles.savingsFigure}>{formatUsd(summary.cacheSavingsUsd)}</Text>
            {summary.cacheSavingsMultiple === null
              ? ''
              : ` — ${summary.cacheSavingsMultiple.toFixed(1).replace(/\.0$/, '')}x the week's whole bill`}
            .
          </Text>
        </View>
      ) : null}

      <View style={styles.trace}>
        <View style={styles.traceHead}>
          <Text style={styles.microLabel}>Cost through the week</Text>
          <Text style={styles.sectionNote}>
            {peak.estCostUsd > 0
              ? `peak ${formatUsd(peak.estCostUsd)} · ${peak.label}`
              : 'no spend'}
          </Text>
        </View>
        <BarTrace
          values={blocks.map((b) => b.estCostUsd)}
          height={112}
          gridlines={2}
          label="API-equivalent cost in six-hour blocks across the last seven days"
        />
        {/* One tick slot per BAR, labelled only where a day opens. Seven
            evenly-spaced labels would drift off their columns: today contributes
            fewer than four bars whenever its remaining blocks are still in the
            future, so the run is not a fixed 28. */}
        <View style={styles.dayTicks}>
          {blocks.map((b) => (
            <Text key={b.startMs} style={styles.dayTick} numberOfLines={1}>
              {b.dayTick}
            </Text>
          ))}
        </View>
      </View>

      <SectionHeader
        label="Where it went"
        right={<Text style={styles.sectionNote}>cost · tokens</Text>}
      />
      {summary.providers.length === 0 ? (
        <EmptyState
          title={cold ? 'Reading usage' : 'Nothing recorded'}
          body={cold ? undefined : 'No harness transcripts in the last seven days.'}
        />
      ) : (
        <View style={styles.section}>
          {summary.providers.map((p, i) => (
            <View key={p.provider} style={[styles.providerRow, i > 0 && styles.rowDivided]}>
              <View style={styles.providerBody}>
                <Text style={styles.providerName}>{PROVIDER_LABEL[p.provider]}</Text>
                <Text style={styles.providerSub}>
                  {formatShare(p.estCostUsd, totalCost)} of cost · {formatTokens(p.totalTokens)}{' '}
                  tokens
                </Text>
              </View>
              <View style={styles.providerFigure}>
                <Text style={styles.providerCost}>{formatUsd(p.estCostUsd)}</Text>
                <Text style={styles.providerReplies}>{p.messages.toLocaleString()} replies</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {composition.length > 0 ? (
        <>
          <SectionHeader
            label="Cost composition"
            right={
              <Text style={styles.sectionNote}>
                {formatTokens(summary.week.totalTokens)} tokens
              </Text>
            }
          />
          <View style={styles.section}>
            {composition.map((part, i) => (
              <View key={part.key} style={[styles.metric, i > 0 && styles.metricDivided]}>
                <Readout
                  label={part.label}
                  value={`${formatShare(part.estCostUsd, totalCost)} · ${formatCostWeightRatio(part.costWeightRatio)} its weight`}
                />
                <Meter pct={pct(part.estCostUsd, totalCost)} tone="ok" />
                <SubReadout
                  left={`${formatTokens(part.tokens)} tokens`}
                  right={`${formatShare(part.tokens, summary.week.totalTokens)} of traffic`}
                />
              </View>
            ))}
          </View>
        </>
      ) : null}

      {/* An unpriced model is not a zero — it is billed at the fallback rate, so
          the figure above is softer than it looks and says so. */}
      {summary.unpricedModels.length > 0 ? (
        <Text style={styles.note}>
          {summary.unpricedModels.length === 1
            ? `${summary.unpricedModels[0]} has no price on file and bills at the fallback rate.`
            : `${summary.unpricedModels.length} models have no price on file and bill at the fallback rate.`}
        </Text>
      ) : null}

      <Text style={styles.note}>
        Harvested from harness transcripts on the machines you run agents on. Windows are rolling.
      </Text>
    </>
  )
}

/** Six hours of the week, as the phone's trace plots it. */
interface Block {
  startMs: number
  estCostUsd: number
  /** The weekday initial when this block opens a day, else ''. */
  dayTick: string
  /** `Fri 18–24` — only ever shown for the peak. */
  label: string
}

const BLOCK_HOURS = 6
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/**
 * Fold the shared module's hour slots into six-hour bars.
 *
 * Future hours (the tail of today) are dropped rather than plotted as zero: an
 * hour that has not happened is not a quiet hour, and a run of empty bars at the
 * right edge reads as a collapse in spend.
 */
function blockify(days: UsageDay[]): Block[] {
  const out: Block[] = []
  for (const day of days) {
    for (let i = 0; i < day.hours.length; i += BLOCK_HOURS) {
      const slice = day.hours.slice(i, i + BLOCK_HOURS)
      if (slice.every((h) => h.future)) continue
      const start = slice[0]
      if (!start) continue
      const from = new Date(start.startMs).getHours()
      const weekday = WEEKDAY_INITIALS[new Date(start.startMs).getDay()] ?? ''
      out.push({
        startMs: start.startMs,
        estCostUsd: slice.reduce((sum, h) => sum + h.estCostUsd, 0),
        dayTick: from === 0 ? weekday : '',
        label: `${day.label.split(' ')[0] ?? ''} ${String(from).padStart(2, '0')}–${String(from + BLOCK_HOURS).padStart(2, '0')}`,
      })
    }
  }
  return out
}

const PROVIDER_LABEL: Record<UsageProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  other: 'Other',
}

/** Percent of a whole, clamped, for a rail width. */
function pct(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <View style={styles.switcher}>
      {(
        [
          ['now', 'Now'],
          ['week', '7 days'],
        ] as const
      ).map(([key, label]) => {
        const active = mode === key
        return (
          <PressableScale
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={key === 'now' ? 'Now — capacity' : 'Seven days — usage'}
            onPress={() => onChange(key)}
            style={[styles.tab, active && styles.tabActive]}
          >
            <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
          </PressableScale>
        )
      })}
    </View>
  )
}

/** Cold AND unreachable — the one state with nothing truthful to draw. */
function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      title="No reading"
      body="Couldn't reach the daemon for quota or usage. Pull to try again."
      icon={
        <PressableScale accessibilityRole="button" accessibilityLabel="Try again" onPress={onRetry}>
          <Text style={styles.retry}>Retry</Text>
        </PressableScale>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Small mappings
// ---------------------------------------------------------------------------

const TONE_COLOR: Record<QuotaTone, string> = {
  ok: color.working,
  warn: color.accent,
  crit: color.danger,
}

const SEVERITY_TONE: Record<'ok' | 'warn' | 'critical', MeterTone> = {
  ok: 'ok',
  warn: 'warn',
  critical: 'crit',
}

/** A rail showing what is LEFT still takes its tone from what is SPENT — the
 *  thresholds are the same ones the desktop meters use. */
function meterToneForLeft(usedPercent: number): MeterTone {
  return percentTone(usedPercent)
}

/** Claude's terracotta is a BRAND mark, not a status colour — it never competes
 *  with the tones the meters use. Every other harness stays neutral. */
const markColor = (agent: AgentKind): string =>
  agent === 'claude-code' ? color.claude : color.body
const markBorder = (agent: AgentKind): string =>
  agent === 'claude-code' ? color.claude : color.border

const styles = StyleSheet.create({
  content: {
    paddingBottom: space.xl,
  },
  stamp: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
  switcher: {
    flexDirection: 'row',
    marginHorizontal: space.lg,
    marginTop: space.sm,
    marginBottom: space.xs,
    padding: 3,
    backgroundColor: color.bar,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    borderRadius: radius.lg,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 34,
    borderRadius: radius.sm,
  },
  tabActive: {
    backgroundColor: color.surfaceHigh,
  },
  tabText: {
    ...monoLabel(),
    color: color.textFaint,
  },
  tabTextActive: {
    color: color.body,
  },
  hero: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  heroState: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  microLabel: {
    ...monoLabel(),
    color: color.label,
  },
  // The screen title is the bigger of the two on purpose: two 28pt lines
  // separated only by the switcher compete, and "Pulse" names where you are.
  heroHeadline: {
    ...sans(600),
    color: color.text,
    fontSize: font.title,
    letterSpacing: tracking[font.title],
    marginTop: space.sm,
    marginBottom: 5,
  },
  heroDetail: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
    maxWidth: 320,
  },
  heroLead: {
    ...sans(500),
    color: color.body,
  },
  paired: {
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  metric: {
    paddingVertical: space.md + 2,
  },
  metricDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  section: {
    paddingHorizontal: space.lg,
  },
  sectionNote: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
  quotaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.md,
  },
  rowDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  mark: {
    width: 29,
    height: 29,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: {
    ...mono(600),
    fontSize: font.micro,
  },
  quotaBody: {
    flex: 1,
    minWidth: 0,
  },
  quotaName: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
  },
  quotaDetail: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    marginTop: 3,
  },
  quotaNote: {
    ...sans(400),
    color: color.textMicro,
    fontSize: font.micro,
    lineHeight: leading(11, 'prose'),
    marginTop: 7,
  },
  quotaFigure: {
    alignItems: 'flex-end',
  },
  quotaPct: {
    ...mono(600),
    color: color.text,
    fontSize: font.small,
  },
  quotaPctLabel: {
    ...monoLabel(),
    color: color.textFaint,
    marginTop: 3,
  },
  weekGlance: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.lg,
    paddingTop: space.md,
  },
  weekFigures: {
    width: 118,
  },
  weekNumber: {
    ...mono(600),
    color: color.text,
    fontSize: font.title,
    letterSpacing: -0.8,
  },
  weekCaption: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.micro,
    lineHeight: leading(11, 'prose'),
    marginTop: 4,
  },
  weekChart: {
    flex: 1,
  },
  readoutBlock: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  dateWindow: {
    ...monoLabel(),
    color: color.textFaint,
  },
  money: {
    ...mono(600),
    color: color.text,
    fontSize: font.largeTitle,
    letterSpacing: -1.4,
    marginTop: space.sm,
    marginBottom: 3,
  },
  moneyStar: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  rate: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  caveat: {
    ...sans(400),
    color: color.textMicro,
    fontSize: font.micro,
    lineHeight: leading(11, 'prose'),
    marginTop: 8,
  },
  savings: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  savingsText: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  savingsFigure: {
    ...sans(600),
    color: color.body,
  },
  trace: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  traceHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.sm,
    marginBottom: space.md,
  },
  dayTicks: {
    flexDirection: 'row',
    // The same 2pt gutter the bars use, so a tick sits under the bar it names
    // rather than a fraction of a slot to its left.
    gap: 2,
    marginTop: 7,
  },
  dayTick: {
    ...mono(400),
    flex: 1,
    textAlign: 'center',
    color: color.textMicro,
    fontSize: font.micro,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.md,
  },
  providerBody: {
    flex: 1,
    minWidth: 0,
  },
  providerName: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
  },
  providerSub: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    marginTop: 3,
  },
  providerFigure: {
    alignItems: 'flex-end',
  },
  providerCost: {
    ...mono(600),
    color: color.text,
    fontSize: font.small,
  },
  providerReplies: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    marginTop: 3,
  },
  note: {
    ...sans(400),
    color: color.textMicro,
    fontSize: font.micro,
    lineHeight: leading(11, 'prose'),
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  retry: {
    ...sans(600),
    color: color.accent,
    fontSize: font.small,
  },
})
