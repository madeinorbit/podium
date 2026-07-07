import type { AgentKind, AgentQuotaWire, MachineQuotaWire, QuotaWindowWire } from '@podium/protocol'

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

export function statusNote(a: Pick<AgentQuotaWire, 'status' | 'error'>): string {
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

/**
 * One rate-limit bucket: an (agent, account) pair. Quota windows belong to an
 * account, not a machine — two machines signed into the same account share the
 * same limit — so the overlay groups by account and lists the machine(s) each is
 * used on, instead of repeating identical limits per machine.
 */
export interface AccountQuotaGroup {
  key: string
  agent: AgentKind
  account?: { email?: string; plan?: string }
  machineNames: string[]
  status: AgentQuotaWire['status']
  windows: QuotaWindowWire[]
  error?: string
  fetchedAt: string
}

/**
 * Fold the per-machine quota into per-account buckets:
 *  - drop agents a machine isn't signed into (`unauthenticated`) — no card;
 *  - dedupe (agent, account-email) across machines into one card that lists every
 *    machine using it (falling back to per-machine when no email is available, so
 *    we never merge two machines we can't prove share an account);
 *  - prefer a healthy read: if one machine can read the account and another can't,
 *    the card shows the readable windows.
 */
export function groupQuotaByAccount(machines: MachineQuotaWire[]): AccountQuotaGroup[] {
  const groups = new Map<string, AccountQuotaGroup>()
  for (const machine of machines) {
    for (const agent of machine.agents) {
      if (agent.status === 'unauthenticated') continue
      const email = agent.account?.email
      const key = email
        ? `${agent.agent}::${email}`
        : `${agent.agent}::machine:${machine.machineId}`
      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, {
          key,
          agent: agent.agent,
          ...(agent.account ? { account: agent.account } : {}),
          machineNames: [machine.machineName],
          status: agent.status,
          windows: agent.windows,
          ...(agent.error ? { error: agent.error } : {}),
          fetchedAt: agent.fetchedAt,
        })
        continue
      }
      if (!existing.machineNames.includes(machine.machineName)) {
        existing.machineNames.push(machine.machineName)
      }
      if (existing.status !== 'ok' && agent.status === 'ok') {
        existing.status = 'ok'
        existing.windows = agent.windows
        existing.fetchedAt = agent.fetchedAt
        existing.error = undefined
        if (agent.account) existing.account = agent.account
      }
    }
  }
  return [...groups.values()]
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
