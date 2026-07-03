/**
 * Client outbox (docs/spec/outbox-write-path.md §2.3): a small durable FIFO of
 * covered mutations. Writes enqueue here (after their optimistic local apply)
 * and drain to the server sequentially, each carrying a stable `mutationId` so
 * a replay after reload/reconnect is a server-side no-op. localStorage is the
 * deliberate P3 backing (entries are small); the storage seam below lets P6
 * swap in a real durable replica without touching call sites.
 */

/** One queued mutation. `input` is the exact tRPC input, minus `mutationId`. */
export interface OutboxEntry {
  mutationId: string
  kind: string
  input: unknown
  queuedAt: number
}

/** Storage seam — the outbox never touches localStorage directly. */
export interface OutboxStorage {
  load(): OutboxEntry[]
  save(entries: OutboxEntry[]): void
}

export const OUTBOX_LS_KEY = 'podium.outbox.v1'

/** A corrupt/foreign blob reads as empty rather than wedging the queue.
 *  Exported for the replica's one-time migration of the legacy blob (P6b). */
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

/** Guarded like store.tsx's lsGet/lsSet — localStorage throws in private-mode/SSR. */
export function localStorageBacking(key = OUTBOX_LS_KEY): OutboxStorage {
  return {
    load: () => {
      try {
        return parseOutboxEntries(localStorage.getItem(key))
      } catch {
        return []
      }
    },
    save: (entries) => {
      try {
        localStorage.setItem(key, JSON.stringify(entries))
      } catch {
        // storage unavailable — durability is best-effort
      }
    },
  }
}

/**
 * A tRPC input-validation rejection can never succeed on retry; retrying it
 * forever would wedge the queue behind a poison entry. Matched structurally
 * (TRPCClientError carries `data.httpStatus`/`data.code`) rather than by
 * instanceof, so a batched/wrapped error still classifies.
 */
function isPoisonError(err: unknown): boolean {
  const data = (err as { data?: { httpStatus?: number; code?: string } } | null)?.data
  return data?.httpStatus === 400 || data?.code === 'BAD_REQUEST'
}

/** Kind → tRPC-input map; executors receive the input plus the entry's mutationId. */
export type OutboxExecutors<M extends Record<string, object>> = {
  [K in keyof M]: (input: M[K] & { mutationId: string }) => Promise<unknown>
}

export interface OutboxInit<M extends Record<string, object>> {
  executors: OutboxExecutors<M>
  /** A dropped (poison) entry surfaces here — the store wires it to a toast. */
  onPoison?: (entry: OutboxEntry, error: unknown) => void
  storage?: OutboxStorage
  /** Flat retry cadence while entries remain after a network failure. */
  retryMs?: number
  /** Injectable for tests; defaults to navigator.onLine (assume online when unknown). */
  isOnline?: () => boolean
}

export class Outbox<M extends Record<string, object>> {
  private entries: OutboxEntry[]
  private readonly storage: OutboxStorage
  private readonly retryMs: number
  private readonly subs = new Set<(size: number) => void>()
  private drainPromise: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly onOnline = (): void => void this.drain()

  constructor(private readonly init: OutboxInit<M>) {
    this.storage = init.storage ?? localStorageBacking()
    this.retryMs = init.retryMs ?? 5000
    this.entries = this.storage.load()
    this.attach()
  }

  /** Arm the drain triggers. Idempotent (re-adding the same listener is a no-op),
   *  so a StrictMode dispose→re-mount cycle can safely re-attach the same instance. */
  attach(): void {
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline)
    // A reload (or re-attach) with leftover entries replays them without waiting
    // for a trigger.
    if (this.entries.length > 0 && this.online()) queueMicrotask(() => void this.drain())
  }

  enqueue<K extends keyof M & string>(kind: K, input: M[K]): OutboxEntry {
    const entry: OutboxEntry = {
      mutationId: crypto.randomUUID(),
      kind,
      input,
      queuedAt: Date.now(),
    }
    this.entries.push(entry)
    this.persist()
    if (this.online()) void this.drain()
    return entry
  }

  size(): number {
    return this.entries.length
  }

  /** Reactive size for the pending-changes indicator. */
  subscribe(cb: (size: number) => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  /** The store calls this when the hub link recovers — the browser 'online'
   *  event alone misses server restarts behind a healthy network. */
  notifyConnected(): void {
    void this.drain()
  }

  /**
   * Sequential FIFO drain, single-flight: a second call while a pass runs joins
   * the in-flight promise (the loop already covers entries appended mid-pass).
   * Poison entries drop + surface; any other failure keeps the entry, ends the
   * pass, and arms a flat retry timer.
   */
  drain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.drainPass().finally(() => {
        this.drainPromise = null
      })
    }
    return this.drainPromise
  }

  private async drainPass(): Promise<void> {
    this.clearRetry()
    while (this.entries.length > 0) {
      const entry = this.entries[0] as OutboxEntry
      try {
        const exec = this.init.executors[entry.kind as keyof M]
        // An unknown kind (stale entry from an older client) is poison too —
        // it would otherwise block the queue forever.
        if (!exec)
          throw Object.assign(new Error(`unknown outbox kind: ${entry.kind}`), {
            data: { code: 'BAD_REQUEST' },
          })
        await exec({ ...(entry.input as M[keyof M]), mutationId: entry.mutationId })
      } catch (err) {
        if (isPoisonError(err)) {
          this.entries.shift()
          this.persist()
          this.init.onPoison?.(entry, err)
          continue
        }
        // Network/unknown failure: keep the entry, retry on the next trigger
        // or the flat timer — never drop silently (spec invariant 5).
        this.scheduleRetry()
        return
      }
      this.entries.shift()
      this.persist()
    }
  }

  dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
    this.clearRetry()
  }

  private online(): boolean {
    if (this.init.isOnline) return this.init.isOnline()
    return typeof navigator === 'undefined' || navigator.onLine !== false
  }

  private persist(): void {
    this.storage.save(this.entries)
    for (const cb of this.subs) cb(this.entries.length)
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
