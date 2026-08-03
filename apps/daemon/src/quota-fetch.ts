import type { AgentKind, AgentQuotaWire } from '@podium/model'
import { fetchClaudeQuota } from './quota-claude'
import { fetchCodexQuota } from './quota-codex'
import { fetchGrokQuota } from './quota-grok'

export type QuotaFetcher = (deps: { homeDir?: string; now?: number }) => Promise<AgentQuotaWire>

const DEFAULT_FETCHERS: { agent: AgentKind; fetch: QuotaFetcher }[] = [
  { agent: 'claude-code', fetch: fetchClaudeQuota },
  { agent: 'codex', fetch: fetchCodexQuota },
  { agent: 'grok', fetch: fetchGrokQuota },
]
// The status chip polls every 60s; a 60s TTL is always exactly stale by the next
// poll, so the memo never serves and we re-fetch every poll. Keep the TTL above the
// poll interval (same fix the usage memo uses in daemon.ts) so a poll lands inside it.
//
// PAST THE TTL WE SERVE STALE RATHER THAN BLOCK (POD-1624). The TTL alone was never
// the whole fix: quota costs three LIVE vendor HTTP calls — measured on ludovico
// at claude 239-479ms, codex 349-537ms, grok 535-1171ms, issued concurrently — so a
// pure TTL memo still elects one caller every 120s to pay that latency in full. The
// server's `[perf] slow rpc quota.summary` line fired 380 times in 24h on exactly
// that ~2-minute cadence, and the caller paying it is the top bar on a page load.
// So the TTL now marks a value as WORTH REFRESHING, not as unusable: readers get the
// last good number immediately and the refetch lands out of band.
//
// WORST-CASE STALENESS is therefore TTL + one fetch (~120s + ~1.2s) instead of
// unbounded — a refresh is kicked off by the first read past the TTL, never lazily
// deferred — and every window already carries its own `fetchedAt` on the wire, so a
// reader that cares can see exactly how old the number is. `refresh: true` (the
// explicit "recheck now" path) still awaits a genuinely fresh fetch.
const DEFAULT_TTL_MS = 120_000

export function makeQuotaFetcher(
  opts: {
    homeDir?: string
    ttlMs?: number
    now?: () => number
    fetchers?: { agent: AgentKind; fetch: QuotaFetcher }[]
  } = {},
): { getAgentQuota(refresh?: boolean): Promise<AgentQuotaWire[]> } {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now
  const fetchers = opts.fetchers ?? DEFAULT_FETCHERS
  const cache = new Map<AgentKind, { atMs: number; wire: AgentQuotaWire }>()
  /** One refresh per agent at a time. Three tabs polling past the TTL are three
   *  stale reads and ONE vendor call, not three. */
  const inFlight = new Map<AgentKind, Promise<AgentQuotaWire>>()

  const runFetch = (f: { agent: AgentKind; fetch: QuotaFetcher }): Promise<AgentQuotaWire> => {
    const pending = inFlight.get(f.agent)
    if (pending) return pending
    const t = now()
    const started = (async () => {
      let wire: AgentQuotaWire
      try {
        wire = await f.fetch({ ...(opts.homeDir ? { homeDir: opts.homeDir } : {}), now: t })
      } catch (e) {
        wire = {
          agent: f.agent,
          status: 'error',
          windows: [],
          error: e instanceof Error ? e.message : String(e),
          fetchedAt: new Date(t).toISOString(),
        }
      }
      // An errored fetch is never cached, so a blip retries on the next read
      // rather than pinning an error for a whole TTL.
      if (wire.status !== 'error') cache.set(f.agent, { atMs: t, wire })
      return wire
    })().finally(() => {
      inFlight.delete(f.agent)
    })
    inFlight.set(f.agent, started)
    return started
  }

  const one = async (
    f: { agent: AgentKind; fetch: QuotaFetcher },
    refresh: boolean,
  ): Promise<AgentQuotaWire> => {
    const cached = cache.get(f.agent)
    // "Recheck now" is the one caller that genuinely wants to wait.
    if (refresh) return runFetch(f)
    if (cached && now() - cached.atMs < ttl) return cached.wire
    if (cached) {
      // STALE-WHILE-REVALIDATE: kick the refresh off synchronously so it is
      // always in flight by the time we return, then answer from the last good
      // value without awaiting it. A rejection cannot surface here as an
      // unhandled rejection because runFetch resolves errors into a wire.
      void runFetch(f)
      return cached.wire
    }
    // Nothing has ever been fetched for this agent — there is no number to serve,
    // so this one caller must wait.
    return runFetch(f)
  }

  return {
    getAgentQuota: (refresh = false) => Promise.all(fetchers.map((f) => one(f, refresh))),
  }
}
