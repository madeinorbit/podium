import type { AgentKind, AgentQuotaWire } from '@podium/protocol'
import { fetchClaudeQuota } from './quota-claude'
import { fetchCodexQuota } from './quota-codex'

export type QuotaFetcher = (deps: { homeDir?: string; now?: number }) => Promise<AgentQuotaWire>

const DEFAULT_FETCHERS: { agent: AgentKind; fetch: QuotaFetcher }[] = [
  { agent: 'claude-code', fetch: fetchClaudeQuota },
  { agent: 'codex', fetch: fetchCodexQuota },
]
const DEFAULT_TTL_MS = 60_000

export function makeQuotaFetcher(
  opts: { homeDir?: string; ttlMs?: number; now?: () => number; fetchers?: { agent: AgentKind; fetch: QuotaFetcher }[] } = {},
): { getAgentQuota(refresh?: boolean): Promise<AgentQuotaWire[]> } {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now
  const fetchers = opts.fetchers ?? DEFAULT_FETCHERS
  const cache = new Map<AgentKind, { atMs: number; wire: AgentQuotaWire }>()

  const one = async (f: { agent: AgentKind; fetch: QuotaFetcher }, refresh: boolean): Promise<AgentQuotaWire> => {
    const t = now()
    const cached = cache.get(f.agent)
    if (!refresh && cached && t - cached.atMs < ttl) return cached.wire
    let wire: AgentQuotaWire
    try {
      wire = await f.fetch({ ...(opts.homeDir ? { homeDir: opts.homeDir } : {}), now: t })
    } catch (e) {
      wire = { agent: f.agent, status: 'error', windows: [], error: e instanceof Error ? e.message : String(e), fetchedAt: new Date(t).toISOString() }
    }
    cache.set(f.agent, { atMs: t, wire })
    return wire
  }

  return {
    getAgentQuota: (refresh = false) => Promise.all(fetchers.map((f) => one(f, refresh))),
  }
}
