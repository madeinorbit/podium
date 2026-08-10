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
  groupQuotaByAccount,
  type QuotaTone,
  splitQuotaWindows,
} from './quota'
import { type HostLoadView, hostLoadView } from './slices/machines/facts'

/** The gating window with the least left across every readable pool. */
export interface TightestQuota {
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
  quota: TightestQuota | null
  load: TightestLoad | null
}

/**
 * The gating window with the least headroom, across every pool we can read.
 *
 * GATING ONLY, for the same reason `quotaVerdict` is gating-only: a spent
 * model-scoped window costs you that model, not the harness, so letting one
 * headline the screen would report a stop that is not happening (POD-271).
 */
export function tightestQuota(groups: AccountQuotaGroup[]): TightestQuota | null {
  let hit: TightestQuota | null = null
  for (const group of groups) {
    if (group.status !== 'ok') continue
    for (const w of splitQuotaWindows(group.windows).gating) {
      if (hit && w.usedPercent <= hit.usedPercent) continue
      hit = {
        agent: group.agent,
        agentName: agentLabel(group.agent),
        windowLabel: w.label,
        usedPercent: w.usedPercent,
        leftPercent: Math.max(0, Math.min(100, 100 - w.usedPercent)),
        resetsAt: w.resetsAt,
        windowMinutes: w.windowMinutes,
      }
    }
  }
  return hit
}

/**
 * The host closest to the point where Podium starts parking agents.
 *
 * Measured against that threshold rather than against a notional 100%: "4.8 of
 * 12.0" means nothing on its own, while "40% of the way to the park line" is a
 * prediction about what the machine is about to do to your sessions.
 */
export function tightestLoad(
  hosts: readonly HostMetricsWire[],
  loadPerCore: number | null,
): TightestLoad | null {
  let hit: TightestLoad | null = null
  for (const host of hosts) {
    const view = hostLoadView(host, loadPerCore)
    if (view.perCore === null) continue
    if (hit && view.meterPct <= hit.meterPct) continue
    hit = { ...view, hostname: host.hostname, machineId: host.machineId }
  }
  return hit
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
  const quota = tightestQuota(groups)
  const load = tightestLoad(args.hosts, args.loadPerCore)

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
      quota: null,
      load: null,
    }
  }

  if (constraint === 'quota' && quota) {
    const resetMs = Date.parse(quota.resetsAt)
    const until = Number.isFinite(resetMs)
      ? ` until its ${lowerWindow(quota.windowLabel)} window resets at ${formatWallClock(resetMs)}`
      : ` on its ${lowerWindow(quota.windowLabel)} window`
    return {
      tone,
      headline: HEADLINES[tone],
      constraint,
      lead: load ? 'Quota is the tighter limit.' : 'Quota is the limit in view.',
      detail: `${quota.agentName} has ${Math.round(quota.leftPercent)}% left${until}.`,
      quota,
      load,
    }
  }

  // Load is the constraint. `load` is non-null here — `constraint` is only
  // 'load' when its pressure beat quota's, which requires a reading.
  const l = load as TightestLoad
  return {
    tone,
    headline: HEADLINES[tone],
    constraint,
    lead: quota ? 'Host pressure is the tighter limit.' : 'Host pressure is the limit in view.',
    detail:
      l.meterPct >= 100
        ? `${l.hostname} is past the park line at ${l.label} per core — idle agents are being parked.`
        : `${l.hostname} is at ${l.meterPct}% of its park line, ${l.label} per core.`,
    quota,
    load,
  }
}

/** "5-hour" → "five-hour" reads as prose; "Weekly" → "weekly". */
function lowerWindow(label: string): string {
  return label.replace(/^5-hour$/i, 'five-hour').toLowerCase()
}
