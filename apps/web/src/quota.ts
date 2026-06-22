import type { AgentKind, AgentQuotaWire, QuotaWindowWire } from '@podium/protocol'

/** "resets in 40m" / "resets in 2h 14m" / "resets in 1d 4h". */
export function formatReset(resetsAt: string, nowMs: number): string {
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t)) return ''
  const ms = t - nowMs
  if (ms <= 0) return 'resetting…'
  const mins = Math.round(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `resets in ${d}d ${h}h`
  if (h > 0) return `resets in ${h}h ${m}m`
  return `resets in ${m}m`
}

export type QuotaTone = 'ok' | 'warn' | 'crit'
export function percentTone(p: number): QuotaTone {
  if (p > 90) return 'crit'
  if (p >= 75) return 'warn'
  return 'ok'
}
export function toneBarClass(t: QuotaTone): string {
  return t === 'crit' ? 'bg-red-500' : t === 'warn' ? 'bg-amber-500' : 'bg-emerald-500'
}

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  shell: 'Shell',
}
export function agentLabel(agent: AgentKind): string {
  return AGENT_LABELS[agent] ?? agent
}

export function statusNote(a: AgentQuotaWire): string {
  switch (a.status) {
    case 'unauthenticated':
      return 'Not signed in'
    case 'expired':
      return a.error ?? 'Token expired'
    case 'error':
      return a.error ?? 'Unavailable'
    default:
      return ''
  }
}

/** Share of the rolling window already elapsed (0–100), from reset time + duration. */
export function windowElapsedPercent(
  resetsAt: string,
  windowMinutes: number,
  nowMs: number,
): number | null {
  const resetMs = Date.parse(resetsAt)
  if (Number.isNaN(resetMs) || windowMinutes <= 0) return null
  const windowMs = windowMinutes * 60_000
  const remainingMs = resetMs - nowMs
  if (remainingMs <= 0) return 100
  const elapsedMs = windowMs - remainingMs
  if (elapsedMs <= 0) return 0
  return Math.min(100, Math.max(0, (elapsedMs / windowMs) * 100))
}

/** Whether usage pace matches time elapsed — will quota last until the window ends? */
export type QuotaPace = 'comfortable' | 'on-pace' | 'hot'

const PACE_TOLERANCE = 8

export function quotaPace(usedPercent: number, elapsedPercent: number | null): QuotaPace | null {
  if (elapsedPercent === null || elapsedPercent <= 0) return null
  const delta = usedPercent - elapsedPercent
  if (delta > PACE_TOLERANCE) return 'hot'
  if (delta < -PACE_TOLERANCE) return 'comfortable'
  return 'on-pace'
}

export function windowPace(w: QuotaWindowWire, nowMs: number): QuotaPace | null {
  const elapsed = windowElapsedPercent(w.resetsAt, w.windowMinutes, nowMs)
  return quotaPace(w.usedPercent, elapsed)
}

export function paceLabel(pace: QuotaPace): string {
  switch (pace) {
    case 'comfortable':
      return 'Headroom'
    case 'on-pace':
      return 'On pace'
    case 'hot':
      return "Won't last"
  }
}

export function paceHint(pace: QuotaPace, usedPercent: number, elapsedPercent: number): string {
  const used = Math.round(usedPercent)
  const elapsed = Math.round(elapsedPercent)
  switch (pace) {
    case 'comfortable':
      return `${used}% used with ${elapsed}% of the window elapsed — pace is below time, so quota should last.`
    case 'on-pace':
      return `${used}% used, ${elapsed}% elapsed — usage tracks the window; should last until reset.`
    case 'hot':
      return `${used}% used with only ${elapsed}% elapsed — burning faster than time; may hit the limit early.`
  }
}
