/**
 * Storage-neutral client outbox (docs/spec/outbox-write-path.md §2.3): a small
 * durable FIFO of covered mutations. Writes enqueue here after optimistic local
 * apply and drain sequentially with stable mutation IDs, so replay after reload
 * or reconnect is a server-side no-op.
 */

/** One queued mutation. `input` is the exact tRPC input, minus `mutationId`. */
export interface OutboxEntry {
  mutationId: string
  kind: string
  input: unknown
  queuedAt: number
  /** Durable overlay stage (#263 review finding 1): absent/undefined = queued;
   *  'awaiting-truth' = the executor resolved but the caller asked (via
   *  onApplied returning true) to keep the entry until covering server truth
   *  lands — it is excluded from the drain queue and deleted only by
   *  `retireAwaiting`. Surviving in storage is the point: a reload inside the
   *  resolution→truth window restores the optimistic overlay. */
  state?: 'awaiting-truth'
  /** Epoch ms when the executor resolved (stamped on the awaiting transition). */
  resolvedAt?: number
  /** Opaque caller annotation captured at enqueue (#263 review finding 2): the
   *  engine stores the target row's replica fingerprint here so resolution can
   *  tell whether server truth already moved while the mutation was in flight. */
  baseline?: string
}

/** Storage seam — platform adapters own localStorage, AsyncStorage, SQLite, etc. */
export interface OutboxStorage {
  load(): OutboxEntry[]
  save(entries: OutboxEntry[]): void
}

/** Legacy web localStorage key for the pre-replica outbox blob. The replica's
 *  outbox collection migrates it in on first use (see replica/replica.ts). */
export const OUTBOX_LS_KEY = 'podium.outbox.v1'

/** Browser 'online' events when a window exists; undefined elsewhere (RN/SSR). */
export function platformOnlineEvents(): OnlineEvents | undefined {
  if (typeof window === 'undefined') return undefined
  return {
    add: (cb) => window.addEventListener('online', cb),
    remove: (cb) => window.removeEventListener('online', cb),
  }
}

/** navigator.onLine when available; optimistic (true) elsewhere. */
export function platformIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export interface OnlineEvents {
  add(cb: () => void): void
  remove(cb: () => void): void
}

/** A corrupt/foreign blob reads as empty rather than wedging the queue. */
export function parseOutboxEntries(raw: string | null): OutboxEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is OutboxEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as OutboxEntry).mutationId === 'string' &&
        typeof (e as OutboxEntry).kind === 'string' &&
        typeof (e as OutboxEntry).queuedAt === 'number',
    )
  } catch {
    return []
  }
}

/**
 * A tRPC input-validation rejection can never succeed on retry; retrying it
 * forever would wedge the queue behind a poison entry. Matched structurally
 * rather than by instanceof, so a batched/wrapped error still classifies.
 */
function isPoisonError(err: unknown): boolean {
  const data = (err as { data?: { httpStatus?: number; code?: string } } | null)?.data
  return data?.httpStatus === 400 || data?.code === 'BAD_REQUEST'
}

/** Kind -> tRPC-input map; executors receive the input plus the entry's mutationId. */
export type OutboxExecutors<M extends Record<string, object>> = {
  [K in keyof M]: (input: M[K] & { mutationId: string }) => Promise<unknown>
}

export interface OutboxInit<M extends Record<string, object>> {
  executors: OutboxExecutors<M>
  /** A dropped poison entry surfaces here — app adapters wire it to UI. */
  onPoison?: (entry: OutboxEntry, error: unknown) => void
  /** Fires after an entry's executor resolved and the entry left the queue,
   *  BEFORE subscribers observe the new size — so an overlay handoff (#263:
   *  queued → awaiting server truth) can happen with no intermediate state in
   *  which the entry is in neither stage. Return `true` to HOLD the entry in
   *  the durable awaiting-truth stage (kept in storage with
   *  state:'awaiting-truth' + resolvedAt; released via `retireAwaiting`);
   *  any other return value deletes it, the pre-#263-review behavior. Must not
   *  throw (guarded anyway — a throw deletes). */
  onApplied?: (entry: OutboxEntry) => unknown
  storage: OutboxStorage
  /** Flat retry cadence while entries remain after a network failure. */
  retryMs?: number
  /** Injectable for tests/adapters; defaults to online when unknown. */
  isOnline?: () => boolean
  now?: () => number
  randomId?: () => string
  onlineEvents?: OnlineEvents
}

export class Outbox<M extends Record<string, object>> {
  /** The queued FIFO — entries still waiting for a successful send. */
  private entries: OutboxEntry[]
  /** Resolved entries held durably until covering server truth lands (#263
   *  review finding 1). Not part of the drain queue; persisted alongside it. */
  private awaitingEntries: OutboxEntry[]
  private readonly storage: OutboxStorage
  private readonly retryMs: number
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly subs = new Set<(size: number) => void>()
  private drainPromise: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** True after dispose() until the next attach(). Hard-stops every storage
   *  write and aborts a drain between steps: a provider recreation constructs
   *  the REPLACEMENT outbox before disposing this one over the same storage,
   *  and an in-flight drain completing after dispose must not persist its
   *  stale queue over the successor's (it could silently delete a mutation the
   *  successor just enqueued). */
  private disposed = false
  private readonly onOnline = (): void => void this.drain()

  constructor(private readonly init: OutboxInit<M>) {
    this.storage = init.storage
    this.retryMs = init.retryMs ?? 5000
    const loaded = this.storage.load()
    this.entries = loaded.filter((e) => e.state !== 'awaiting-truth')
    this.awaitingEntries = loaded.filter((e) => e.state === 'awaiting-truth')
    this.now = init.now ?? Date.now
    this.randomId = init.randomId ?? (() => crypto.randomUUID())
    this.attach()
  }

  /** Arm drain triggers. Idempotent as long as the adapter treats duplicate
   *  callbacks as no-ops. Re-arms persistence after a dispose() (the engine
   *  re-starts the SAME outbox across a StrictMode dispose/start cycle). */
  attach(): void {
    this.disposed = false
    this.init.onlineEvents?.add(this.onOnline)
    if (this.entries.length > 0 && this.online()) queueMicrotask(() => void this.drain())
  }

  enqueue<K extends keyof M & string>(
    kind: K,
    input: M[K],
    opts?: { baseline?: string },
  ): OutboxEntry {
    const entry: OutboxEntry = {
      mutationId: this.randomId(),
      kind,
      input,
      queuedAt: this.now(),
      ...(opts?.baseline !== undefined ? { baseline: opts.baseline } : {}),
    }
    this.entries.push(entry)
    this.persist()
    if (this.online()) void this.drain()
    return entry
  }

  size(): number {
    return this.entries.length
  }

  /** Snapshot of the queued entries, FIFO. The pending queue IS the optimistic
   *  overlay (#263): the engine projects these into per-entity patches. */
  pending(): OutboxEntry[] {
    return [...this.entries]
  }

  /** Snapshot of the durable awaiting-truth stage (#263 review finding 1), in
   *  resolution order. The engine restores these into its overlay on boot. */
  awaiting(): OutboxEntry[] {
    return [...this.awaitingEntries]
  }

  /** Retire (delete durably) one awaiting-truth entry — covering server truth
   *  landed, or the caller gave up on it (TTL). No-op for unknown ids, so a
   *  re-entrant retirement during a repaint cascade converges. Saves WITHOUT
   *  notifying subscribers: the queued size didn't change, and a notification
   *  here would recompute the caller's overlays mid-retirement — promoting a
   *  younger same-row awaiting entry to "oldest" (escape-eligible) within the
   *  SAME pass, exactly what the oldest-first rule exists to prevent. */
  retireAwaiting(mutationId: string): void {
    const idx = this.awaitingEntries.findIndex((e) => e.mutationId === mutationId)
    if (idx === -1) return
    this.awaitingEntries.splice(idx, 1)
    this.save()
  }

  /** Reactive size for pending-changes indicators. */
  subscribe(cb: (size: number) => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  /** Call when the hub link recovers; platform online events alone miss server restarts. */
  notifyConnected(): void {
    void this.drain()
  }

  /**
   * Sequential FIFO drain, single-flight. Poison entries drop + surface; any
   * other failure keeps the entry and arms a flat retry timer.
   */
  drain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.drainPass().finally(() => {
        this.drainPromise = null
      })
    }
    return this.drainPromise
  }

  dispose(): void {
    this.disposed = true
    this.init.onlineEvents?.remove(this.onOnline)
    this.clearRetry()
  }

  private async drainPass(): Promise<void> {
    this.clearRetry()
    while (this.entries.length > 0) {
      if (this.disposed) return
      const entry = this.entries[0] as OutboxEntry
      try {
        const exec = this.init.executors[entry.kind as keyof M]
        if (!exec) {
          throw Object.assign(new Error(`unknown outbox kind: ${entry.kind}`), {
            data: { code: 'BAD_REQUEST' },
          })
        }
        await exec({ ...(entry.input as M[keyof M]), mutationId: entry.mutationId })
      } catch (err) {
        // Disposed mid-flight: the successor owns the queue now — no writes,
        // no retry timer. The entry replays there, deduped by mutationId.
        if (this.disposed) return
        if (isPoisonError(err)) {
          this.entries.shift()
          this.persist()
          this.init.onPoison?.(entry, err)
          continue
        }
        this.scheduleRetry()
        return
      }
      // Same abort AFTER a successful send: the mutation applied server-side,
      // but persisting the shift would clobber the successor's storage; leave
      // the entry for an idempotent (mutationId-deduped) replay instead.
      if (this.disposed) return
      this.entries.shift()
      let hold = false
      try {
        hold = this.init.onApplied?.(entry) === true
      } catch {
        // an overlay listener must never wedge the drain
      }
      if (hold) {
        // Durable awaiting-truth transition (#263 review finding 1): keep the
        // entry in storage — a reload before covering truth lands restores the
        // overlay instead of flashing stale replica truth.
        this.awaitingEntries.push({ ...entry, state: 'awaiting-truth', resolvedAt: this.now() })
      }
      this.persist()
    }
  }

  private online(): boolean {
    return this.init.isOnline?.() ?? true
  }

  private persist(): void {
    if (this.disposed) return
    this.save()
    for (const cb of this.subs) cb(this.entries.length)
  }

  private save(): void {
    if (this.disposed) return
    // Awaiting entries first — they resolved earliest, and blob-shaped storages
    // preserve save order as FIFO. Subscribers see the QUEUED size only.
    this.storage.save([...this.awaitingEntries, ...this.entries])
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.drain()
    }, this.retryMs)
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}

export function createOutbox<M extends Record<string, object>>(init: OutboxInit<M>): Outbox<M> {
  return new Outbox(init)
}
