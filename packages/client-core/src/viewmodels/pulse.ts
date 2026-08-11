/**
 * CAPACITY — the one question a phone is actually holding when it opens the
 * usage screen: *can I safely start more work right now?* [POD-662]
 *
 * The two feeds that answer it are already derived elsewhere and neither
 * answers it alone. Plan quota says whether the provider will still serve you;
 * host load says whether the machine will still run what it serves. Whichever
 * is closer to its own intervention point is the constraint, and naming it is
 * the whole job — the meters below the sentence are the evidence for it, not
 * the answer.
 *
 * THE ANSWER COMES FROM THE ROOMIEST OPTION, NOT THE TIGHTEST ONE [POD-754].
 * A fleet holds several independent pools and several hosts, and work starts on
 * ONE of them. Reading the worst of them as the verdict said "no room to start"
 * with a spent Grok subscription sitting next to a barely-touched Claude and an
 * untouched Codex — a stop that was not happening, the same error `quotaVerdict`
 * avoids per-window (POD-271) reappearing across pools. So the sentence speaks
 * for the option you could actually start on, and what IS out is named beside
 * it as a caveat rather than being allowed to speak for everything else.
 *
 * The verdict is stated in REMAINING terms ("62% left"), against the web's
 * used-percent instrument well. A desk instrument reports consumption; a pocket
 * one is asked for runway, and inverting the number at the last moment in each
 * view is how the two drift.
 *
 * Platform-neutral: no DOM, no storage.
 */
import type { AgentKind, HostMetricsWire, MachineQuotaWire } from '@podium/model'
import {
  type AccountQuotaGroup,
  agentLabel,
  formatReset,
  groupQuotaByAccount,
  type QuotaTone,
  splitQuotaWindows,
} from './quota'
import { type HostLoadView, hostLoadView } from './slices/machines/facts'

/** One pool's runway: its own tightest gating window, in remaining terms. */
export interface QuotaRunway {
  /** The `AccountQuotaGroup` key this came from — stable per (agent, account). */
  key: string
  agent: AgentKind
  /** "Codex", "Claude Code" — the harness, not the account. */
  agentName: string
  /** The provider's own window name, e.g. "5-hour" / "Weekly". */
  windowLabel: string
  usedPercent: number
  /** `100 - usedPercent`, clamped — what the hero sentence reports. */
  leftPercent: number
  resetsAt: string
  windowMinutes: number
}

/** Above this a pool has nothing left to give — the same line `quotaVerdict` draws. */
const SPENT_PERCENT = 90

/** The host closest to its parking threshold. */
export interface TightestLoad extends HostLoadView {
  hostname: string
  machineId: string | undefined
}

export interface CapacityView {
  tone: QuotaTone
  /** Three words at most — the answer, before any number. */
  headline: string
  /** Which reading the headline came from. */
  constraint: 'quota' | 'load' | 'unknown'
  /** Names the constraint: "Quota is the tighter limit." */
  lead: string
  /** The evidence, one sentence: which pool, how much is left, until when. */
  detail: string
  /** What is out of room while the answer above still stands, or null. */
  caveat: string | null
  /** The pool the answer speaks for — the one with the most room to start on. */
  quota: QuotaRunway | null
  /** The host the answer speaks for — the one with the most headroom. */
  load: TightestLoad | null
  /** Every readable pool, roomiest first. */
  pools: QuotaRunway[]
  /** The pools with nothing left to give — what the caveat is drawn from. */
  spentPools: QuotaRunway[]
}

/**
 * Every readable pool's own runway, roomiest first.
 *
 * ONE ROW PER POOL, not per window: a pool is gated by its tightest gating
 * window, and a pool is the unit you start work on. GATING ONLY, for the same
 * reason `quotaVerdict` is gating-only: a spent model-scoped window costs you
 * that model, not the harness, so letting one speak for the pool would report a
 * stop that is not happening (POD-271).
 */
export function quotaRunways(groups: AccountQuotaGroup[]): QuotaRunway[] {
  const runways: QuotaRunway[] = []
  for (const group of groups) {
    if (group.status !== 'ok') continue
    let worst: QuotaRunway | null = null
    for (const w of splitQuotaWindows(group.windows).gating) {
      if (worst && w.usedPercent <= worst.usedPercent) continue
      worst = {
        key: group.key,
        agent: group.agent,
        agentName: agentLabel(group.agent),
        windowLabel: w.label,
        usedPercent: w.usedPercent,
        leftPercent: Math.max(0, Math.min(100, 100 - w.usedPercent)),
        resetsAt: w.resetsAt,
        windowMinutes: w.windowMinutes,
      }
    }
    if (worst) runways.push(worst)
  }
  return runways.sort((a, b) => b.leftPercent - a.leftPercent)
}

/**
 * The pool with the most room — the one work would actually start on, and so
 * the one the capacity sentence speaks for.
 */
export function roomiestQuota(groups: AccountQuotaGroup[]): QuotaRunway | null {
  return quotaRunways(groups)[0] ?? null
}

/** The gating window with the least headroom, across every pool we can read. */
export function tightestQuota(groups: AccountQuotaGroup[]): QuotaRunway | null {
  const runways = quotaRunways(groups)
  return runways[runways.length - 1] ?? null
}

/**
 * Every host that reports load, measured against the point where Podium starts
 * parking agents, freest first.
 *
 * Against that threshold rather than a notional 100%: "4.8 of 12.0" means
 * nothing on its own, while "40% of the way to the park line" is a prediction
 * about what the machine is about to do to your sessions.
 */
export function loadRunways(
  hosts: readonly HostMetricsWire[],
  loadPerCore: number | null,
): TightestLoad[] {
  const views: TightestLoad[] = []
  for (const host of hosts) {
    const view = hostLoadView(host, loadPerCore)
    if (view.perCore === null) continue
    views.push({ ...view, hostname: host.hostname, machineId: host.machineId })
  }
  return views.sort((a, b) => a.meterPct - b.meterPct)
}

/** The host with the most headroom — where work would go if it started now. */
export function freestLoad(
  hosts: readonly HostMetricsWire[],
  loadPerCore: number | null,
): TightestLoad | null {
  return loadRunways(hosts, loadPerCore)[0] ?? null
}

/** The host closest to the point where Podium starts parking agents. */
export function tightestLoad(
  hosts: readonly HostMetricsWire[],
  loadPerCore: number | null,
): TightestLoad | null {
  const views = loadRunways(hosts, loadPerCore)
  return views[views.length - 1] ?? null
}

const HEADLINES: Record<QuotaTone, string> = {
  ok: 'Room to run',
  warn: 'Running close',
  crit: 'No room to start',
}

/** `13:00` — a local wall clock, for "resets at". */
export function formatWallClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The pocket answer. Both feeds are normalised to "percent of the way to the
 * point where something intervenes", which is the only scale on which a quota
 * window and a load average can be compared at all, and the higher one speaks.
 *
 * Each feed offers its BEST option first — the roomiest pool, the freest host —
 * because that is the one work would start on, and a fleet is not stopped by
 * the one member of it that is spent. Between those two the higher pressure
 * still speaks: the best pool and the best host must BOTH be usable to start.
 *
 * Ties go to quota: it is the limit that stops the work outright, where load
 * merely parks sessions that resume.
 */
export function capacityView(args: {
  machines: readonly MachineQuotaWire[] | null
  hosts: readonly HostMetricsWire[]
  loadPerCore: number | null
  nowMs: number
}): CapacityView {
  const groups = groupQuotaByAccount([...(args.machines ?? [])])
  const pools = quotaRunways(groups)
  const quota = pools[0] ?? null
  const spentPools = pools.filter((p) => p.usedPercent > SPENT_PERCENT)
  const hosts = loadRunways(args.hosts, args.loadPerCore)
  const load = hosts[0] ?? null
  const busiest = hosts[hosts.length - 1] ?? null

  const quotaPressure = quota?.usedPercent ?? -1
  const loadPressure = load?.meterPct ?? -1
  const constraint: CapacityView['constraint'] =
    quotaPressure < 0 && loadPressure < 0
      ? 'unknown'
      : quotaPressure >= loadPressure
        ? 'quota'
        : 'load'
  const pressure = Math.max(quotaPressure, loadPressure)
  const tone: QuotaTone =
    pressure < 0 ? 'ok' : pressure > 90 ? 'crit' : pressure >= 75 ? 'warn' : 'ok'

  if (constraint === 'unknown') {
    return {
      tone: 'ok',
      headline: 'Nothing to report',
      constraint,
      lead: 'No readings yet.',
      detail: 'Quota and host pressure arrive once a machine is online.',
      caveat: null,
      quota: null,
      load: null,
      pools,
      spentPools,
    }
  }

  const caveat = capacityCaveat({ quota, spentPools, load, busiest, nowMs: args.nowMs })

  // WITH NOTHING NEAR A LIMIT there is no "tighter" of the two worth naming —
  // a host at 20% of its park line is not a constraint, it is a Tuesday. The
  // sentence then reports the runway you actually plan against, which is quota:
  // host load fluctuates and recovers on its own, a spent window does not.
  if (tone === 'ok' && quota) {
    return {
      tone,
      headline: HEADLINES[tone],
      constraint: 'quota',
      lead: 'Nothing you can start on is near a limit.',
      detail: quotaDetail(quota, pools.length, args.nowMs),
      caveat,
      quota,
      load,
      pools,
      spentPools,
    }
  }

  if (constraint === 'quota' && quota) {
    return {
      tone,
      headline: HEADLINES[tone],
      constraint,
      lead: load ? 'Quota is the tighter limit.' : 'Quota is the limit in view.',
      detail: quotaDetail(quota, pools.length, args.nowMs),
      caveat,
      quota,
      load,
      pools,
      spentPools,
    }
  }

  // Load is the constraint. `load` is non-null here — `constraint` is only
  // 'load' when its pressure beat quota's, which requires a reading.
  const l = load as TightestLoad
  const where = hosts.length > 1 ? ', the freest host,' : ''
  return {
    tone,
    headline: HEADLINES[tone],
    constraint,
    lead: quota ? 'Host pressure is the tighter limit.' : 'Host pressure is the limit in view.',
    detail:
      l.meterPct >= 100
        ? `${l.hostname}${where} is past the park line at ${l.label} per core — idle agents are being parked.`
        : `${l.hostname}${where} is at ${l.meterPct}% of its park line, ${l.label} per core.`,
    caveat,
    quota,
    load,
    pools,
    spentPools,
  }
}

/**
 * The quota half of the sentence. With more than one pool the figure is not
 * "the" quota but the best of several, and saying so keeps the reader from
 * reading it as the whole fleet's state — the spent ones are in the caveat.
 */
function quotaDetail(quota: QuotaRunway, poolCount: number, nowMs: number): string {
  const most = poolCount > 1 ? ' the most room,' : ''
  return `${quota.agentName} has${most} ${Math.round(quota.leftPercent)}% left${resetPhrase(quota, nowMs)}.`
}

/**
 * What is out of room while the sentence above still stands.
 *
 * Only ever a caveat: it names losses the answer has deliberately not let speak
 * — a spent pool beside pools that still run, a parked host beside hosts that
 * still take work. When the loss IS the answer (every pool spent, every host
 * past the line) the detail already said so and there is nothing to add.
 */
function capacityCaveat(args: {
  quota: QuotaRunway | null
  spentPools: QuotaRunway[]
  load: TightestLoad | null
  busiest: TightestLoad | null
  nowMs: number
}): string | null {
  const parts: string[] = []
  const { quota, spentPools, load, busiest } = args
  const [firstSpent, ...restSpent] = spentPools
  if (quota && quota.usedPercent <= SPENT_PERCENT && firstSpent) {
    if (restSpent.length === 0) {
      // One pool out: say when it comes back, which is the only thing left to
      // decide about it.
      const back = formatReset(firstSpent.resetsAt, args.nowMs)
      parts.push(`${firstSpent.agentName} is out${back ? ` — ${back}` : ''}.`)
    } else {
      const names = [firstSpent, ...restSpent].map((p) => p.agentName)
      const last = names[names.length - 1]
      parts.push(`${names.slice(0, -1).join(', ')} and ${last} are out.`)
    }
  }
  if (load && busiest && load.meterPct < 100 && busiest.meterPct >= 100) {
    parts.push(`${busiest.hostname} is past its park line — agents there are being parked.`)
  }
  return parts.length > 0 ? parts.join(' ') : null
}

/** " until its five-hour window resets at 23:50" — relative once a day is too far off. */
function resetPhrase(runway: QuotaRunway, nowMs: number): string {
  const window = ` its ${lowerWindow(runway.windowLabel)} window`
  const resetMs = Date.parse(runway.resetsAt)
  if (!Number.isFinite(resetMs)) return ` on${window}`
  // A wall clock answers "when does this come back" only while it is today; a
  // weekly window reading "resets at 21:37" invites the wrong day entirely.
  return resetMs - nowMs > 24 * 3_600_000
    ? ` until${window} resets ${formatReset(runway.resetsAt, nowMs).replace(/^resets /, '')}`
    : ` until${window} resets at ${formatWallClock(resetMs)}`
}

/** "5-hour" → "five-hour" reads as prose; "Weekly" → "weekly". */
function lowerWindow(label: string): string {
  return label.replace(/^5-hour$/i, 'five-hour').toLowerCase()
}
