import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type MirrorReadResult, MirrorService, type MirrorServiceOptions } from './mirror'
import { SessionStore } from './store'

// MirrorService (docs/spec/transcript-mirror.md §2.3/§3) against a fake daemon:
// the read callback serves ranged reads from in-memory buffers and logs every
// request, so tests can assert both the LAKE outcome (byte-identical files,
// cursor === size) and the REQUEST pattern (chunking, tail-only pulls, backoff,
// per-machine serialization).

interface ReadLog {
  path: string
  offset: number
  maxBytes: number
}

/** In-memory "daemon filesystem": one buffer per path, ranged reads, request log,
 *  optional per-path error injection and in-flight concurrency tracking. */
class FakeDaemonFs {
  private readonly files = new Map<string, Buffer>()
  readonly log: ReadLog[] = []
  /** performance.now() at each read — lets tests assert inter-chunk spacing. */
  readonly readTimes: number[] = []
  readonly errors = new Map<string, string>()
  delayMs = 0
  /** Synchronous spin per read — models the wire decode/encode CPU a real chunk
   *  costs the server (JSON + zod + base64), for the loop-lag regression test. */
  busyMs = 0
  private inFlight = 0
  maxInFlight = 0

  set(path: string, content: string | Buffer): void {
    this.files.set(path, Buffer.from(content))
  }

  read = async (
    _machineId: string,
    req: { path: string; offset: number; maxBytes: number },
  ): Promise<MirrorReadResult> => {
    this.log.push({ ...req })
    this.readTimes.push(performance.now())
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.busyMs > 0) {
      const until = performance.now() + this.busyMs
      while (performance.now() < until) {
        // spin: synchronous CPU, exactly what the loop pays per inbound frame
      }
    }
    this.inFlight -= 1 // decrement BEFORE resolve: serialized callers never overlap
    const error = this.errors.get(req.path)
    if (error) return { data: '', fileSize: 0, eof: true, error }
    const content = this.files.get(req.path) ?? Buffer.alloc(0)
    const size = content.length
    const end = Math.min(size, req.offset + req.maxBytes)
    const slice = req.offset < size ? content.subarray(req.offset, end) : Buffer.alloc(0)
    return { data: slice.toString('base64'), fileSize: size, eof: end >= size }
  }
}

function patternBytes(size: number, seed = 0): Buffer {
  const b = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) % 251
  return b
}

/** 0-delay + unlimited budget by default so the pre-pacing tests stay fast and
 *  byte-exact; pacing tests inject their own knobs. */
function setup(options?: MirrorServiceOptions) {
  const store = new SessionStore(':memory:')
  const lakeDir = mkdtempSync(join(tmpdir(), 'podium-lake-'))
  const fs = new FakeDaemonFs()
  const mirror = new MirrorService(store, lakeDir, fs.read, Date.now, {
    chunkDelayMs: 0,
    passBudgetBytes: Number.MAX_SAFE_INTEGER,
    ...options,
  })
  return { store, lakeDir, fs, mirror }
}

function seed(store: SessionStore, machineId: string, nativeId: string): string {
  const path = `/home/u/.claude/projects/-proj/${nativeId}.jsonl`
  store.ensureConversationIdentity({
    machineId,
    nativeId,
    providerId: 'claude-code-jsonl',
    path,
  })
  return path
}

/** Await queue idleness. enqueue() kicks drain synchronously, but retry a few
 *  ticks anyway so back-to-back enqueues can't race the assertion. */
async function settle(mirror: MirrorService, machineId: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await mirror.settled(machineId)
    await new Promise((r) => setTimeout(r, 5))
  }
  await mirror.settled(machineId)
}

describe('MirrorService', () => {
  it('pulls a large file in bounded chunks to a byte-identical lake copy', async () => {
    const { store, fs, mirror } = setup()
    const content = patternBytes(MirrorService.CHUNK_BYTES + 1000)
    const path = seed(store, 'm1', 'big')
    fs.set(path, content)

    mirror.enqueue('m1', 'big', path)
    await settle(mirror, 'm1')

    expect(readFileSync(mirror.lakePath('m1', 'big')).equals(content)).toBe(true)
    expect(store.mirrorCursor('m1', 'big')).toBe(content.length)
    // Chunked: at least two ranged reads, offsets strictly advancing from 0.
    expect(fs.log.length).toBeGreaterThanOrEqual(2)
    expect(fs.log[0]).toEqual({ path, offset: 0, maxBytes: MirrorService.CHUNK_BYTES })
    expect(fs.log[1]?.offset).toBe(MirrorService.CHUNK_BYTES)
    const offsets = fs.log.map((r) => r.offset)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    expect(new Set(offsets).size).toBe(offsets.length) // strictly advancing, never repeated
    store.close()
  })

  it('pulls only the tail on incremental append', async () => {
    const { store, fs, mirror } = setup()
    const path = seed(store, 'm1', 'grow')
    const before = Buffer.from('{"line":1}\n{"line":2}\n')
    fs.set(path, before)
    mirror.enqueue('m1', 'grow', path)
    await settle(mirror, 'm1')
    expect(store.mirrorCursor('m1', 'grow')).toBe(before.length)

    const grown = Buffer.concat([before, Buffer.from('{"line":3}\n')])
    fs.set(path, grown)
    const logBefore = fs.log.length
    mirror.enqueue('m1', 'grow', path)
    await settle(mirror, 'm1')

    // The first new read starts exactly at the old size — no re-pull of the head.
    expect(fs.log[logBefore]?.offset).toBe(before.length)
    expect(readFileSync(mirror.lakePath('m1', 'grow')).equals(grown)).toBe(true)
    expect(store.mirrorCursor('m1', 'grow')).toBe(grown.length)
    store.close()
  })

  it('truncates and re-pulls from zero when the source shrank (rewrite)', async () => {
    const { store, fs, mirror } = setup()
    const path = seed(store, 'm1', 'rewrite')
    const original = patternBytes(50_000, 1)
    fs.set(path, original)
    mirror.enqueue('m1', 'rewrite', path)
    await settle(mirror, 'm1')
    expect(store.mirrorCursor('m1', 'rewrite')).toBe(original.length)

    // Native file rewritten SHORTER — verbatim mirror must drop the copy and
    // re-pull, never leave a stale tail (spec invariant 1).
    const rewritten = patternBytes(12_345, 2)
    fs.set(path, rewritten)
    mirror.enqueue('m1', 'rewrite', path)
    await settle(mirror, 'm1')

    expect(readFileSync(mirror.lakePath('m1', 'rewrite')).equals(rewritten)).toBe(true)
    expect(store.mirrorCursor('m1', 'rewrite')).toBe(rewritten.length)
    store.close()
  })

  it('a deleted source (denied) marks the segment converged — no eternal retries', async () => {
    const { store, fs, mirror } = setup()
    const path = seed(store, 'm1', 'gone')
    store.setMirrorCursor('m1', 'gone', 500, new Date().toISOString()) // lake holds 500B already
    fs.errors.set(path, 'denied')
    mirror.enqueue('m1', 'gone', path)
    await settle(mirror, 'm1')
    // reported == mirrored: the dirty query no longer selects it — scans go quiet.
    expect(store.segmentsToMirrorDirty('m1').find((x) => x.nativeId === 'gone')).toBeUndefined()
  })

  it('backs off on a read error: cursor untouched, no lake file, re-enqueue is a no-op', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store, fs, mirror } = setup()
      const path = seed(store, 'm1', 'denied')
      fs.set(path, 'never served\n')
      fs.errors.set(path, 'timeout')

      mirror.enqueue('m1', 'denied', path)
      await settle(mirror, 'm1')

      expect(store.mirrorCursor('m1', 'denied')).toBe(0)
      expect(existsSync(mirror.lakePath('m1', 'denied'))).toBe(false)
      expect(fs.log.length).toBe(1)

      // Inside the backoff window the segment is not retried, even if the source
      // would now succeed — no new read requests at all.
      fs.errors.delete(path)
      mirror.enqueue('m1', 'denied', path)
      await settle(mirror, 'm1')
      expect(fs.log.length).toBe(1)
      expect(store.mirrorCursor('m1', 'denied')).toBe(0)
      expect(warn).toHaveBeenCalled()
      store.close()
    } finally {
      warn.mockRestore()
    }
  })

  it('serializes reads per machine (max in-flight 1 across two segments)', async () => {
    const { store, fs, mirror } = setup()
    fs.delayMs = 10
    const pathA = seed(store, 'm1', 'seg-a')
    const pathB = seed(store, 'm1', 'seg-b')
    fs.set(pathA, patternBytes(70_000, 3))
    fs.set(pathB, patternBytes(70_000, 4))

    mirror.enqueueMachine('m1')
    await settle(mirror, 'm1')

    expect(fs.maxInFlight).toBe(1)
    expect(readFileSync(mirror.lakePath('m1', 'seg-a')).equals(patternBytes(70_000, 3))).toBe(true)
    expect(readFileSync(mirror.lakePath('m1', 'seg-b')).equals(patternBytes(70_000, 4))).toBe(true)
    store.close()
  })

  it('lets two machines proceed independently, both completing', async () => {
    const { store, fs, mirror } = setup()
    fs.delayMs = 10
    const pathA = seed(store, 'm1', 'conv-a')
    const pathB = seed(store, 'm2', 'conv-b')
    fs.set(pathA, patternBytes(30_000, 5))
    fs.set(pathB, patternBytes(30_000, 6))

    mirror.enqueueMachine('m1')
    mirror.enqueueMachine('m2')
    await settle(mirror, 'm1')
    await settle(mirror, 'm2')

    expect(readFileSync(mirror.lakePath('m1', 'conv-a')).equals(patternBytes(30_000, 5))).toBe(true)
    expect(readFileSync(mirror.lakePath('m2', 'conv-b')).equals(patternBytes(30_000, 6))).toBe(true)
    expect(store.mirrorCursor('m1', 'conv-a')).toBe(30_000)
    expect(store.mirrorCursor('m2', 'conv-b')).toBe(30_000)
    store.close()
  })

  it('dedups a rapid double-enqueue of the same segment (one pull only)', async () => {
    const { store, fs, mirror } = setup()
    fs.delayMs = 10
    const path = seed(store, 'm1', 'dup')
    fs.set(path, 'single small file\n')

    mirror.enqueue('m1', 'dup', path)
    mirror.enqueue('m1', 'dup', path) // in flight → no-op
    await settle(mirror, 'm1')

    expect(fs.log.length).toBe(1)
    expect(readFileSync(mirror.lakePath('m1', 'dup')).toString()).toBe('single small file\n')
    expect(store.mirrorCursor('m1', 'dup')).toBe('single small file\n'.length)
    store.close()
  })

  it('recovers from a wiped lake: cursor falls back to disk truth, full re-pull', async () => {
    const { store, fs, mirror, lakeDir } = setup()
    const path = seed(store, 'm1', 'wiped')
    fs.set(path, Buffer.from('line-1\nline-2\n'))
    mirror.enqueue('m1', 'wiped', path)
    await settle(mirror, 'm1')
    // Ops event: the lake dir is wiped while the DB keeps its cursors. Without the
    // guard, truncate(cursor) would EXTEND the empty file with NUL bytes and the
    // eof-check would mark garbage as fully mirrored.
    rmSync(join(lakeDir, 'm1'), { recursive: true, force: true })
    mirror.enqueue('m1', 'wiped', path)
    await settle(mirror, 'm1')
    expect(readFileSync(mirror.lakePath('m1', 'wiped'))).toEqual(Buffer.from('line-1\nline-2\n'))
    expect(store.mirrorCursor('m1', 'wiped')).toBe('line-1\nline-2\n'.length)
  })

  it('resumes after restart with a single eof-check read and no lake change', async () => {
    const { store, lakeDir, fs, mirror } = setup()
    const path = seed(store, 'm1', 'resume')
    const content = patternBytes(9_000, 7)
    fs.set(path, content)
    mirror.enqueue('m1', 'resume', path)
    await settle(mirror, 'm1')
    expect(store.mirrorCursor('m1', 'resume')).toBe(content.length)

    // "Restart": a fresh MirrorService over the SAME store + lake dir. The source
    // is unchanged, so the sweep must cost exactly one read at the cursor (which
    // reports eof) and must not rewrite the lake file.
    const mirror2 = new MirrorService(store, lakeDir, fs.read)
    fs.log.length = 0
    mirror2.enqueueMachine('m1')
    await settle(mirror2, 'm1')

    expect(fs.log).toEqual([{ path, offset: content.length, maxBytes: MirrorService.CHUNK_BYTES }])
    expect(readFileSync(mirror2.lakePath('m1', 'resume')).equals(content)).toBe(true)
    expect(store.mirrorCursor('m1', 'resume')).toBe(content.length)
    store.close()
  })

  // ---- Pacing (incident amendment, spec §2.3): the 2026-07 deploy pumped an
  // entire multi-GB lake back-to-back on daemon attach, pegged the server CPU
  // and got SIGABRT'd by the systemd watchdog. These tests pin the two knobs.

  it('stops a drain pass at the byte budget and resumes from cursors to completion', async () => {
    const budget = 200_000
    const { store, fs, mirror } = setup({ passBudgetBytes: budget })
    const size = 300_000
    const segs = ['pace-a', 'pace-b', 'pace-c']
    for (const [i, nativeId] of segs.entries()) {
      fs.set(seed(store, 'm1', nativeId), patternBytes(size, 10 + i))
    }
    const total = () => segs.reduce((sum, id) => sum + store.mirrorCursor('m1', id), 0)

    mirror.enqueueMachine('m1')
    await settle(mirror, 'm1')

    // Pass 1 stopped at the budget (may overshoot by at most one chunk) and left
    // at least one segment completely untouched — its queued-state was cleared,
    // NOT stranded, so the next trigger can pick it up.
    const afterPass1 = total()
    expect(afterPass1).toBeGreaterThan(0)
    expect(afterPass1).toBeLessThanOrEqual(budget + MirrorService.CHUNK_BYTES)
    expect(afterPass1).toBeLessThan(segs.length * size)
    expect(segs.some((id) => store.mirrorCursor('m1', id) === 0)).toBe(true)

    // Re-triggering (the ~15s scan / attach sweep) resumes from the persisted
    // cursors — no head re-pull — and completes the whole lake within a few passes.
    let passes = 1
    while (total() < segs.length * size) {
      passes++
      expect(passes).toBeLessThanOrEqual(10)
      mirror.enqueueMachine('m1')
      await settle(mirror, 'm1')
    }
    for (const [i, nativeId] of segs.entries()) {
      expect(readFileSync(mirror.lakePath('m1', nativeId)).equals(patternBytes(size, 10 + i))).toBe(
        true,
      )
      expect(store.mirrorCursor('m1', nativeId)).toBe(size)
    }
    // Offsets never regress, and below eof never repeat: resume, not restart.
    // (Repeats AT size are the eof-checks later sweeps pay for a done segment.)
    for (const nativeId of segs) {
      const offsets = fs.log.filter((r) => r.path.includes(nativeId)).map((r) => r.offset)
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
      const belowEof = offsets.filter((o) => o < size)
      expect(new Set(belowEof).size).toBe(belowEof.length)
    }
    expect(passes).toBeGreaterThan(1) // the budget actually split the work
    store.close()
  })

  it('honors the injected inter-chunk delay between ranged reads', async () => {
    const delay = 30
    const { store, fs, mirror } = setup({ chunkDelayMs: delay })
    const path = seed(store, 'm1', 'breathe')
    fs.set(path, patternBytes(MirrorService.CHUNK_BYTES * 2 + 100, 20)) // 3 chunks

    mirror.enqueueMachine('m1')
    await settle(mirror, 'm1')

    expect(store.mirrorCursor('m1', 'breathe')).toBe(MirrorService.CHUNK_BYTES * 2 + 100)
    expect(fs.readTimes.length).toBe(3)
    for (let i = 1; i < fs.readTimes.length; i++) {
      const gap = (fs.readTimes[i] as number) - (fs.readTimes[i - 1] as number)
      expect(gap).toBeGreaterThanOrEqual(delay - 5) // timer slack, but clearly paced
    }
    store.close()
  })

  it('keeps event-loop lag bounded while draining many sizeable segments (incident regression)', async () => {
    // Incident shape: many segments x sizeable buffers, each chunk costing real
    // synchronous CPU on the loop (wire decode). With pacing the drain must leave
    // the loop responsive; the same setup with delay 0 / unlimited budget is
    // ALLOWED to be worse — we only pin the good case.
    const { store, fs, mirror } = setup({
      chunkDelayMs: 5,
      passBudgetBytes: Number.MAX_SAFE_INTEGER,
    })
    fs.busyMs = 2
    const size = 2 * MirrorService.CHUNK_BYTES // 2 chunks per segment
    const segs = Array.from({ length: 24 }, (_, i) => `lag-${String(i).padStart(2, '0')}`)
    for (const [i, nativeId] of segs.entries()) {
      fs.set(seed(store, 'm1', nativeId), patternBytes(size, 30 + i))
    }

    const sampleMs = 10
    let maxLag = 0
    let lastTick = performance.now()
    const sampler = setInterval(() => {
      const now = performance.now()
      maxLag = Math.max(maxLag, now - lastTick - sampleMs)
      lastTick = now
    }, sampleMs)
    try {
      mirror.enqueueMachine('m1')
      await settle(mirror, 'm1')
    } finally {
      clearInterval(sampler)
    }

    for (const nativeId of segs) {
      expect(store.mirrorCursor('m1', nativeId)).toBe(size)
    }
    expect(maxLag).toBeLessThan(250)
    store.close()
  })

  // Dirty-driven enqueueing (spec §2.3 "Dirty-driven"): scan/attach triggers call
  // enqueueDirty, which pulls ONLY segments whose daemon-reported size disagrees
  // with the mirrored cursor (NULL-reported rows count as dirty once). The
  // headline regression: a fully-mirrored fleet must issue ZERO mirror reads.
  describe('enqueueDirty', () => {
    function seedSized(
      store: SessionStore,
      machineId: string,
      nativeId: string,
      sizeBytes?: number,
    ): string {
      const path = `/home/u/.claude/projects/-proj/${nativeId}.jsonl`
      store.ensureConversationIdentity({
        machineId,
        nativeId,
        providerId: 'claude-code-jsonl',
        path,
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      })
      return path
    }

    it('pulls exactly the behind + never-reported segments, then a re-trigger issues ZERO reads', async () => {
      const { store, fs, mirror } = setup()
      const caughtUp = Buffer.from('{"line":"old"}\n')
      const behind = Buffer.from('{"line":"one"}\n{"line":"two"}\n')
      const preUpgrade = Buffer.from('{"line":"legacy"}\n')

      // Caught up: reported == mirrored (mirror it fully first, which records the
      // observed size at eof), so it must NOT be touched by the dirty trigger.
      const caughtUpPath = seedSized(store, 'm1', 'caught-up', caughtUp.length)
      fs.set(caughtUpPath, caughtUp)
      mirror.enqueue('m1', 'caught-up', caughtUpPath)
      await settle(mirror, 'm1')
      expect(store.mirrorCursor('m1', 'caught-up')).toBe(caughtUp.length)

      // Behind: a scan reported a size ahead of the (zero) mirror cursor.
      const behindPath = seedSized(store, 'm1', 'behind', behind.length)
      fs.set(behindPath, behind)
      // NULL-reported: a pre-upgrade row — no scan ever carried a size for it.
      const preUpgradePath = seedSized(store, 'm1', 'pre-upgrade')
      fs.set(preUpgradePath, preUpgrade)

      const logBefore = fs.log.length
      mirror.enqueueDirty('m1')
      await settle(mirror, 'm1')

      // Exactly the two dirty segments were read — never the caught-up one.
      const pulled = new Set(fs.log.slice(logBefore).map((r) => r.path))
      expect(pulled).toEqual(new Set([behindPath, preUpgradePath]))
      expect(readFileSync(mirror.lakePath('m1', 'behind')).equals(behind)).toBe(true)
      expect(readFileSync(mirror.lakePath('m1', 'pre-upgrade')).equals(preUpgrade)).toBe(true)
      // Convergence: eof recorded the observed size, so BOTH now read as clean —
      // including the pre-upgrade row (dirty exactly ONCE, per the upgrade path).
      expect(store.reportedBytes('m1', 'behind')).toBe(behind.length)
      expect(store.reportedBytes('m1', 'pre-upgrade')).toBe(preUpgrade.length)
      expect(store.segmentsToMirrorDirty('m1')).toEqual([])

      // THE regression: a re-trigger on a caught-up machine enqueues nothing and
      // issues zero daemon round trips (the old full sweep paid one eof-check
      // read per segment, ~1,150 per attach in production).
      const logAfterConvergence = fs.log.length
      mirror.enqueueDirty('m1')
      await settle(mirror, 'm1')
      expect(fs.log.length).toBe(logAfterConvergence)
      store.close()
    })

    it('attach before any scan reconciles from PERSISTED reported sizes', async () => {
      // Simulates: sizes were reported in an earlier server life, the daemon
      // (re)attaches, and no fresh scan has run yet — the dirty query must work
      // off the reported_bytes already in the store.
      const { store, fs, mirror } = setup()
      const grown = Buffer.from('{"line":1}\n{"line":2}\n{"line":3}\n')
      const path = seedSized(store, 'm1', 'offline-growth', grown.length) // persisted last-known size
      fs.set(path, grown)

      mirror.enqueueDirty('m1') // the attach trigger — nothing scanned this life
      await settle(mirror, 'm1')

      expect(readFileSync(mirror.lakePath('m1', 'offline-growth')).equals(grown)).toBe(true)
      expect(store.segmentsToMirrorDirty('m1')).toEqual([])
      store.close()
    })
  })
})
