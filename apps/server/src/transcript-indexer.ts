import { open } from 'node:fs/promises'
import { claudeRecordToItems } from '@podium/agent-bridge'
import type { SessionStore } from './store'

/** Pacing knobs, mirroring MirrorServiceOptions (transcript-mirror spec §2.3
 *  "Pacing"). Defaults are the production posture; tests inject 0-delay /
 *  small-window / small-budget knobs to stay fast and to pin the pacing. */
export interface TranscriptIndexerOptions {
  /** Pause between successive index windows / backfill segments (unref'd). */
  chunkDelayMs?: number
  /** Max lake bytes consumed per {@link TranscriptIndexer.backfillMachine} call;
   *  leftover work waits for the next scan/attach trigger and resumes from the
   *  persisted indexed_bytes cursors. */
  passBudgetBytes?: number
  /** Max bytes read + parsed per index window — bounds the synchronous JSON/FTS
   *  work a single loop turn can pin. */
  windowBytes?: number
}

/**
 * Transcript FTS indexer (docs/spec/search-v1.md §2.3): consumes MirrorService's
 * `onBytes`/`onTruncate` hooks and turns newly-mirrored lake bytes into
 * `transcript_fts` rows. Reads windows of `indexed_bytes..mirrored_bytes`, splits
 * COMPLETE lines only (a partial trailing line waits for the next chunk — the
 * cursor is a byte offset, so nothing is lost), parses each line as a Claude
 * record and indexes the plain text of user/assistant messages. Live indexing
 * rides the mirror's own pacing: one hook call per (already-paced) chunk.
 *
 * Backfill: segments fully mirrored BEFORE the indexer existed never get an
 * `onBytes` hook, so `backfillMachine` sweeps every segment whose lake copy is
 * ahead of its index cursor. It is paced like the mirror's bootstrap (incident
 * amendment, transcript-mirror spec §2.3): bounded read windows, an unref'd
 * inter-window delay, and a per-call byte budget — a multi-hundred-MB lake
 * backfills over many scan/attach triggers instead of starving the event loop
 * into the systemd watchdog.
 *
 * FTS5 unavailable → every call is a no-op (the store flag gates it); the search
 * service simply has no transcript source in that degraded mode.
 */
export class TranscriptIndexer {
  /** Breather between index windows / backfill segments — same posture as the
   *  mirror's inter-chunk delay, and for the same reason (watchdog compat). */
  static readonly CHUNK_DELAY_MS = 25
  /** Per backfill pass per machine. Local file reads are far cheaper than the
   *  mirror's wire pulls, but each window also pays JSON.parse + FTS inserts on
   *  the loop, so the budget matches the mirror's (16 MB / pass). */
  static readonly PASS_BUDGET_BYTES = 16 * 1024 * 1024
  /** Bytes read + parsed per window. */
  static readonly WINDOW_BYTES = 4 * 1024 * 1024

  /** Segment keys with an index run in flight — a second onBytes marks a rerun
   *  instead of interleaving reads over the same cursor. */
  private readonly running = new Map<string, { rerun: boolean; lakePath: string }>()
  /** Machines with a backfill sweep in flight (single-flight per machine). */
  private readonly backfilling = new Set<string>()

  private readonly chunkDelayMs: number
  private readonly passBudgetBytes: number
  private readonly windowBytes: number

  constructor(
    private readonly store: SessionStore,
    options: TranscriptIndexerOptions = {},
  ) {
    this.chunkDelayMs = options.chunkDelayMs ?? TranscriptIndexer.CHUNK_DELAY_MS
    this.passBudgetBytes = options.passBudgetBytes ?? TranscriptIndexer.PASS_BUDGET_BYTES
    this.windowBytes = options.windowBytes ?? TranscriptIndexer.WINDOW_BYTES
  }

  /** Mirror hook: new bytes landed in the lake for this segment. */
  onBytes(machineId: string, nativeId: string, lakePath: string): void {
    const key = `${machineId}\n${nativeId}`
    const active = this.running.get(key)
    if (active) {
      active.rerun = true
      active.lakePath = lakePath
      return
    }
    this.running.set(key, { rerun: false, lakePath })
    void this.run(key, machineId, nativeId)
  }

  /** Mirror hook: the lake copy was truncated for a re-mirror — the indexed
   *  content is invalid. Synchronous, so an in-flight run's cursor check below
   *  observes the reset before it can append stale rows. */
  onTruncate(machineId: string, nativeId: string): void {
    this.store.dropTranscriptIndex(machineId, nativeId)
  }

  /**
   * Catch-up sweep (scan / daemon-attach trigger, alongside the mirror's
   * enqueueMachine): index every segment whose lake copy holds bytes the FTS
   * index hasn't consumed — lakes mirrored before this indexer deployed, and
   * whatever a budget-stopped earlier pass left behind. Cheap no-op when nothing
   * is behind; single-flight per machine.
   */
  backfillMachine(machineId: string, lakePathFor: (nativeId: string) => string): void {
    if (this.backfilling.has(machineId)) return
    if (!this.store.transcriptIndexAvailable) return
    const behind = this.store.segmentsToIndex(machineId)
    if (behind.length === 0) return
    this.backfilling.add(machineId)
    void this.backfill(
      machineId,
      behind.map((s) => s.nativeId),
      lakePathFor,
    )
  }

  private async backfill(
    machineId: string,
    nativeIds: string[],
    lakePathFor: (nativeId: string) => string,
  ): Promise<void> {
    try {
      // Per-pass byte budget (mirror incident amendment): one sweep consumes at
      // most this many lake bytes, then stops. indexed_bytes persists per window,
      // so the next scan/attach trigger resumes exactly where this pass stopped.
      const pass = { remainingBytes: this.passBudgetBytes }
      for (const nativeId of nativeIds) {
        if (pass.remainingBytes <= 0) return
        const key = `${machineId}\n${nativeId}`
        // A live onBytes run is already catching this segment up — skip it here.
        if (this.running.has(key)) continue
        this.running.set(key, { rerun: false, lakePath: lakePathFor(nativeId) })
        await this.run(key, machineId, nativeId, pass)
        // Breathe between segments, not just between windows within one.
        if (this.chunkDelayMs > 0) await this.sleep(this.chunkDelayMs)
      }
    } finally {
      this.backfilling.delete(machineId)
    }
  }

  /** Resolves when every in-flight index run and backfill sweep has settled —
   *  a test seam, not API. */
  async settled(): Promise<void> {
    while (this.running.size > 0 || this.backfilling.size > 0) {
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  /** Drive one segment to caught-up (or budget exhaustion), one bounded window
   *  per iteration with a breather in between. Owns the `running` entry. */
  private async run(
    key: string,
    machineId: string,
    nativeId: string,
    pass?: { remainingBytes: number },
  ): Promise<void> {
    try {
      for (;;) {
        const state = this.running.get(key)
        if (!state) return
        state.rerun = false
        let consumed = 0
        try {
          consumed = await this.indexWindow(machineId, nativeId, state.lakePath)
        } catch (err) {
          // Unreadable lake file / SQLite error: cursor untouched, the next
          // mirrored chunk or backfill sweep retries the same window.
          console.warn(`[podium] transcript index failed for ${nativeId}:`, err)
          return
        }
        if (pass) pass.remainingBytes -= consumed
        const behind =
          this.store.indexedCursor(machineId, nativeId) <
          this.store.mirrorCursor(machineId, nativeId)
        // consumed 0 with bytes still behind = only a partial trailing line so
        // far — nothing more to do until the mirror completes the record.
        if ((consumed === 0 || !behind) && !state.rerun) return
        if (pass && pass.remainingBytes <= 0) return // budget hit mid-file: resume next pass
        if (this.chunkDelayMs > 0) await this.sleep(this.chunkDelayMs)
      }
    } finally {
      this.running.delete(key)
    }
  }

  /** Index one bounded window from the segment's cursor; returns the bytes
   *  consumed (0 = caught up, or only a partial trailing line remains). */
  private async indexWindow(
    machineId: string,
    nativeId: string,
    lakePath: string,
  ): Promise<number> {
    if (!this.store.transcriptIndexAvailable) return 0
    const from = this.store.indexedCursor(machineId, nativeId)
    const to = this.store.mirrorCursor(machineId, nativeId)
    if (to <= from) return 0
    let win = this.windowBytes
    let buf: Buffer
    let lastNl: number
    for (;;) {
      buf = await readRange(lakePath, from, Math.min(to, from + win))
      // Complete lines only: everything past the last newline is a partial record
      // still being mirrored — it stays unindexed until a later chunk completes it.
      lastNl = buf.lastIndexOf(0x0a)
      if (lastNl >= 0 || from + win >= to) break
      win *= 2 // a single record wider than the window — widen until its newline shows
    }
    if (lastNl < 0) return 0
    const rows = extractMessageRows(buf.subarray(0, lastNl + 1))
    // Optimistic-concurrency check: an onTruncate during the (async) read above
    // reset the cursor — these rows were computed from dead content, drop them.
    // No await between this check and the append, so the check can't go stale.
    if (this.store.indexedCursor(machineId, nativeId) !== from) return 0
    this.store.appendTranscriptIndex(machineId, nativeId, rows, from + lastNl + 1)
    return lastNl + 1
  }

  /** Unref'd sleep — pacing must never hold the process open at shutdown. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }
}

/** Read the byte window `[from, to)` of a file. */
async function readRange(path: string, from: number, to: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const b = Buffer.alloc(to - from)
    const { bytesRead } = await handle.read(b, 0, b.length, from)
    return b.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Plain-text FTS rows for the user/assistant messages in a complete-lines buffer.
 *  Reuses agent-bridge's Claude record→items conversion (the lake is the native
 *  JSONL byte-verbatim), then keeps only conversational text: tool calls/results,
 *  system lines and meta records carry no searchable prose. Unparseable lines are
 *  skipped but still consumed — the byte cursor advances past them exactly once. */
function extractMessageRows(buf: Buffer): { content: string; itemUuid?: string; ts?: string }[] {
  const rows: { content: string; itemUuid?: string; ts?: string }[] = []
  for (const line of buf.toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    for (const item of claudeRecordToItems(record)) {
      if (item.role !== 'user' && item.role !== 'assistant') continue
      if (item.toolName !== undefined) continue // a tool call, not prose
      const content = item.text.trim()
      if (!content) continue
      rows.push({
        content,
        itemUuid: item.id,
        ...(item.ts !== undefined ? { ts: item.ts } : {}),
      })
    }
  }
  return rows
}
