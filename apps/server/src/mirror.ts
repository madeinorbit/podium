import { mkdirSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionStore } from './store'

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
    private readonly store: SessionStore,
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

  /** Enqueue every path-known segment of a machine (scan / daemon-attach trigger). */
  enqueueMachine(machineId: string): void {
    for (const seg of this.store.segmentsToMirror(machineId)) {
      this.enqueue(machineId, seg.nativeId, seg.path)
    }
  }

  enqueue(machineId: string, nativeId: string, path: string): void {
    const key = `${machineId}\n${nativeId}`
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
    void this.drain(machineId)
  }

  /** Resolves when the machine's queue is idle — a test/shutdown seam, not API. */
  async settled(machineId: string): Promise<void> {
    while (this.active.has(machineId)) await new Promise((r) => setTimeout(r, 5))
  }

  private async drain(machineId: string): Promise<void> {
    if (this.active.has(machineId)) return
    this.active.add(machineId)
    try {
      // Per-pass byte budget (incident amendment): one drain pass copies at most
      // this many bytes, then stops and DROPS the rest of the queue (queued-state
      // cleared). Cursors are persisted per chunk, so the next scan/attach trigger
      // re-enqueues and resumes exactly where this pass stopped.
      const pass = { remainingBytes: this.passBudgetBytes }
      for (;;) {
        if (pass.remainingBytes <= 0) {
          this.dropQueue(machineId)
          return
        }
        const item = this.queues.get(machineId)?.shift()
        if (!item) return
        const key = `${machineId}\n${item.nativeId}`
        try {
          await this.mirrorOne(machineId, item.nativeId, item.path, pass)
        } catch (err) {
          // Unreadable/denied/timeout: back off this segment, cursor untouched —
          // the next scan/attach after the window retries from where we stopped.
          this.backoffUntil.set(key, this.now() + MirrorService.ERROR_BACKOFF_MS)
          console.warn(`[podium] transcript mirror failed for ${item.nativeId}:`, err)
        } finally {
          this.queued.delete(key)
        }
      }
    } finally {
      this.active.delete(machineId)
    }
  }

  /** Budget exhausted: clear the machine's remaining queue AND its queued-state,
   *  so the next trigger can re-enqueue everything that was deferred. */
  private dropQueue(machineId: string): void {
    const queue = this.queues.get(machineId)
    if (!queue) return
    for (const item of queue) this.queued.delete(`${machineId}\n${item.nativeId}`)
    queue.length = 0
  }

  private async mirrorOne(
    machineId: string,
    nativeId: string,
    path: string,
    pass: { remainingBytes: number },
  ): Promise<void> {
    let cursor = this.store.mirrorCursor(machineId, nativeId)
    // Ops-event guard: if the lake file is SHORTER than the cursor (lake wiped or
    // partially restored while the DB kept its cursors), fall back to what is
    // actually on disk — truncate(cursor) on a shorter file would silently EXTEND
    // it with NUL bytes and mark garbage as mirrored.
    const lakeSize = await this.lakeSize(machineId, nativeId)
    if (lakeSize < cursor) {
      cursor = lakeSize
      this.store.setMirrorCursor(machineId, nativeId, cursor, this.nowIso())
    }
    for (;;) {
      const res = await this.read(machineId, {
        path,
        offset: cursor,
        maxBytes: MirrorService.CHUNK_BYTES,
      })
      if (res.error) throw new Error(res.error)
      if (res.fileSize < cursor) {
        // The native file SHRANK — it was rewritten, not appended. Verbatim-mirror
        // correctness: drop our copy and re-pull from zero (spec §2.3). Everything
        // indexed off the old copy is invalid too — signal BEFORE the re-pull so
        // the reindex starts from a clean slate as chunks arrive.
        this.onTruncate(machineId, nativeId)
        await this.writeAt(machineId, nativeId, 0, Buffer.alloc(0))
        this.store.setMirrorCursor(machineId, nativeId, 0, this.nowIso())
        cursor = 0
        continue
      }
      const bytes = Buffer.from(res.data, 'base64')
      if (bytes.length > 0) {
        // Lake write BEFORE cursor advance (spec invariant 2): a crash between the
        // two re-pulls this chunk and overwrites it byte-identically at the cursor.
        await this.writeAt(machineId, nativeId, cursor, bytes)
        cursor += bytes.length
        this.store.setMirrorCursor(machineId, nativeId, cursor, this.nowIso())
        this.onBytes(machineId, nativeId, this.lakePath(machineId, nativeId))
        pass.remainingBytes -= bytes.length
        // Inter-chunk breather (incident amendment): never pump chunks
        // back-to-back — the 2026-07 bootstrap starved the event loop doing so.
        if (this.chunkDelayMs > 0) await this.sleep(this.chunkDelayMs)
      } else if (!res.eof) {
        throw new Error('empty non-eof mirror chunk') // defensive: avoid a spin
      }
      if (res.eof) return
      if (pass.remainingBytes <= 0) return // budget hit mid-file: cursor persisted, next pass resumes
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
