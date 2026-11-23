import { addSink, type LogRecord } from '@podium/logger'
import { asMachineId, type MachineId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LakeWriter, PartedLake } from './lake-parted'
import {
  FakeDaemonFs,
  FakeMirrorStore,
  LAKE_ADAPTERS,
  type LakeAdapter,
  type LakeBackend,
  patternBytes,
} from './lake-testing'
import { MirrorService, type MirrorServiceOptions } from './mirror'

const M1 = asMachineId('m1')
const M2 = asMachineId('m2')

// MirrorService (docs/spec/transcript-mirror.md §2.3/§3) against a fake daemon:
// the read callback serves ranged reads from in-memory buffers and logs every
// request, so tests can assert both the LAKE outcome (byte-identical copies,
// cursor === size) and the REQUEST pattern (chunking, tail-only pulls, backoff,
// per-machine serialization). The lake is the parted lake on each test adapter
// (local disk and in-memory object-store semantics; POD-6963 design 2.3).

/** 0-delay + unlimited budget by default so the pre-pacing tests stay fast and
 *  byte-exact; pacing tests inject their own knobs. */
let adapter: LakeAdapter
const backends: LakeBackend[] = []

function setup(options?: MirrorServiceOptions) {
  const store = new FakeMirrorStore()
  const backend = adapter.create()
  backends.push(backend)
  const lake = new PartedLake(backend.blobs, backend.workspaceId)
  const fs = new FakeDaemonFs()
  const mirror = new MirrorService(store, lake, fs.read, Date.now, {
    chunkDelayMs: 0,
    passBudgetBytes: Number.MAX_SAFE_INTEGER,
    ...options,
  })
  return { store, lake, backend, fs, mirror }
}

/** A cursor past every test segment (1 GiB): reads stop at the stored size. */
const UNBOUNDED = 2 ** 30

/** Every stored byte of a segment incarnation, unbounded by the cursor. */
async function lakeBytes(
  mirror: MirrorService,
  machineId: MachineId,
  nativeId: string,
  incarnation = 1,
): Promise<Buffer> {
  const source = mirror.lake.source({ machineId, nativeId, incarnation }, () => UNBOUNDED)
  return Buffer.from(await source.read(0, await source.size()))
}

/** Whether the segment incarnation has any stored part. */
async function hasLake(mirror: MirrorService, machineId: MachineId, nativeId: string) {
  return (await lakeBytes(mirror, machineId, nativeId)).length > 0
}

function seed(
  store: FakeMirrorStore,
  machineId: string,
  nativeId: string,
  sizeBytes?: number,
): string {
  const path = `/home/u/.claude/projects/-proj/${nativeId}.jsonl`
  store.seed(machineId, nativeId, path, sizeBytes)
  return path
}

/** Await queue idleness. enqueue() kicks drain synchronously, but retry a few
 *  ticks anyway so back-to-back enqueues can't race the assertion. */
async function settle(mirror: MirrorService, machineId: MachineId): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await mirror.settled(machineId)
    await new Promise((r) => setTimeout(r, 5))
  }
  await mirror.settled(machineId)
}

for (const lakeAdapter of LAKE_ADAPTERS)
  describe(`MirrorService on the ${lakeAdapter.name} lake`, () => {
    adapter = lakeAdapter
    beforeEach(() => {
      adapter = lakeAdapter
    })
    afterEach(() => {
      for (const backend of backends.splice(0)) backend.dispose()
    })

    for (const launch of ['enqueue', 'resume', 'restart'] as const) {
      for (const stopped of [false, true]) {
        it(`${launch} drain rejection is ${stopped ? 'silent after stop' : 'reported while running'} without an unhandled rejection`, async () => {
          const { store, mirror } = setup()
          const path = seed(store, M1, 'drain-failure')
          const records: LogRecord[] = []
          const restore = addSink({ name: 'drain-failure-test', write: (r) => records.push(r) })
          const unhandled: unknown[] = []
          const onUnhandled = (error: unknown) => {
            unhandled.push(error)
          }
          process.on('unhandledRejection', onUnhandled)
          let releaseFailure!: () => void
          const failureBarrier = new Promise<void>((resolve) => {
            releaseFailure = resolve
          })
          let markFailureStarted!: () => void
          const failureStarted = new Promise<void>((resolve) => {
            markFailureStarted = resolve
          })
          let releaseFirst!: () => void
          const firstBarrier = new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          let markFirstStarted!: () => void
          const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve
          })
          // A denied read enters the inner catch. Its async cursor lookup then
          // rejects OUTSIDE that catch, so only the drain launch can observe it.
          const failure = new Error('denied-path cursor lookup failed')
          Object.defineProperty(store, 'mirrorCursor', {
            value: async () => {
              markFailureStarted()
              await failureBarrier
              throw failure
            },
          })
          let calls = 0
          const internals = mirror as unknown as {
            mirrorOne(
              machineId: MachineId,
              nativeId: string,
              path: string,
              pass: { remainingBytes: number },
            ): Promise<boolean>
          }
          internals.mirrorOne = async (_machineId, _nativeId, _path, pass) => {
            if (launch === 'restart' && calls++ === 0) {
              markFirstStarted()
              await firstBarrier
              pass.remainingBytes = 0
              return true
            }
            throw new Error('denied')
          }
          try {
            if (launch === 'resume') await mirror.pause()
            await mirror.enqueue(M1, 'drain-failure', path)
            if (launch === 'resume') await mirror.resume()
            if (launch === 'restart') {
              await firstStarted
              // Coalesce a fresh observation while the first pass is active.
              // Its exhausted budget causes the finally block to launch pass two.
              await mirror.enqueueDirty(M1)
              releaseFirst()
            }
            await failureStarted
            if (stopped) mirror.dispose()
            releaseFailure()
            await mirror.settled(M1)
            await new Promise<void>((resolve) => setImmediate(resolve))
            const warnings = records.filter((r) => r.ns === 'sync:mirror' && r.level === 'warn')
            if (stopped) {
              expect(warnings).toEqual([])
            } else {
              expect(warnings).toHaveLength(1)
              expect(warnings[0]).toMatchObject({
                msg: 'mirror drain failed',
                machineId: M1,
                err: { message: failure.message },
              })
            }
            expect(unhandled).toEqual([])
          } finally {
            mirror.dispose()
            releaseFirst()
            releaseFailure()
            await mirror.settled(M1)
            process.off('unhandledRejection', onUnhandled)
            restore()
          }
        })
      }
    }

    it('fences an in-flight read, preserves queued work, and resumes it after abort', async () => {
      const { store, fs, mirror } = setup()
      const pathA = seed(store, M1, 'pause-a')
      const pathB = seed(store, M1, 'pause-b')
      const pathC = seed(store, M1, 'pause-c')
      fs.set(pathA, 'first queued segment\n')
      fs.set(pathB, 'second queued segment\n')
      fs.set(pathC, 'dirtied while paused\n')

      let releaseRead!: () => void
      fs.readBarrier = new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      await mirror.enqueue(M1, 'pause-a', pathA)
      await mirror.enqueue(M1, 'pause-b', pathB)
      await vi.waitFor(() => expect(fs.log).toHaveLength(1))

      let pauseResolved = false
      const paused = mirror.pause().then(() => {
        pauseResolved = true
      })
      await mirror.enqueue(M1, 'pause-c', pathC)
      await mirror.enqueue(M1, 'pause-a', pathA) // still deduplicated while parked
      await Promise.resolve()

      expect(pauseResolved).toBe(false)
      expect(store.mirrorCursor(M1, 'pause-a')).toBe(0)
      releaseRead()
      await paused

      expect(fs.log).toHaveLength(1)
      expect(store.mirrorCursor(M1, 'pause-a')).toBe(0)
      expect(await hasLake(mirror, M1, 'pause-a')).toBe(false)
      expect(await hasLake(mirror, M1, 'pause-b')).toBe(false)
      expect(await hasLake(mirror, M1, 'pause-c')).toBe(false)

      await mirror.resume()
      await settle(mirror, M1)

      expect(fs.log.map((read) => read.path)).toEqual([pathA, pathA, pathB, pathC])
      expect((await lakeBytes(mirror, M1, 'pause-a')).toString()).toBe('first queued segment\n')
      expect((await lakeBytes(mirror, M1, 'pause-b')).toString()).toBe('second queued segment\n')
      expect((await lakeBytes(mirror, M1, 'pause-c')).toString()).toBe('dirtied while paused\n')
    })

    it('settles an already-started write and resumes from its persisted cursor', async () => {
      let requestPause = (): void => {}
      const { store, fs, mirror } = setup({
        onBytes: () => requestPause(),
      })
      let pausePromise: Promise<void> | undefined
      requestPause = () => {
        pausePromise ??= mirror.pause()
      }
      const content = patternBytes(MirrorService.CHUNK_BYTES + 100, 23)
      const path = seed(store, M1, 'pause-cursor')
      fs.set(path, content)

      await mirror.enqueue(M1, 'pause-cursor', path)
      await vi.waitFor(() => expect(pausePromise).toBeDefined())
      await pausePromise

      expect(fs.log.map((read) => read.offset)).toEqual([0])
      expect(store.mirrorCursor(M1, 'pause-cursor')).toBe(MirrorService.CHUNK_BYTES)
      expect(
        (await lakeBytes(mirror, M1, 'pause-cursor')).equals(
          content.subarray(0, MirrorService.CHUNK_BYTES),
        ),
      ).toBe(true)

      await mirror.resume()
      await settle(mirror, M1)

      expect(fs.log.map((read) => read.offset)).toEqual([0, MirrorService.CHUNK_BYTES])
      expect(store.mirrorCursor(M1, 'pause-cursor')).toBe(content.length)
      expect((await lakeBytes(mirror, M1, 'pause-cursor')).equals(content)).toBe(true)
    })

    it('drains a write before resolving pause without mutating the store after dispose', async () => {
      const { store, fs, mirror } = setup()
      const content = Buffer.from('write parked between the lake and cursor\n')
      const path = seed(store, M1, 'pause-dispose')
      fs.set(path, content)

      const internals = mirror as unknown as {
        writeChunk(writer: LakeWriter, bytes: Uint8Array): Promise<void>
      }
      const writeChunk = internals.writeChunk.bind(mirror)
      let markLakeWritten!: () => void
      const lakeWritten = new Promise<void>((resolve) => {
        markLakeWritten = resolve
      })
      let releaseWrite!: () => void
      const writeBarrier = new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      internals.writeChunk = async (...args) => {
        await writeChunk(...args)
        markLakeWritten()
        await writeBarrier
      }

      await mirror.enqueue(M1, 'pause-dispose', path)
      await lakeWritten
      expect((await lakeBytes(mirror, M1, 'pause-dispose')).equals(content)).toBe(true)
      expect(store.mirrorCursor(M1, 'pause-dispose')).toBe(0)

      let pauseResolved = false
      const paused = mirror.pause().then(() => {
        pauseResolved = true
      })
      mirror.dispose()
      await Promise.resolve()
      expect(pauseResolved).toBe(false)

      releaseWrite()
      await paused

      expect(store.mirrorCursor(M1, 'pause-dispose')).toBe(0)
      expect(store.reportedBytes(M1, 'pause-dispose')).toBeUndefined()
    })

    it('pulls a large file in bounded chunks to a byte-identical lake copy', async () => {
      const { store, fs, mirror } = setup()
      const content = patternBytes(MirrorService.CHUNK_BYTES + 1000)
      const path = seed(store, M1, 'big')
      fs.set(path, content)

      await mirror.enqueue(M1, 'big', path)
      await settle(mirror, M1)

      expect((await lakeBytes(mirror, M1, 'big')).equals(content)).toBe(true)
      expect(store.mirrorCursor(M1, 'big')).toBe(content.length)
      // Chunked: at least two ranged reads, offsets strictly advancing from 0.
      expect(fs.log.length).toBeGreaterThanOrEqual(2)
      expect(fs.log[0]).toEqual({ path, offset: 0, maxBytes: MirrorService.CHUNK_BYTES })
      expect(fs.log[1]?.offset).toBe(MirrorService.CHUNK_BYTES)
      const offsets = fs.log.map((r) => r.offset)
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
      expect(new Set(offsets).size).toBe(offsets.length) // strictly advancing, never repeated
    })

    it('pulls only the tail on incremental append', async () => {
      const { store, fs, mirror } = setup()
      const path = seed(store, M1, 'grow')
      const before = Buffer.from('{"line":1}\n{"line":2}\n')
      fs.set(path, before)
      await mirror.enqueue(M1, 'grow', path)
      await settle(mirror, M1)
      expect(store.mirrorCursor(M1, 'grow')).toBe(before.length)

      const grown = Buffer.concat([before, Buffer.from('{"line":3}\n')])
      fs.set(path, grown)
      const logBefore = fs.log.length
      await mirror.enqueue(M1, 'grow', path)
      await settle(mirror, M1)

      // The first new read starts exactly at the old size — no re-pull of the head.
      expect(fs.log[logBefore]?.offset).toBe(before.length)
      expect((await lakeBytes(mirror, M1, 'grow')).equals(grown)).toBe(true)
      expect(store.mirrorCursor(M1, 'grow')).toBe(grown.length)
    })

    it('truncates and re-pulls from zero when the source shrank (rewrite)', async () => {
      const { store, fs, mirror } = setup()
      const path = seed(store, M1, 'rewrite')
      const original = patternBytes(50_000, 1)
      fs.set(path, original)
      await mirror.enqueue(M1, 'rewrite', path)
      await settle(mirror, M1)
      expect(store.mirrorCursor(M1, 'rewrite')).toBe(original.length)

      // Native file rewritten SHORTER — verbatim mirror must drop the copy and
      // re-pull, never leave a stale tail (spec invariant 1).
      const rewritten = patternBytes(12_345, 2)
      fs.set(path, rewritten)
      await mirror.enqueue(M1, 'rewrite', path)
      await settle(mirror, M1)

      expect((await lakeBytes(mirror, M1, 'rewrite')).equals(rewritten)).toBe(true)
      expect(store.mirrorCursor(M1, 'rewrite')).toBe(rewritten.length)
    })

    it('archives the predecessor when the same native id points to a smaller new inode', async () => {
      const onTruncate = vi.fn()
      const onIncarnation = vi.fn()
      const { store, fs, mirror } = setup({ onTruncate, onIncarnation })
      const path = seed(store, M1, 'reused-id')
      const predecessor = Buffer.from('first incarnation keeps its complete history\n')
      fs.set(path, predecessor)
      await mirror.enqueue(M1, 'reused-id', path)
      await settle(mirror, M1)

      const replacement = Buffer.from('new turn\n')
      fs.replace(path, replacement)
      await mirror.enqueue(M1, 'reused-id', path)
      await settle(mirror, M1)

      expect((await lakeBytes(mirror, M1, 'reused-id', 1)).equals(predecessor)).toBe(true)
      expect((await lakeBytes(mirror, M1, 'reused-id', 2)).equals(replacement)).toBe(true)
      expect(store.incarnationRows(M1, 'reused-id')).toEqual([
        expect.objectContaining({ sequence: 1, mirroredBytes: predecessor.length, active: false }),
        expect.objectContaining({ sequence: 2, mirroredBytes: 0, active: true }),
      ])
      expect(onIncarnation).toHaveBeenCalledWith(M1, 'reused-id')
      expect(onTruncate).not.toHaveBeenCalled()
    })

    it('runs a trailing pass when a dirty sweep replaces an in-flight incarnation', async () => {
      let replaceDuringWrite = (): void => {}
      const { store, fs, mirror } = setup({
        onBytes: () => replaceDuringWrite(),
      })
      const path = seed(store, M1, 'reused-during-sweep')
      const predecessor = Buffer.from('predecessor transcript with enough history\n')
      const replacement = Buffer.from('next\n')
      fs.set(path, predecessor)
      replaceDuringWrite = () => {
        replaceDuringWrite = () => {}
        fs.replace(path, replacement)
        store.setReportedBytes(M1, 'reused-during-sweep', replacement.length)
        mirror.enqueueDirty(M1)
      }

      await mirror.enqueueDirty(M1)
      await settle(mirror, M1)

      expect(fs.log.map((read) => read.offset)).toEqual([0, predecessor.length, 0])
      expect((await lakeBytes(mirror, M1, 'reused-during-sweep', 1)).equals(predecessor)).toBe(true)
      expect((await lakeBytes(mirror, M1, 'reused-during-sweep', 2)).equals(replacement)).toBe(true)
      expect(store.mirrorCursor(M1, 'reused-during-sweep')).toBe(replacement.length)
    })

    it('a deleted source (denied) marks the segment converged — no eternal retries', async () => {
      const { store, fs, mirror } = setup()
      const path = seed(store, M1, 'gone')
      store.forceMirrorCursor(M1, 'gone', 500) // lake holds 500B already
      fs.errors.set(path, 'denied')
      await mirror.enqueue(M1, 'gone', path)
      await settle(mirror, M1)
      // reported == mirrored: the dirty query no longer selects it — scans go quiet.
      expect(
        (await store.segmentsToMirrorDirty(M1)).find((x) => x.nativeId === 'gone'),
      ).toBeUndefined()
    })

    it('backs off on a read error: cursor untouched, no lake parts, re-enqueue is a no-op', async () => {
      // A real sink, not a console spy: the diagnostic travels as a record now,
      // and no `minLevel` so this follows the namespace level exactly as the
      // production sinks do.
      const captured: { level: string }[] = []
      const restore = addSink({ name: 'mirror-test-capture', write: (r) => captured.push(r) })
      try {
        const { store, fs, mirror } = setup()
        const path = seed(store, M1, 'denied')
        fs.set(path, 'never served\n')
        fs.errors.set(path, 'timeout')

        await mirror.enqueue(M1, 'denied', path)
        await settle(mirror, M1)

        expect(store.mirrorCursor(M1, 'denied')).toBe(0)
        expect(await hasLake(mirror, M1, 'denied')).toBe(false)
        expect(fs.log.length).toBe(1)

        // Inside the backoff window the segment is not retried, even if the source
        // would now succeed — no new read requests at all.
        fs.errors.delete(path)
        await mirror.enqueue(M1, 'denied', path)
        await settle(mirror, M1)
        expect(fs.log.length).toBe(1)
        expect(store.mirrorCursor(M1, 'denied')).toBe(0)
        expect(captured.filter((r) => r.level === 'warn').length).toBeGreaterThan(0)
      } finally {
        restore()
      }
    })

    it('serializes reads per machine (max in-flight 1 across two segments)', async () => {
      const { store, fs, mirror } = setup()
      fs.delayMs = 10
      const pathA = seed(store, M1, 'seg-a')
      const pathB = seed(store, M1, 'seg-b')
      fs.set(pathA, patternBytes(70_000, 3))
      fs.set(pathB, patternBytes(70_000, 4))

      await mirror.enqueueMachine(M1)
      await settle(mirror, M1)

      expect(fs.maxInFlight).toBe(1)
      expect((await lakeBytes(mirror, M1, 'seg-a')).equals(patternBytes(70_000, 3))).toBe(true)
      expect((await lakeBytes(mirror, M1, 'seg-b')).equals(patternBytes(70_000, 4))).toBe(true)
    })

    it('lets two machines proceed independently, both completing', async () => {
      const { store, fs, mirror } = setup()
      fs.delayMs = 10
      const pathA = seed(store, M1, 'conv-a')
      const pathB = seed(store, M2, 'conv-b')
      fs.set(pathA, patternBytes(30_000, 5))
      fs.set(pathB, patternBytes(30_000, 6))

      await mirror.enqueueMachine(M1)
      await mirror.enqueueMachine(M2)
      await settle(mirror, M1)
      await settle(mirror, M2)

      expect((await lakeBytes(mirror, M1, 'conv-a')).equals(patternBytes(30_000, 5))).toBe(true)
      expect((await lakeBytes(mirror, M2, 'conv-b')).equals(patternBytes(30_000, 6))).toBe(true)
      expect(store.mirrorCursor(M1, 'conv-a')).toBe(30_000)
      expect(store.mirrorCursor(M2, 'conv-b')).toBe(30_000)
    })

    it('dedups a rapid double-enqueue of the same segment (one pull only)', async () => {
      const { store, fs, mirror } = setup()
      fs.delayMs = 10
      const path = seed(store, M1, 'dup')
      fs.set(path, 'single small file\n')

      await mirror.enqueue(M1, 'dup', path)
      await mirror.enqueue(M1, 'dup', path) // in flight → no-op
      await settle(mirror, M1)

      expect(fs.log.length).toBe(1)
      expect((await lakeBytes(mirror, M1, 'dup')).toString()).toBe('single small file\n')
      expect(store.mirrorCursor(M1, 'dup')).toBe('single small file\n'.length)
    })

    it('recovers from a wiped lake: cursor falls back to disk truth, full re-pull', async () => {
      const { store, fs, mirror, backend } = setup()
      const path = seed(store, M1, 'wiped')
      fs.set(path, Buffer.from('line-1\nline-2\n'))
      await mirror.enqueue(M1, 'wiped', path)
      await settle(mirror, M1)
      // Ops event: the lake's parts are wiped while the DB keeps its cursors. Without
      // the guard, the writer would append after a hole and the eof-check would mark
      // missing bytes as fully mirrored.
      await backend.wipe(M1)
      await mirror.enqueue(M1, 'wiped', path)
      await settle(mirror, M1)
      expect(await lakeBytes(mirror, M1, 'wiped')).toEqual(Buffer.from('line-1\nline-2\n'))
      expect(store.mirrorCursor(M1, 'wiped')).toBe('line-1\nline-2\n'.length)
    })

    it('resumes after restart with a single eof-check read and no lake change', async () => {
      const { store, lake, fs, mirror } = setup()
      const path = seed(store, M1, 'resume')
      const content = patternBytes(9_000, 7)
      fs.set(path, content)
      await mirror.enqueue(M1, 'resume', path)
      await settle(mirror, M1)
      expect(store.mirrorCursor(M1, 'resume')).toBe(content.length)

      // "Restart": a fresh MirrorService over the SAME store + lake. The source
      // is unchanged, so the sweep must cost exactly one read at the cursor (which
      // reports eof) and must not rewrite the lake.
      const mirror2 = new MirrorService(store, lake, fs.read)
      fs.log.length = 0
      await mirror2.enqueueMachine(M1)
      await settle(mirror2, M1)

      expect(fs.log).toEqual([
        { path, offset: content.length, maxBytes: MirrorService.CHUNK_BYTES },
      ])
      expect((await lakeBytes(mirror2, M1, 'resume')).equals(content)).toBe(true)
      expect(store.mirrorCursor(M1, 'resume')).toBe(content.length)
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
        fs.set(seed(store, M1, nativeId), patternBytes(size, 10 + i))
      }
      const total = () => segs.reduce((sum, id) => sum + store.mirrorCursor(M1, id), 0)

      await mirror.enqueueMachine(M1)
      await settle(mirror, M1)

      // Pass 1 stopped at the budget (may overshoot by at most one chunk) and left
      // at least one segment completely untouched — its queued-state was cleared,
      // NOT stranded, so the next trigger can pick it up.
      const afterPass1 = total()
      expect(afterPass1).toBeGreaterThan(0)
      expect(afterPass1).toBeLessThanOrEqual(budget + MirrorService.CHUNK_BYTES)
      expect(afterPass1).toBeLessThan(segs.length * size)
      expect(segs.some((id) => store.mirrorCursor(M1, id) === 0)).toBe(true)

      // Re-triggering (the ~15s scan / attach sweep) resumes from the persisted
      // cursors — no head re-pull — and completes the whole lake within a few passes.
      let passes = 1
      while (total() < segs.length * size) {
        passes++
        expect(passes).toBeLessThanOrEqual(10)
        await mirror.enqueueMachine(M1)
        await settle(mirror, M1)
      }
      for (const [i, nativeId] of segs.entries()) {
        expect((await lakeBytes(mirror, M1, nativeId)).equals(patternBytes(size, 10 + i))).toBe(
          true,
        )
        expect(store.mirrorCursor(M1, nativeId)).toBe(size)
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
    })

    it('honors the injected inter-chunk delay between ranged reads', async () => {
      const delay = 30
      const { store, fs, mirror } = setup({ chunkDelayMs: delay })
      const path = seed(store, M1, 'breathe')
      fs.set(path, patternBytes(MirrorService.CHUNK_BYTES * 2 + 100, 20)) // 3 chunks

      await mirror.enqueueMachine(M1)
      await settle(mirror, M1)

      expect(store.mirrorCursor(M1, 'breathe')).toBe(MirrorService.CHUNK_BYTES * 2 + 100)
      expect(fs.readTimes.length).toBe(3)
      for (let i = 1; i < fs.readTimes.length; i++) {
        const gap = (fs.readTimes[i] as number) - (fs.readTimes[i - 1] as number)
        expect(gap).toBeGreaterThanOrEqual(delay - 5) // timer slack, but clearly paced
      }
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
        fs.set(seed(store, M1, nativeId), patternBytes(size, 30 + i))
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
        await mirror.enqueueMachine(M1)
        await settle(mirror, M1)
      } finally {
        clearInterval(sampler)
      }

      for (const nativeId of segs) {
        expect(store.mirrorCursor(M1, nativeId)).toBe(size)
      }
      expect(maxLag).toBeLessThan(250)
    })

    // Dirty-driven enqueueing (spec §2.3 "Dirty-driven"): scan/attach triggers call
    // enqueueDirty, which pulls ONLY segments whose daemon-reported size disagrees
    // with the mirrored cursor (NULL-reported rows count as dirty once). The
    // headline regression: a fully-mirrored fleet must issue ZERO mirror reads.
    describe('enqueueDirty', () => {
      it('pulls exactly the behind + never-reported segments, then a re-trigger issues ZERO reads', async () => {
        const { store, fs, mirror } = setup()
        const caughtUp = Buffer.from('{"line":"old"}\n')
        const behind = Buffer.from('{"line":"one"}\n{"line":"two"}\n')
        const preUpgrade = Buffer.from('{"line":"legacy"}\n')

        // Caught up: reported == mirrored (mirror it fully first, which records the
        // observed size at eof), so it must NOT be touched by the dirty trigger.
        const caughtUpPath = seed(store, M1, 'caught-up', caughtUp.length)
        fs.set(caughtUpPath, caughtUp)
        await mirror.enqueue(M1, 'caught-up', caughtUpPath)
        await settle(mirror, M1)
        expect(store.mirrorCursor(M1, 'caught-up')).toBe(caughtUp.length)

        // Behind: a scan reported a size ahead of the (zero) mirror cursor.
        const behindPath = seed(store, M1, 'behind', behind.length)
        fs.set(behindPath, behind)
        // NULL-reported: a pre-upgrade row — no scan ever carried a size for it.
        const preUpgradePath = seed(store, M1, 'pre-upgrade')
        fs.set(preUpgradePath, preUpgrade)

        const logBefore = fs.log.length
        await mirror.enqueueDirty(M1)
        await settle(mirror, M1)

        // Exactly the two dirty segments were read — never the caught-up one.
        const pulled = new Set(fs.log.slice(logBefore).map((r) => r.path))
        expect(pulled).toEqual(new Set([behindPath, preUpgradePath]))
        expect((await lakeBytes(mirror, M1, 'behind')).equals(behind)).toBe(true)
        expect((await lakeBytes(mirror, M1, 'pre-upgrade')).equals(preUpgrade)).toBe(true)
        // Convergence: eof recorded the observed size, so BOTH now read as clean —
        // including the pre-upgrade row (dirty exactly ONCE, per the upgrade path).
        expect(store.reportedBytes(M1, 'behind')).toBe(behind.length)
        expect(store.reportedBytes(M1, 'pre-upgrade')).toBe(preUpgrade.length)
        expect(await store.segmentsToMirrorDirty(M1)).toEqual([])

        // THE regression: a re-trigger on a caught-up machine enqueues nothing and
        // issues zero daemon round trips (the old full sweep paid one eof-check
        // read per segment, ~1,150 per attach in production).
        const logAfterConvergence = fs.log.length
        await mirror.enqueueDirty(M1)
        await settle(mirror, M1)
        expect(fs.log.length).toBe(logAfterConvergence)
      })

      it('attach before any scan reconciles from PERSISTED reported sizes', async () => {
        // Simulates: sizes were reported in an earlier server life, the daemon
        // (re)attaches, and no fresh scan has run yet — the dirty query must work
        // off the reported_bytes already in the store.
        const { store, fs, mirror } = setup()
        const grown = Buffer.from('{"line":1}\n{"line":2}\n{"line":3}\n')
        const path = seed(store, M1, 'offline-growth', grown.length) // persisted last-known size
        fs.set(path, grown)

        await mirror.enqueueDirty(M1) // the attach trigger — nothing scanned this life
        await settle(mirror, M1)

        expect((await lakeBytes(mirror, M1, 'offline-growth')).equals(grown)).toBe(true)
        expect(await store.segmentsToMirrorDirty(M1)).toEqual([])
      })
    })
  })
