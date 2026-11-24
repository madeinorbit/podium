import type { MachineId } from '@podium/model'
import { MODEL_CATALOG_MAX_AGE_MS, type ModelChoiceWire } from '@podium/protocol'

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
  machineId: MachineId
  /** Live models keyed by agent kind. Omitted probe keys keep their last reported
   *  list; a reported empty list replaces it. */
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
export type ModelProbe = (machineId: MachineId) => Promise<Record<string, ModelChoiceWire[]>>

/** How long a failed probe holds off the next BACKGROUND probe for that
 *  machine. A failure stamps nothing, so the snapshot stays stale and every
 *  `get()` would otherwise start another probe. An explicit `refresh()` (a
 *  client asking) is not held off. */
export const FAILED_PROBE_RETRY_MS = 30_000

function emptySnapshot(machineId: MachineId): ModelCatalogSnapshot {
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
  private readonly hydrated = new Set<string>()
  /** When each machine's last probe failed; cleared by a successful one. */
  private readonly failedAt = new Map<string, number>()

  // Default probe is an empty no-op so `SessionRegistry.create()` (every test) never
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
      load?: (
        machineId: MachineId,
      ) => ModelCatalogSnapshot | null | Promise<ModelCatalogSnapshot | null>
      save?: (snapshot: ModelCatalogSnapshot) => void | Promise<void>
    } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private isStale(snapshot: ModelCatalogSnapshot): boolean {
    const ttlMs = this.opts.ttlMs ?? MODEL_CATALOG_MAX_AGE_MS
    return snapshot.fetchedAt === 0 || this.now() - snapshot.fetchedAt >= ttlMs
  }

  /** Seed (or return) the in-memory entry for `machineId`. Only a persisted
   *  snapshot of the CURRENT shape that names the SAME machine is accepted —
   *  an older unkeyed or cross-machine snapshot is discarded so `get` re-probes. */
  private ensure(machineId: MachineId): ModelCatalogSnapshot {
    const cached = this.snapshots.get(machineId)
    if (cached) return cached
    const seeded = emptySnapshot(machineId)
    this.snapshots.set(machineId, seeded)
    return seeded
  }

  /** SWR read for one machine: returns that machine's snapshot immediately,
   *  refreshing in the background when it's empty or stale. Never blocks. */
  get(machineId: MachineId): ModelCatalogSnapshot {
    const snapshot = this.ensure(machineId)
    if (this.isStale(snapshot) && !this.inFailureBackoff(machineId)) {
      void this.refreshInBackground(machineId, snapshot)
    }
    return snapshot
  }

  private inFailureBackoff(machineId: MachineId): boolean {
    const failedAt = this.failedAt.get(machineId)
    return failedAt !== undefined && this.now() - failedAt < FAILED_PROBE_RETRY_MS
  }

  /** Hydrate once on first use, then probe only when the hydrated value is stale.
   *  The returned snapshot remains the same object so a caller that chose to
   *  yield after `get()` can observe a fast persisted read without `get()` ever
   *  becoming a blocking boundary. */
  private refreshInBackground(machineId: MachineId, returned: ModelCatalogSnapshot): Promise<void> {
    const existing = this.inflight.get(machineId)
    if (existing) return existing
    const pending = (async () => {
      try {
        if (!this.hydrated.has(machineId)) {
          this.hydrated.add(machineId)
          const persisted = await this.opts.load?.(machineId)
          if (
            persisted &&
            persisted.version === MODEL_CATALOG_VERSION &&
            persisted.machineId === machineId
          ) {
            Object.assign(returned, persisted)
            this.snapshots.set(machineId, returned)
            if (!this.isStale(returned)) return
          }
        }
        await this.probeInto(machineId)
      } finally {
        this.inflight.delete(machineId)
      }
    })()
    this.inflight.set(machineId, pending)
    return pending
  }

  /** Refresh one machine now. Concurrent callers for the same machine share one
   *  probe; a throwing probe keeps the last good snapshot for that machine (so a
   *  transiently-broken CLI doesn't wipe the cache). Different machines probe
   *  independently. */
  async refresh(machineId: MachineId): Promise<void> {
    const existing = this.inflight.get(machineId)
    if (existing) return existing
    // A forced probe supersedes persisted hydration: its result is newer than
    // anything the store could have supplied.
    this.hydrated.add(machineId)
    const pending = (async () => {
      try {
        await this.probeInto(machineId)
      } finally {
        this.inflight.delete(machineId)
      }
    })()
    this.inflight.set(machineId, pending)
    return pending
  }

  private async probeInto(machineId: MachineId): Promise<void> {
    try {
      const byAgent = await this.probe(machineId)
      // A probe that names no harness at all is not a report. A daemon that
      // answered lists every CLI-probed harness, even as []; `{}` is what a
      // timeout, an unreachable machine or a daemon-side failure answers with.
      // Stamping it would serve "no models" as fresh for a whole TTL (and
      // persist it), so it is a failure: the last good snapshot stays, still
      // stale, and the next read past the backoff probes again.
      if (Object.keys(byAgent).length === 0) {
        this.failedAt.set(machineId, this.now())
        return
      }
      const snapshot: ModelCatalogSnapshot = {
        machineId,
        // A partial probe can omit a harness when its lookup fails. Preserve that
        // machine's last good list, including efforts, but accept explicit [].
        byAgent: { ...this.snapshots.get(machineId)?.byAgent, ...byAgent },
        fetchedAt: this.now(),
        version: MODEL_CATALOG_VERSION,
      }
      this.snapshots.set(machineId, snapshot)
      this.failedAt.delete(machineId)
      await this.opts.save?.(snapshot)
    } catch {
      // Keep last-good; the next get() past the backoff retries.
      this.failedAt.set(machineId, this.now())
    }
  }
}
