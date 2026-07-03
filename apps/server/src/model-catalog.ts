import type { ModelChoice } from './model-probe'

/** Bumped whenever the probe's output SHAPE changes (e.g. per-model `efforts` added),
 *  so a persisted snapshot from an older build is ignored and re-probed instead of
 *  served stale within its TTL. */
export const MODEL_CATALOG_VERSION = 2

export interface ModelCatalogSnapshot {
  /** Live models keyed by agent kind (grok/cursor/opencode). Absent agents fall
   *  back to the web's static catalog. */
  byAgent: Record<string, ModelChoice[]>
  /** Epoch ms of the last successful probe; 0 = never fetched yet. */
  fetchedAt: number
  /** Shape version — a persisted snapshot with a different version is discarded. */
  version?: number
}

export type ModelProbe = () => Promise<Record<string, ModelChoice[]>>

/**
 * Stale-while-revalidate cache of the live per-agent model lists. A probe shells out
 * to `grok/cursor-agent/opencode models` (~2s warm, up to ~7s cold), so `get()` never
 * blocks: it returns the current snapshot and kicks a background refresh when the
 * snapshot is empty or older than the TTL. Purely query-driven — nothing runs (no CLI
 * spawns, no boot cost) unless a client actually asks for the catalog.
 */
export class ModelCatalog {
  private snapshot: ModelCatalogSnapshot = { byAgent: {}, fetchedAt: 0 }
  private inflight: Promise<void> | null = null

  // Default probe is an empty no-op so `new SessionRegistry()` (every test) never
  // shells out to the agent CLIs; the real `probeAllModels` is injected at boot in
  // startServer via SessionRegistryOptions.modelProbe.
  constructor(
    private readonly probe: ModelProbe = async () => ({}),
    private readonly opts: {
      ttlMs?: number
      now?: () => number
      /** Persist across restarts: `load` seeds the cache at boot (→ instant, non-cold
       *  first open after a redeploy); `save` writes each successful refresh. */
      load?: () => ModelCatalogSnapshot | null
      save?: (snapshot: ModelCatalogSnapshot) => void
    } = {},
  ) {
    // Only seed from a persisted snapshot of the CURRENT shape — an older one (e.g.
    // pre-`efforts`) is discarded so `get()` re-probes instead of serving it stale.
    const persisted = opts.load?.()
    if (persisted && persisted.version === MODEL_CATALOG_VERSION) this.snapshot = persisted
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private isStale(): boolean {
    const ttlMs = this.opts.ttlMs ?? 60 * 60 * 1000
    return this.snapshot.fetchedAt === 0 || this.now() - this.snapshot.fetchedAt > ttlMs
  }

  /** SWR read: returns the current snapshot immediately, refreshing in the
   *  background when it's empty or stale. Never blocks the caller. */
  get(): ModelCatalogSnapshot {
    if (this.isStale()) void this.refresh()
    return this.snapshot
  }

  /** Refresh now. Concurrent callers share one probe; a throwing probe keeps the
   *  last good snapshot (so a transiently-broken CLI doesn't wipe the cache). */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try {
        this.snapshot = {
          byAgent: await this.probe(),
          fetchedAt: this.now(),
          version: MODEL_CATALOG_VERSION,
        }
        this.opts.save?.(this.snapshot)
      } catch {
        // keep last-good; isStale() retries on the next get() past the TTL
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}
