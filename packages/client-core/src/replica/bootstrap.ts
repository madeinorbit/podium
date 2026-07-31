/**
 * Bootstrap: chunked, buffered, paced, atomically installed (ADR 2 D6).
 *
 * Bootstrap is not the emergency path — it is the TERMINAL recovery every rung of
 * the healing ladder falls to (D7 rungs 2–6 all end here) and the path every cold
 * start already walks. So it is the most-exercised code in the replica, and the
 * three properties below are the ones it is measured on.
 *
 * ## 1. Never blank the UI
 *
 * The install builds a STAGING copy and swaps it in whole. Nothing is cleared
 * until the replacement is ready, so a re-bootstrap that never finishes (offline)
 * keeps serving the last-known state, marked stale — D7's "stale-visible, never
 * blank. Disconnection is not data loss." Blanking first and filling after is the
 * obvious implementation and it is the one D6 exists to forbid.
 *
 * ## 2. Buffer concurrent deltas
 *
 * The authority reads its state at a definite `(feedId, epoch, snapshotSeq)`,
 * but the world keeps moving while the chunks stream. Deltas with
 * `seq > snapshotSeq` are the changes that happened DURING the bootstrap: they
 * are buffered, then applied in order inside the same commit. Dropping them
 * loses those changes permanently (the cursor lands past them); applying them
 * eagerly writes them into a replica that does not yet have the rows they amend.
 *
 * ## 3. PACE IT — this is scar tissue, not caution
 *
 * Podium has already shipped a chunked bootstrap and been taken down by it. The
 * transcript mirror chunked correctly at 256 KB and drained back-to-back: the
 * first live deploy enqueued a months-deep lake on attach, the server sat at ~80%
 * CPU, starved its own daemon-reply handling, missed the systemd watchdog's 30s
 * deadline and was SIGABRT'd into a restart → re-bootstrap CRASH LOOP.
 *
 * Read that shape precisely, because it is the one this file could reintroduce:
 * bootstrap starved the very connection bootstrap depends on, and the restart
 * re-triggered the bootstrap. A recovery path that consumes the whole loop turns
 * one slow client into an outage, and then repeats. The mirror's fix is the
 * precedent D6 adopts and this module implements: an inter-chunk yield, so a big
 * bootstrap deliberately spreads out. **The bootstrap must never own the loop.**
 *
 * Client-side, "pacing" means yielding between install batches — the browser's
 * main thread is the loop being protected here, and the symptom of not yielding
 * is a frozen UI rather than a missed watchdog. Same rule, different loop.
 */

import type { MetadataChangeLenient } from '@podium/protocol'
import { isKnownMetadataChange } from '@podium/protocol'
import type { FeedCursor } from './feed'
import type { Replica, ReplicaKind, ReplicaRows } from './replica'

/** Wire entity kind → replica collection kind. The feed says `session`, the
 *  replica says `sessions`; this is the only place the two vocabularies meet. */
const KIND_BY_ENTITY: Record<string, ReplicaKind> = {
  session: 'sessions',
  issue: 'issues',
  // The three POD-796/POD-822 kinds the replica holds. Mapped here so a
  // bootstrap/heal that carries them installs them into the right collection
  // rather than dropping them (a kind absent from this map is silently skipped
  // by the installer — `kind === undefined → continue`). Empty until the cap
  // flips, but the map is where they must be listed when they arrive.
  issueProjection: 'issueProjections',
  issueDep: 'issueDeps',
  repo: 'repos',
  conversation: 'conversations',
  automation: 'automations',
  automationRun: 'automationRuns',
}

/** One chunk of the bootstrap stream: ordered rows in the SAME change shape the
 *  delta path uses (D6 — "one shape, one code path"). A new entity kind is free
 *  on this path exactly as lenient parsing made it free on the delta path. */
export interface BootstrapChunk {
  changes: MetadataChangeLenient[]
}

export interface BootstrapOptions {
  /**
   * Yield between install batches so the bootstrap never owns the loop (D6).
   * Defaults to a macrotask hop, which is what actually lets the browser paint
   * and service the socket — `await Promise.resolve()` drains as a microtask and
   * yields NOTHING to the event loop, which is the trap this default exists to
   * avoid. Tests inject a synchronous stub.
   */
  yieldToLoop?: () => Promise<void>
  /** Rows installed per batch before yielding. */
  batchSize?: number
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Rows per install batch. A tuning parameter, not a protocol constant (D6). */
export const BOOTSTRAP_BATCH_ROWS = 200

/**
 * One bootstrap in progress: staging + the concurrent-delta buffer.
 *
 * Deliberately a value with an explicit lifecycle (`begin → install* → commit`),
 * not a function that does the whole thing: the caller has to keep feeding it
 * live deltas WHILE it installs, which a single await cannot express.
 */
export class BootstrapSession {
  /** Staged rows per kind. The replica is not touched until commit. */
  private readonly staged = new Map<ReplicaKind, Map<string, unknown>>()
  /** Deltas that landed with `seq > snapshotSeq` while we streamed. */
  private readonly buffered: MetadataChangeLenient[] = []
  private done = false

  /** @param cursor the `(feedId, epoch, snapshotSeq)` the authority read at. */
  constructor(
    private readonly replica: Replica,
    readonly cursor: FeedCursor,
    private readonly opts: BootstrapOptions = {},
  ) {}

  /** Stage one chunk, yielding between batches so we never own the loop. */
  async install(chunk: BootstrapChunk): Promise<void> {
    if (this.done) throw new Error('bootstrap session already committed')
    const yieldToLoop = this.opts.yieldToLoop ?? defaultYield
    const batchSize = this.opts.batchSize ?? BOOTSTRAP_BATCH_ROWS
    let sinceYield = 0
    for (const change of chunk.changes) {
      this.stage(change)
      if (++sinceYield >= batchSize) {
        sinceYield = 0
        await yieldToLoop()
      }
    }
  }

  /**
   * Offer a live delta. Returns true when it was buffered (it belongs to this
   * bootstrap and will be applied at commit), false when the caller still owns
   * it — that is, when it is at or below `snapshotSeq` and therefore ALREADY
   * included in the state being streamed. Applying such a row twice is harmless
   * (upserts are idempotent) but buffering it would reorder it behind rows the
   * snapshot already superseded.
   */
  bufferDelta(seq: number, changes: MetadataChangeLenient[]): boolean {
    if (this.done || seq <= this.cursor.seq) return false
    for (const change of changes) {
      if (change.seq > this.cursor.seq) this.buffered.push(change)
    }
    return true
  }

  /**
   * The atomic swap (D6 step 4 / D10). Staging replaces the live collections,
   * the buffered deltas apply in order, and the cursor commits — as ONE unit, so
   * no subscriber ever observes a half-installed replica and no crash can leave
   * a cursor without the data it covers.
   *
   * `batch()` is the atomicity this engine can supply: it coalesces every write
   * into one notification against the FINAL state. It is NOT a storage
   * transaction — a localStorage replica has none — so the cursor still goes
   * LAST, which is what makes the crash window land on the recoverable side of
   * ADR 6 D4.2 (data ahead of the cursor is re-pulled; a cursor ahead of data is
   * a permanent gap). The SQLite adapter tightens the same sequence into a real
   * transaction behind the same seam.
   */
  commit(): void {
    if (this.done) throw new Error('bootstrap session already committed')
    this.done = true
    this.replica.batch(() => {
      // Snapshot semantics: rows absent from staging are gone (D5 tombstones
      // are feed rows, but a bootstrap's absence is itself the tombstone).
      for (const [kind, rows] of this.staged) {
        this.replica.applySnapshot(kind, [...rows.values()] as ReplicaRows[ReplicaKind][])
      }
      // Then the changes that happened WHILE we streamed, in seq order.
      const sorted = [...this.buffered].sort((a, b) => a.seq - b.seq)
      const upserts = new Map<ReplicaKind, unknown[]>()
      const removes = new Map<ReplicaKind, string[]>()
      let seq = this.cursor.seq
      for (const change of sorted) {
        seq = Math.max(seq, change.seq)
        const kind = KIND_BY_ENTITY[change.entity]
        if (kind === undefined || !isKnownMetadataChange(change)) continue
        if (change.op === 'remove') {
          const list = removes.get(kind) ?? []
          list.push(change.id)
          removes.set(kind, list)
        } else if (change.value !== undefined) {
          const list = upserts.get(kind) ?? []
          list.push(change.value)
          upserts.set(kind, list)
        }
      }
      for (const kind of new Set([...upserts.keys(), ...removes.keys()])) {
        this.replica.applyChanges(
          kind,
          (upserts.get(kind) ?? []) as ReplicaRows[ReplicaKind][],
          removes.get(kind) ?? [],
        )
      }
      // Cursor LAST — see the note above.
      this.replica.setFeedCursor({ ...this.cursor, seq })
    })
  }

  /** Drop staging. Nothing was written, so there is nothing to undo — which is
   *  the property that makes "a failure at any point before the commit discards
   *  staging and retries" (D6 step 5) true rather than aspirational. */
  abort(): void {
    this.done = true
    this.staged.clear()
    this.buffered.length = 0
  }

  private stage(change: MetadataChangeLenient): void {
    const kind = KIND_BY_ENTITY[change.entity]
    // An unknown entity kind from a newer authority: ignore the row, keep the
    // bootstrap (D4's additive rule — a new kind must not quarantine an older
    // client). Never fold it into some other kind's collection.
    if (kind === undefined || !isKnownMetadataChange(change)) return
    if (change.op === 'remove' || change.value === undefined) return
    const rows = this.staged.get(kind) ?? new Map<string, unknown>()
    rows.set(change.id, change.value)
    this.staged.set(kind, rows)
  }
}

/**
 * Adapter: today's MONOLITHIC snapshot arm → the chunk stream D6 specifies.
 *
 * The server still answers `changesSince(null)` with one product-typed reply
 * holding every entity (POD-796 replaces it with a real chunked stream). This
 * turns that reply into the shape the installer already speaks, so the client
 * machinery — staging, buffering, pacing, atomic swap — is the FINAL one today
 * and the server change lands without touching it.
 *
 * The pacing this buys is real but partial, and worth being precise about: the
 * whole payload is already in memory by the time we are called, so the transfer
 * was never paced and the peak memory is unchanged. What is paced is the
 * INSTALL, which is the part that runs on the browser's main thread. The
 * transfer's own pacing needs the server's chunked stream and arrives with it.
 */
export function snapshotToChunks(
  snapshot: {
    sessions?: unknown[]
    issues?: unknown[]
    issueProjections?: unknown[]
    issueDeps?: unknown[]
    repos?: unknown[]
    conversations?: unknown[]
    automations?: unknown[]
    automationRuns?: unknown[]
  },
  chunkRows = BOOTSTRAP_BATCH_ROWS,
): BootstrapChunk[] {
  const entities: Array<[string, unknown[] | undefined, (row: unknown) => string]> = [
    ['session', snapshot.sessions, (r) => (r as { sessionId: string }).sessionId],
    ['issue', snapshot.issues, (r) => (r as { id: string }).id],
    ['issueProjection', snapshot.issueProjections, (r) => (r as { id: string }).id],
    ['issueDep', snapshot.issueDeps, (r) => (r as { id: string }).id],
    ['repo', snapshot.repos, (r) => (r as { id: string }).id],
    ['conversation', snapshot.conversations, (r) => (r as { id: string }).id],
    ['automation', snapshot.automations, (r) => (r as { id: string }).id],
    ['automationRun', snapshot.automationRuns, (r) => (r as { id: string }).id],
  ]
  const changes: MetadataChangeLenient[] = []
  for (const [entity, rows, keyOf] of entities) {
    for (const row of rows ?? []) {
      // `seq: 1` is a placeholder with no meaning on this path and the installer
      // never reads it: a snapshot's rows are not feed positions, they are the
      // state AS OF `snapshotSeq`, which the session already holds on its cursor.
      changes.push({ seq: 1, entity, id: keyOf(row), op: 'upsert', value: row })
    }
  }
  const chunks: BootstrapChunk[] = []
  for (let i = 0; i < changes.length; i += chunkRows) {
    chunks.push({ changes: changes.slice(i, i + chunkRows) })
  }
  return chunks.length > 0 ? chunks : [{ changes: [] }]
}
