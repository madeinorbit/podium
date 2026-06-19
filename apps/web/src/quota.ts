import type { AgentKind, AgentQuotaWire } from '@podium/protocol'

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
