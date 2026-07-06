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
}

/** Storage seam — platform adapters own localStorage, AsyncStorage, SQLite, etc. */
export interface OutboxStorage {
  load(): OutboxEntry[]
  save(entries: OutboxEntry[]): void
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
  private entries: OutboxEntry[]
  private readonly storage: OutboxStorage
  private readonly retryMs: number
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly subs = new Set<(size: number) => void>()
  private drainPromise: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly onOnline = (): void => void this.drain()

  constructor(private readonly init: OutboxInit<M>) {
    this.storage = init.storage
    this.retryMs = init.retryMs ?? 5000
    this.entries = this.storage.load()
    this.now = init.now ?? Date.now
    this.randomId = init.randomId ?? (() => crypto.randomUUID())
    this.attach()
  }

  /** Arm drain triggers. Idempotent as long as the adapter treats duplicate callbacks as no-ops. */
  attach(): void {
    this.init.onlineEvents?.add(this.onOnline)
    if (this.entries.length > 0 && this.online()) queueMicrotask(() => void this.drain())
  }

  enqueue<K extends keyof M & string>(kind: K, input: M[K]): OutboxEntry {
    const entry: OutboxEntry = {
      mutationId: this.randomId(),
      kind,
      input,
      queuedAt: this.now(),
    }
    this.entries.push(entry)
    this.persist()
    if (this.online()) void this.drain()
    return entry
  }

  size(): number {
    return this.entries.length
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
    this.init.onlineEvents?.remove(this.onOnline)
    this.clearRetry()
  }

  private async drainPass(): Promise<void> {
    this.clearRetry()
    while (this.entries.length > 0) {
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
        if (isPoisonError(err)) {
          this.entries.shift()
          this.persist()
          this.init.onPoison?.(entry, err)
          continue
        }
        this.scheduleRetry()
        return
      }
      this.entries.shift()
      this.persist()
    }
  }

  private online(): boolean {
    return this.init.isOnline?.() ?? true
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
