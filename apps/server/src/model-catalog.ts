import type { ModelChoiceWire } from '@podium/protocol'

/** Bumped whenever the probe's output SHAPE changes (e.g. per-model `efforts`
 *  added, or the snapshot becoming machine-keyed) OR a probe fix means an older
 *  snapshot's CONTENT is wrong (v4: the CLI probes ran without the user install
 *  roots on PATH, so every CLI agent persisted an empty list — POD-362), so a
 *  persisted snapshot from an older build is ignored and re-probed instead of
 *  served stale within its TTL. */
export const MODEL_CATALOG_VERSION = 4

/**
 * Live per-agent model lists for ONE machine.
 *
 * KEYED BY `machineId`, deliberately: which models a harness offers is a fact
 * about a specific machine (ADR 1 Amendment 1 D13.5 — visibility class
 * `owned-compute`, owner inherits Machine). An instance-global singleton cannot
 * express that — with two machines whose installed harnesses differ, an unkeyed
 * cache reports whichever host probed last to every user. Carrying the id on the
 * value makes "which machine is this about?" unanswerable-by-accident, matching
 * `MachineHarnessInventory` in `@podium/harness`.
 *
 * This type carries no principal: no owner, no user id, no grant. Authorization
 * is applied at the server projection boundary (POD-1079).
 */
export interface ModelCatalogSnapshot {
  /** The machine this fact is ABOUT — the scoping key, not decoration. */
  machineId: string
  /** Live models keyed by agent kind (grok/cursor/opencode). Absent agents fall
   *  back to the web's static catalog. */
  byAgent: Record<string, ModelChoiceWire[]>
  /** Epoch ms of the last successful probe; 0 = never fetched yet. */
  fetchedAt: number
  /** Shape version — a persisted snapshot with a different version is discarded. */
  version?: number
}

/** Probe the live models for ONE machine. `machineId` is required so a probe
 *  cannot write an unkeyed catalog — and since POD-1466 it also SELECTS the host
 *  that answers: the real probe relays to that machine's own daemon, because a
 *  probe only ever sees the agent CLIs installed on the host it executes on. */
export type ModelProbe = (machineId: string) => Promise<Record<string, ModelChoiceWire[]>>

function emptySnapshot(machineId: string): ModelCatalogSnapshot {
  return { machineId, byAgent: {}, fetchedAt: 0 }
}

/**
 * Stale-while-revalidate cache of live per-agent model lists, keyed by machine.
 * A probe shells out to `grok/cursor-agent/opencode models` (~2s warm, up to ~7s
 * cold), so `get(machineId)` never blocks: it returns that machine's current
 * snapshot and kicks a background refresh when the snapshot is empty or older
 * than the TTL. Purely query-driven — nothing runs unless a client asks.
 */
export class ModelCatalog {
  private readonly snapshots = new Map<string, ModelCatalogSnapshot>()
  private readonly inflight = new Map<string, Promise<void>>()

  // Default probe is an empty no-op so `new SessionRegistry()` (every test) never
  // reaches for a daemon; the real one (a `modelProbeRequest` to the named
  // machine) is injected at boot in startServer via
  // SessionRegistryOptions.modelProbe.
  constructor(
    private readonly probe: ModelProbe = async () => ({}),
    private readonly opts: {
      ttlMs?: number
      now?: () => number
      /** Persist across restarts: `load` seeds one machine's cache at first read
       *  (→ instant, non-cold first open after a redeploy); `save` writes each
       *  successful refresh. Both take/return a machine-keyed snapshot. */
      load?: (machineId: string) => ModelCatalogSnapshot | null
      save?: (snapshot: ModelCatalogSnapshot) => void
    } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private isStale(snapshot: ModelCatalogSnapshot): boolean {
    const ttlMs = this.opts.ttlMs ?? 60 * 60 * 1000
    return snapshot.fetchedAt === 0 || this.now() - snapshot.fetchedAt > ttlMs
  }

  /** Seed (or return) the in-memory entry for `machineId`. Only a persisted
   *  snapshot of the CURRENT shape that names the SAME machine is accepted —
   *  an older unkeyed or cross-machine snapshot is discarded so `get` re-probes. */
  private ensure(machineId: string): ModelCatalogSnapshot {
    const cached = this.snapshots.get(machineId)
    if (cached) return cached
    const persisted = this.opts.load?.(machineId)
    const seeded =
      persisted &&
      persisted.version === MODEL_CATALOG_VERSION &&
      persisted.machineId === machineId
        ? persisted
        : emptySnapshot(machineId)
    this.snapshots.set(machineId, seeded)
    return seeded
  }

  /** SWR read for one machine: returns that machine's snapshot immediately,
   *  refreshing in the background when it's empty or stale. Never blocks. */
  get(machineId: string): ModelCatalogSnapshot {
    const snapshot = this.ensure(machineId)
    if (this.isStale(snapshot)) void this.refresh(machineId)
    return snapshot
  }

  /** Refresh one machine now. Concurrent callers for the same machine share one
   *  probe; a throwing probe keeps the last good snapshot for that machine (so a
   *  transiently-broken CLI doesn't wipe the cache). Different machines probe
   *  independently. */
  refresh(machineId: string): Promise<void> {
    const existing = this.inflight.get(machineId)
    if (existing) return existing
    const pending = (async () => {
      try {
        const snapshot: ModelCatalogSnapshot = {
          machineId,
          byAgent: await this.probe(machineId),
          fetchedAt: this.now(),
          version: MODEL_CATALOG_VERSION,
        }
        this.snapshots.set(machineId, snapshot)
        this.opts.save?.(snapshot)
      } catch {
        // keep last-good; isStale() retries on the next get() past the TTL
      } finally {
        this.inflight.delete(machineId)
      }
    })()
    this.inflight.set(machineId, pending)
    return pending
  }
}
