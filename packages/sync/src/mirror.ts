import { machineScopedKey } from '@podium/model'
import { mkdirSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The conversation-segment surface MirrorService needs — narrow on purpose so
 *  this package depends on neither apps/server's full ConversationsRepository
 *  nor SessionStore (packages must not import apps/*). apps/server's
 *  ConversationsRepository (store/conversations.ts) satisfies this structurally
 *  — it's passed straight through at the call site. */
export interface MirrorStore {
  segmentsToMirror(machineId: string): { nativeId: string; path: string; mirroredBytes: number }[]
  segmentsToMirrorDirty(
    machineId: string,
  ): { nativeId: string; path: string; mirroredBytes: number }[]
  setReportedBytes(machineId: string, nativeId: string, bytes: number): void
  mirrorCursor(machineId: string, nativeId: string): number
  setMirrorCursor(machineId: string, nativeId: string, bytes: number, at: string): void
}

/** One ranged read answered by the daemon (transcriptMirrorResult, decoded). */
export interface MirrorReadResult {
  data: string // base64
  fileSize: number
  eof: boolean
  error?: string
}

/** Pacing knobs (docs/spec/transcript-mirror.md §2.3 "Pacing"). Defaults are the
 *  production posture; tests inject 0-delay / huge-budget to stay fast. */
export interface MirrorServiceOptions {
  /** Pause after every chunk write so the event loop breathes (unref'd setTimeout). */
  chunkDelayMs?: number
  /** Max bytes copied per machine per drain pass; leftover work waits for the next
   *  scan/attach trigger and resumes from the persisted cursors. */
  passBudgetBytes?: number
  /** Fires after each chunk write + cursor advance — the transcript indexer's feed
   *  (docs/spec/search-v1.md §2.3). MirrorService itself stays indexing-free. */
  onBytes?: (machineId: string, nativeId: string, lakePath: string) => void
  /** Fires when a rewrite (source shrank) truncated the lake copy — the indexed
   *  content for the segment is invalid and must be dropped before the re-mirror. */
  onTruncate?: (machineId: string, nativeId: string) => void
}

/**
 * Transcript lake mirror (docs/spec/transcript-mirror.md): server-driven ranged
 * pulls of native transcript files into `$lakeDir/<machineId>/<nativeId>.jsonl`,
 * byte-verbatim, resumable via the per-segment `mirrored_bytes` cursor.
 *
 * Scheduling posture (spec invariant 4): one in-flight read per machine, bounded
 * chunks, work enqueued from scans/attach — transcripts are cold data and must
 * never compete with the PTY path.
 *
 * Pacing (incident amendment, spec §2.3): an inter-chunk delay plus a per-pass
 * byte budget keep a big-lake bootstrap from pumping chunks back-to-back — the
 * 2026-07 deploy did exactly that on daemon attach, pegged the server CPU, and
 * the systemd watchdog SIGABRT'd it into a crash loop. Bootstrap now spreads
 * over many scan/attach triggers by design.
 */
export class MirrorService {
  /** Per-machine FIFO of segments awaiting a pull. */
  private readonly queues = new Map<string, { nativeId: string; path: string }[]>()
  /** Machines with a drain loop running (single-flight per machine). */
  private readonly active = new Set<string>()
  /** Segment keys queued or in flight — an enqueue for one is a no-op. */
  private readonly queued = new Set<string>()
  /** Segment keys in error backoff until the mapped epoch-ms. */
  private readonly backoffUntil = new Map<string, number>()
  /**
   * Reversible write fence used while the server takes a transfer snapshot.
   * Unlike {@link stopped}, pausing preserves queues and dedup state so an abort
   * can resume every deferred segment from its persisted cursor.
   */
  private paused = false
  /** Pause callers waiting for every per-machine drain to reach the fence. */
  private readonly pauseWaiters = new Set<() => void>()
  /**
   * Set by {@link dispose}. Everything this service does after a chunk is async
   * and PACED, so at shutdown there is essentially always a drain mid-flight —
   * and its owner's store is closed the moment it returns. Without this flag the
   * loop went on to write backoff state and `console.warn` against a closed
   * SQLite handle up to a full read timeout AFTER the process reported a clean
   * stop (POD-1390; the same family as POD-1101's late index callback).
   */
  private stopped = false

  static readonly CHUNK_BYTES = 256 * 1024
  /** Breather after each chunk write — bounds mirror duty cycle to roughly
   *  chunk-cost/(chunk-cost+25ms), keeping the loop responsive (sd_notify pings,
   *  daemon replies) even during a cold-lake bootstrap. */
  static readonly CHUNK_DELAY_MS = 25
  /** Per drain pass per machine. At 25ms/chunk a 16 MB pass takes ~2s of paced
   *  work; a multi-GB lake bootstraps over minutes-to-hours of ~15s scan ticks —
   *  fine, transcripts are cold data (spec invariant 4). */
  static readonly PASS_BUDGET_BYTES = 16 * 1024 * 1024
  private static readonly ERROR_BACKOFF_MS = 5 * 60_000

  private readonly chunkDelayMs: number
  private readonly passBudgetBytes: number
  private readonly onBytes: (machineId: string, nativeId: string, lakePath: string) => void
  private readonly onTruncate: (machineId: string, nativeId: string) => void

  constructor(
    private readonly store: MirrorStore,
    private readonly lakeDir: string,
    private readonly read: (
      machineId: string,
      req: { path: string; offset: number; maxBytes: number },
    ) => Promise<MirrorReadResult>,
    private readonly now: () => number = Date.now,
    options: MirrorServiceOptions = {},
  ) {
    this.chunkDelayMs = options.chunkDelayMs ?? MirrorService.CHUNK_DELAY_MS
    this.passBudgetBytes = options.passBudgetBytes ?? MirrorService.PASS_BUDGET_BYTES
    this.onBytes = options.onBytes ?? (() => {})
    this.onTruncate = options.onTruncate ?? (() => {})
  }

  lakePath(machineId: string, nativeId: string): string {
    return join(this.lakeDir, machineId, `${nativeId}.jsonl`)
  }

  /** Enqueue every path-known segment of a machine — the FULL sweep. Kept as the
   *  manual-reconcile / test seam; the scan/attach triggers use {@link enqueueDirty}
   *  instead (spec §2.3 "Dirty-driven"): a full sweep of a caught-up fleet still
   *  costs one daemon eof-check round trip PER SEGMENT (~1,150 reads ≈ 2s wall on
   *  the hot control channel per attach), which is exactly the regression the
   *  dirty set eliminates. */
  enqueueMachine(machineId: string): void {
    for (const seg of this.store.segmentsToMirror(machineId)) {
      this.enqueue(machineId, seg.nativeId, seg.path)
    }
  }

  /** Enqueue ONLY the machine's dirty segments: daemon-reported size ≠ mirrored
   *  cursor, plus never-reported (NULL) rows which stay dirty until one pull
   *  records their observed size (upgrade path — the fleet converges, then a
   *  caught-up machine enqueues NOTHING and issues ZERO mirror reads). */
  enqueueDirty(machineId: string): void {
    for (const seg of this.store.segmentsToMirrorDirty(machineId)) {
      this.enqueue(machineId, seg.nativeId, seg.path)
    }
  }

  enqueue(machineId: string, nativeId: string, path: string): void {
    const key = machineScopedKey(machineId, nativeId)
    if (this.queued.has(key)) return
    const backoff = this.backoffUntil.get(key)
    if (backoff !== undefined) {
      if (backoff > this.now()) return
      this.backoffUntil.delete(key) // expired — drop the entry (bounded map)
    }
    this.queued.add(key)
    let queue = this.queues.get(machineId)
    if (!queue) {
      queue = []
      this.queues.set(machineId, queue)
    }
    queue.push({ nativeId, path })
    if (!this.paused) void this.drain(machineId)
  }

  /**
   * Fence lake mutation and wait for every active per-machine drain to stop.
   *
   * A drain already inside a filesystem write is allowed to finish that write
   * and persist its matching cursor before it exits. A drain waiting on a
   * daemon read discards that response without writing and puts the segment
   * back at the head of its queue. New enqueue/dirty triggers keep accumulating
   * while paused; {@link resume} restarts them all from persisted cursors.
   */
  async pause(): Promise<void> {
    if (this.stopped) return
    this.paused = true
    if (this.active.size === 0) return
    await new Promise<void>((resolve) => this.pauseWaiters.add(resolve))
  }

  /** Lift a reversible pause and restart every preserved machine queue. */
  resume(): void {
    if (this.stopped || !this.paused) return
    this.paused = false
    for (const [machineId, queue] of this.queues) {
      if (queue.length > 0) void this.drain(machineId)
    }
  }

  /**
   * Stop for good: no further pulls are enqueued, the in-flight drain returns at
   * its next checkpoint, and nothing after this point touches the store or the
   * console. Idempotent, synchronous, and deliberately NOT awaited — the owner
   * calls it while the store is still open, and an already-issued ranged read
   * may still be outstanding against a daemon that will never answer.
   */
  dispose(): void {
    this.stopped = true
    for (const machineId of [...this.queues.keys()]) this.dropQueue(machineId)
  }

  /** Resolves when the machine's queue is idle — a test/shutdown seam, not API. */
  async settled(machineId: string): Promise<void> {
    while (this.active.has(machineId)) await new Promise((r) => setTimeout(r, 5))
  }

  private async drain(machineId: string): Promise<void> {
    if (this.stopped || this.paused || this.active.has(machineId)) return
    this.active.add(machineId)
    try {
      // Per-pass byte budget (incident amendment): one drain pass copies at most
      // this many bytes, then stops and DROPS the rest of the queue (queued-state
      // cleared). Cursors are persisted per chunk, so the next scan/attach trigger
      // re-enqueues and resumes exactly where this pass stopped.
      const pass = { remainingBytes: this.passBudgetBytes }
      for (;;) {
        if (this.stopped) return
        if (this.paused) return
        if (pass.remainingBytes <= 0) {
          this.dropQueue(machineId)
          return
        }
        const item = this.queues.get(machineId)?.shift()
        if (!item) return
        const key = machineScopedKey(machineId, item.nativeId)
        let preserveQueued = false
        try {
          const completed = await this.mirrorOne(machineId, item.nativeId, item.path, pass)
          if (!completed) {
            // Pause won while this item was in flight. It stays deduplicated and
            // returns to the FRONT so resume retries it before later segments.
            preserveQueued = true
            this.queues.get(machineId)?.unshift(item)
            return
          }
        } catch (err) {
          // Disposed while this pull was outstanding: the store is closing or
          // closed, so neither branch below may run. The failure is an artifact
          // of the shutdown, not news — reporting it is exactly the noise that
          // makes a clean stop indistinguishable from a broken one.
          if (this.stopped) return
          if (err instanceof Error && err.message === 'denied') {
            // The daemon can't serve this path anymore — the native file was
            // DELETED (the exact scenario the lake is the backup for). Nothing
            // will ever be pullable again and no scan will refresh its size, so
            // without this it would retry every backoff window forever. Mark it
            // converged; if the file ever reappears, the scan reports a fresh
            // size and it turns dirty again.
            this.store.setReportedBytes(
              machineId,
              item.nativeId,
              this.store.mirrorCursor(machineId, item.nativeId),
            )
            console.info(
              `[podium] transcript mirror: source gone for ${item.nativeId} — lake copy is now the only copy`,
            )
          } else {
            // Unreadable/timeout: back off this segment, cursor untouched — the
            // next scan/attach after the window retries from where we stopped.
            this.backoffUntil.set(key, this.now() + MirrorService.ERROR_BACKOFF_MS)
            console.warn(`[podium] transcript mirror failed for ${item.nativeId}:`, err)
          }
        } finally {
          if (!preserveQueued) this.queued.delete(key)
        }
      }
    } finally {
      this.active.delete(machineId)
      if (this.active.size === 0) {
        for (const resolve of this.pauseWaiters) resolve()
        this.pauseWaiters.clear()
      }
    }
  }

  /** Budget exhausted: clear the machine's remaining queue AND its queued-state,
   *  so the next trigger can re-enqueue everything that was deferred. */
  private dropQueue(machineId: string): void {
    const queue = this.queues.get(machineId)
    if (!queue) return
    for (const item of queue) this.queued.delete(machineScopedKey(machineId, item.nativeId))
    queue.length = 0
  }

  private async mirrorOne(
    machineId: string,
    nativeId: string,
    path: string,
    pass: { remainingBytes: number },
  ): Promise<boolean> {
    let cursor = this.store.mirrorCursor(machineId, nativeId)
    // Ops-event guard: if the lake file is SHORTER than the cursor (lake wiped or
    // partially restored while the DB kept its cursors), fall back to what is
    // actually on disk — truncate(cursor) on a shorter file would silently EXTEND
    // it with NUL bytes and mark garbage as mirrored.
    const lakeSize = await this.lakeSize(machineId, nativeId)
    if (this.stopped) return true
    if (this.paused) return false
    if (lakeSize < cursor) {
      cursor = lakeSize
      this.store.setMirrorCursor(machineId, nativeId, cursor, this.nowIso())
    }
    for (;;) {
      if (this.paused) return false
      const res = await this.read(machineId, {
        path,
        offset: cursor,
        maxBytes: MirrorService.CHUNK_BYTES,
      })
      // Every line below writes to the store; disposal can have closed it while
      // this read was outstanding. Bail before the write, not after it throws.
      if (this.stopped) return true
      // The ranged read itself is harmless to the snapshot. If the fence went
      // up while it was outstanding, preserve the item and never turn its reply
      // into a lake write.
      if (this.paused) return false
      if (res.error) throw new Error(res.error)
      if (res.fileSize < cursor) {
        // The native file SHRANK — it was rewritten, not appended. Verbatim-mirror
        // correctness: drop our copy and re-pull from zero (spec §2.3). Everything
        // indexed off the old copy is invalid too — signal BEFORE the re-pull so
        // the reindex starts from a clean slate as chunks arrive.
        this.onTruncate(machineId, nativeId)
        await this.writeAt(machineId, nativeId, 0, Buffer.alloc(0))
        // Disposal may close the store while the filesystem mutation is
        // outstanding. The lake can be repaired from its persisted cursor on
        // the next start; touching the closed store here cannot be repaired.
        if (this.stopped) return true
        this.store.setMirrorCursor(machineId, nativeId, 0, this.nowIso())
        cursor = 0
        if (this.paused) return false
        continue
      }
      const bytes = Buffer.from(res.data, 'base64')
      if (bytes.length > 0) {
        // Lake write BEFORE cursor advance (spec invariant 2): a crash between the
        // two re-pulls this chunk and overwrites it byte-identically at the cursor.
        await this.writeAt(machineId, nativeId, cursor, bytes)
        // dispose() is synchronous and the owner closes the store immediately
        // afterwards. A write already awaiting the filesystem may finish, but
        // it must not advance cursors or notify the indexer after that boundary.
        if (this.stopped) return true
        cursor += bytes.length
        this.store.setMirrorCursor(machineId, nativeId, cursor, this.nowIso())
        this.onBytes(machineId, nativeId, this.lakePath(machineId, nativeId))
        pass.remainingBytes -= bytes.length
        // A pause may have arrived while writeAt was awaiting the filesystem.
        // Cursor and lake are consistent now; stop before another read/write.
        if (this.paused) return false
        // Inter-chunk breather (incident amendment): never pump chunks
        // back-to-back — the 2026-07 bootstrap starved the event loop doing so.
        if (this.chunkDelayMs > 0) {
          await this.sleep(this.chunkDelayMs)
          if (this.paused) return false
        }
      } else if (!res.eof) {
        throw new Error('empty non-eof mirror chunk') // defensive: avoid a spin
      }
      if (res.eof) {
        // Fully caught up: the cursor IS the file size we just observed — record
        // it as the reported size so the dirty set drops this segment. This is
        // what quiets NULL-reported rows (pre-upgrade / size-less providers), and
        // it is FRESHER than the scan's stat (a grow that raced the scan report is
        // covered: we mirrored to the real eof). A later grow re-dirties via the
        // next scan's sizeBytes.
        this.store.setReportedBytes(machineId, nativeId, cursor)
        return true
      }
      // Budget hit mid-file: cursor persisted, next pass resumes. This is normal
      // pass completion rather than a pause, so the next scan may re-enqueue it.
      if (pass.remainingBytes <= 0) return true
    }
  }

  /** Unref'd sleep — pacing must never hold the process open at shutdown. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }

  /** Truncate the lake file to `offset`, then append `bytes` — enforcing
   *  "lake size === cursor" before every write, so replays can't leave tails. */
  private async writeAt(
    machineId: string,
    nativeId: string,
    offset: number,
    bytes: Buffer,
  ): Promise<void> {
    const path = this.lakePath(machineId, nativeId)
    mkdirSync(dirname(path), { recursive: true })
    // 'a' creates the file when missing; POSIX append mode ignores the write
    // position and always writes at END — which, after truncate(offset), IS
    // offset. The truncate-then-append pair is what enforces the invariant.
    const handle = await open(path, 'a')
    try {
      await handle.truncate(offset)
      if (bytes.length > 0) await handle.write(bytes, 0, bytes.length)
    } finally {
      await handle.close()
    }
  }

  private async lakeSize(machineId: string, nativeId: string): Promise<number> {
    try {
      return (await stat(this.lakePath(machineId, nativeId))).size
    } catch {
      return 0 // no lake file yet
    }
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString()
  }
}
