/**
 * Quota + usage reads — the harness-free half of the Inventory usage axis
 * (POD-4414 §4.4, issue 3.3).
 *
 * WHAT IS GENERIC LIVES HERE: the quota TTL memo (stale-while-revalidate),
 * the quota-history fan-out, and the host usage fan-out over the registry.
 * WHAT IS VENDOR-SPECIFIC LIVES IN `adapters/<harness>/usage.ts`: the
 * endpoint probe, the history recovery walk, and the transcript harvest walk.
 * This module iterates supported sections and never names a harness — kinds
 * flow as values from the manifests.
 */
import type { AgentKind, AgentQuotaWire, UsageBucketWire, UsageSourceWire } from '@podium/model'
import type { QuotaHistorySampleWire } from '@podium/protocol'
import {
  declaredValue,
  type HarnessQuotaHistory,
  type HarnessQuotaProbe,
  type HarnessUsageTranscripts,
} from '../manifest.js'
import { AGENT_MANIFESTS, manifestFor } from '../registry.js'
import {
  fileBuckets,
  mergeBuckets,
  toSource,
  windowBuckets,
  type UsageScanCache,
} from '../usage-records.js'

export type QuotaFetcher = (deps: { homeDir?: string; now?: number }) => Promise<AgentQuotaWire>

/**
 * Presentational label for a quota agent, read off the manifest so the CLI
 * never keeps a second label table that drifts from it (POD-4414 §4.4).
 * Unknown ids — 'shell', or a harness a newer peer named that this build has
 * never heard of — degrade to a capitalized id, never to another CLI's label.
 */
export function quotaAgentLabel(kind: string): string {
  const display = manifestFor(kind)?.displayName
  if (display) return display
  return kind.length > 0 ? kind.charAt(0).toUpperCase() + kind.slice(1) : kind
}

function defaultQuotaFetchers(): { key: AgentKind; fetch: QuotaFetcher }[] {
  const fetchers: { key: AgentKind; fetch: QuotaFetcher }[] = []
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    const usage = declaredValue(manifest.usage)
    const quota = usage ? declaredValue(usage.quota) : undefined
    if (!quota) continue
    const probe: HarnessQuotaProbe = quota
    fetchers.push({ key: manifest.kind, fetch: (deps) => probe.fetchQuota(deps) })
  }
  return fetchers
}

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
    fetchers?: { key: AgentKind; fetch: QuotaFetcher }[]
  } = {},
): { getAgentQuota(refresh?: boolean): Promise<AgentQuotaWire[]> } {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now
  const fetchers = opts.fetchers ?? defaultQuotaFetchers()
  const cache = new Map<AgentKind, { atMs: number; wire: AgentQuotaWire }>()
  /** One refresh per agent at a time. Three tabs polling past the TTL are three
   *  stale reads and ONE vendor call, not three. */
  const inFlight = new Map<AgentKind, Promise<AgentQuotaWire>>()

  const runFetch = (f: { key: AgentKind; fetch: QuotaFetcher }): Promise<AgentQuotaWire> => {
    const pending = inFlight.get(f.key)
    if (pending) return pending
    const t = now()
    const started = (async () => {
      let wire: AgentQuotaWire
      try {
        wire = await f.fetch({ ...(opts.homeDir ? { homeDir: opts.homeDir } : {}), now: t })
      } catch (e) {
        wire = {
          agent: f.key,
          status: 'error',
          windows: [],
          error: e instanceof Error ? e.message : String(e),
          fetchedAt: new Date(t).toISOString(),
        }
      }
      // An errored fetch is never cached, so a blip retries on the next read
      // rather than pinning an error for a whole TTL.
      if (wire.status !== 'error') cache.set(f.key, { atMs: t, wire })
      return wire
    })().finally(() => {
      inFlight.delete(f.key)
    })
    inFlight.set(f.key, started)
    return started
  }

  const one = async (
    f: { key: AgentKind; fetch: QuotaFetcher },
    refresh: boolean,
  ): Promise<AgentQuotaWire> => {
    const cached = cache.get(f.key)
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

/**
 * Drop readings that repeat the one before them, keeping every transition.
 *
 * A harness reports the same `used_percent` on every turn of a quiet stretch, so
 * the raw stream is overwhelmingly duplicates — measured on Codex, 89,843 events
 * carry roughly 7,400 actual changes. Only movements need to cross the wire; the
 * fold reconstructs the flat stretches between them.
 *
 * Comparison is against the PREVIOUS EMITTED sample, per window key. The streams
 * are interleaved by time, so a per-key predecessor would be the right unit if a
 * harness ever reported two windows at once; today each scanned harness emits a
 * single key, and the guard below keeps the two cases from merging.
 */
function dedupeConsecutive(samples: QuotaHistorySampleWire[]): QuotaHistorySampleWire[] {
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs)
  const out: QuotaHistorySampleWire[] = []
  for (const sample of sorted) {
    const prev = out[out.length - 1]
    if (
      prev &&
      prev.windowKey === sample.windowKey &&
      prev.usedPercent === sample.usedPercent &&
      prev.plan === sample.plan &&
      // Keep a sample that crosses a reset even when the percentage matches, or
      // two adjacent windows that both sat at 0% would merge into one.
      Math.abs(prev.resetsAtMs - sample.resetsAtMs) < 60_000
    ) {
      continue
    }
    out.push(sample)
  }
  return out
}

/**
 * Everything this machine can recover, from every harness that declares a
 * history scan.
 *
 * GROK ONLY, DELIBERATELY — and the evidence lives with the declaration: each
 * harness's `usage.history` says supported or declined with the reason. The
 * Codex rollouts do carry `rate_limits`, and the Codex scanner reads them
 * correctly, but the series does not mean what the ledger would claim it means
 * (used_percent climbs to 100 and returns to 0 inside a single afternoon while
 * resets_at moves backwards). Codex history is therefore left to LIVE sampling;
 * its scanner stays exported and tested so re-enabling it is one line.
 */
export async function scanQuotaHistory(opts: {
  sinceMs: number
  machineId: string
  homeDir?: string
}): Promise<QuotaHistorySampleWire[]> {
  const sections: HarnessQuotaHistory[] = []
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    const usage = declaredValue(manifest.usage)
    const history = usage ? declaredValue(usage.history) : undefined
    if (history) sections.push(history)
  }
  const scans = await Promise.allSettled(sections.map((section) => section.scan(opts)))
  const samples = scans.flatMap((scan) => (scan.status === 'fulfilled' ? scan.value : []))
  return dedupeConsecutive(samples.filter((sample) => sample.atMs >= opts.sinceMs))
}

/**
 * Every harness on this box, folded into one bucket set.
 *
 * Settled independently on purpose: a Codex tree that throws mid-walk must cost
 * the sheet its Codex figures, not the Claude ones it already had. The caller
 * has one try/catch and would zero out both.
 */
export async function scanHostUsage(opts: {
  sinceMs: number
  homeDir?: string
}): Promise<UsageBucketWire[]> {
  return (await scanHostUsageSources(opts)).buckets
}

/**
 * The same walk, keeping WHICH FILE each record came from.
 *
 * `sources` is what makes per-task cost affordable: the server turns a path into
 * a session — and therefore into an issue — with one indexed lookup per FILE,
 * never per record. Two folds per source, on purpose. `windowModels` covers the
 * requested window and answers the usage sheet's by-task section; `models`
 * covers the whole file and is what the durable per-session row stores, because
 * "what did this task cost" outlives any window.
 *
 * `cache` is the incremental half. Transcripts are append-only, so a file whose
 * size and mtime are unchanged is not opened at all, and one that grew is read
 * from its cursor rather than from byte zero. Pass the SAME cache across scans
 * or every walk is a cold one.
 */
export async function scanHostUsageSources(opts: {
  sinceMs: number
  homeDir?: string
  cache?: UsageScanCache
}): Promise<{ buckets: UsageBucketWire[]; sources: UsageSourceWire[] }> {
  const sections: HarnessUsageTranscripts[] = []
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    const usage = declaredValue(manifest.usage)
    const transcripts = usage ? declaredValue(usage.transcripts) : undefined
    if (transcripts) sections.push(transcripts)
  }
  const scans = await Promise.allSettled([
    ...sections.map((section) =>
      section.scan({
        sinceMs: opts.sinceMs,
        ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
        ...(opts.cache ? { cache: opts.cache } : {}),
      }),
    ),
  ])
  const files = scans.flatMap((scan) => (scan.status === 'fulfilled' ? scan.value : []))
  // Files the window has moved past are never re-read, so holding their folds
  // would be a leak that grows with the age of the box.
  opts.cache?.prune(opts.sinceMs)
  return {
    buckets: mergeBuckets(files.flatMap((file) => windowBuckets(fileBuckets(file), opts.sinceMs))),
    sources: files.map((file) => toSource(file, opts.sinceMs)),
  }
}
