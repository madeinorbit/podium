import {
  type BlobBody,
  type BlobKey,
  type BlobPutOptions,
  type BlobRange,
  type BlobStore,
  blobKey,
} from '@podium/blob-store'
import { asMachineId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { LAKE_PART_BYTES, type LakeSegment, LakeWriteConflict, PartedLake } from './lake-parted'
import {
  FakeDaemonFs,
  FakeMirrorStore,
  LAKE_ADAPTERS,
  type LakeBackend,
  patternBytes,
} from './lake-testing'
import { MirrorService } from './mirror'

// The parted transcript lake (POD-6963 design 2.3) on both test backends: the
// local-disk adapter and the in-memory adapter with object-store semantics.

const M1 = asMachineId('m1')
/** A small part size so boundaries are cheap to cross; the mirror tests use the real P. */
const P = 64

/** Records every put's options and counts gets, around a real adapter. */
class RecordingStore implements BlobStore {
  readonly puts: { key: string; size: number; opts: BlobPutOptions }[] = []
  gets = 0
  constructor(private readonly inner: BlobStore) {}
  get conditionalWrites(): boolean {
    return this.inner.conditionalWrites
  }
  async put(key: BlobKey, body: BlobBody, opts: BlobPutOptions = {}) {
    const head = await this.inner.put(key, body, opts)
    this.puts.push({ key, size: head.size, opts })
    return head
  }
  async get(key: BlobKey, range?: BlobRange) {
    this.gets += 1
    return await this.inner.get(key, range)
  }
  head(key: BlobKey) {
    return this.inner.head(key)
  }
  delete(key: BlobKey, opts?: { durable?: boolean }) {
    return this.inner.delete(key, opts)
  }
  list(prefix: BlobKey) {
    return this.inner.list(prefix)
  }
  copy(from: BlobKey, to: BlobKey) {
    return this.inner.copy(from, to)
  }
}

const seg = (nativeId: string, incarnation = 1): LakeSegment => ({
  machineId: M1,
  nativeId,
  incarnation,
})

async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks)
    chunks.push(value)
  }
}

/** A cursor past every test segment (1 GiB): reads stop at the stored size. */
const UNBOUNDED = 2 ** 30

/** Every stored byte of an incarnation, unbounded by any cursor. */
async function stored(lake: PartedLake, segment: LakeSegment): Promise<Buffer> {
  const source = lake.source(segment, () => UNBOUNDED)
  return Buffer.from(await source.read(0, await source.size()))
}

/** Byte equality without a deep diff: `toEqual` on megabyte buffers is slow and a
 *  failing one renders a diff large enough to exhaust the worker. */
function expectBytes(actual: Buffer, expected: Buffer): void {
  expect(actual.length).toBe(expected.length)
  expect(actual.equals(expected)).toBe(true)
}

async function settle(mirror: MirrorService): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await mirror.settled(M1)
    await new Promise((r) => setTimeout(r, 5))
  }
  await mirror.settled(M1)
}

for (const adapter of LAKE_ADAPTERS) {
  describe(`PartedLake on the ${adapter.name} adapter`, () => {
    const backends: LakeBackend[] = []
    const backend = (): LakeBackend => {
      const created = adapter.create()
      backends.push(created)
      return created
    }
    afterEach(() => {
      for (const created of backends.splice(0)) created.dispose()
    })

    it('keys parts by machine, native id, incarnation and padded part number', () => {
      const { blobs, workspaceId } = backend()
      const lake = new PartedLake(blobs, workspaceId)
      expect(lake.partKey(seg('native-a'), 3)).toBe('transcripts/m1/native-a/00000001/00000003')
      // A native id outside the key alphabet is encoded, never joined raw.
      expect(lake.partKey(seg('a/b'), 0)).toMatch(
        /^transcripts\/m1\/~[a-z2-7]+\/00000001\/00000000$/,
      )
      expect(lake.sourceId(seg('native-a', 2))).toBe(
        `${workspaceId}/transcripts/m1/native-a/00000002`,
      )
      expect(new PartedLake(blobs, workspaceId).partBytes).toBe(LAKE_PART_BYTES)
    })

    it('splits writes at part boundaries and reads them back across parts', async () => {
      const { blobs, workspaceId } = backend()
      const recording = new RecordingStore(blobs)
      const lake = new PartedLake(recording, workspaceId, { partBytes: P })
      const content = patternBytes(5 * P + 17, 1)
      let writer = await lake.openWriter(seg('bounds'), 0)
      // Uneven chunks: inside a part, exactly to a boundary, and across two.
      for (const [from, to] of [
        [0, 10],
        [10, P],
        [P, 3 * P + 5],
        [3 * P + 5, 5 * P + 17],
      ] as const) {
        await writer.append(content.subarray(from, to))
        expect(writer.position).toBe(to)
      }
      // Full parts hold exactly P bytes; the open last part holds the rest.
      for (let part = 0; part < 5; part++) {
        expect((await blobs.head(lake.partKey(seg('bounds'), part)))?.size).toBe(P)
      }
      expect((await blobs.head(lake.partKey(seg('bounds'), 5)))?.size).toBe(17)
      expect(await blobs.head(lake.partKey(seg('bounds'), 6))).toBeUndefined()
      // Size is openPart · P + head(openPart).size, bounded by the cursor.
      expect((await lake.extent(seg('bounds'), content.length)).storedSize).toBe(content.length)
      expect(await lake.readableSize(seg('bounds'), 100)).toBe(100)
      expectBytes(await stored(lake, seg('bounds')), content)

      // A read touches one ranged get per part it spans.
      const source = lake.source(seg('bounds'), () => content.length)
      recording.gets = 0
      expect(Buffer.from(await source.read(P - 4, 8))).toEqual(content.subarray(P - 4, P + 4))
      expect(recording.gets).toBe(2)
      // Never past min(cursor, stored size).
      expect(Buffer.from(await lake.source(seg('bounds'), () => 70).read(60, 50))).toEqual(
        content.subarray(60, 70),
      )

      // A reopened writer appends at the cursor, rewriting only the open part.
      writer = await lake.openWriter(seg('bounds'), content.length)
      recording.puts.length = 0
      await writer.append(Buffer.from('tail'))
      expect(recording.puts.map((put) => put.key)).toEqual([lake.partKey(seg('bounds'), 5)])
    })

    it('makes a put durable only when it completes a part or replaces bytes past its offset', async () => {
      const { blobs, workspaceId } = backend()
      const recording = new RecordingStore(blobs)
      const lake = new PartedLake(recording, workspaceId, { partBytes: P })
      const writer = await lake.openWriter(seg('durable'), 0)
      await writer.append(patternBytes(10, 2)) // extends part 0
      await writer.append(patternBytes(P, 3)) // completes part 0, starts part 1
      expect(recording.puts.map((put) => [put.key.slice(-1), put.opts.durable])).toEqual([
        ['0', false],
        ['0', true],
        ['1', false],
      ])
      // Conditional on what the writer saw: absent first, then the etag it wrote.
      expect(recording.puts[0]?.opts.ifAbsent).toBe(true)
      expect(recording.puts[1]?.opts.ifMatch).toEqual(expect.any(String))
      expect(recording.puts[2]?.opts.ifAbsent).toBe(true)

      // Bytes past the cursor (a crash between lake write and cursor advance)
      // are replaced durably: the part must never come back with them.
      recording.puts.length = 0
      const replay = await lake.openWriter(seg('durable'), P + 2)
      await replay.append(Buffer.from('x'))
      expect(recording.puts).toEqual([
        expect.objectContaining({ size: 3, opts: expect.objectContaining({ durable: true }) }),
      ])
    })

    it('shrink deletes every part, past the cursor too, and a half-done delete reads as empty', async () => {
      const { blobs, workspaceId } = backend()
      const lake = new PartedLake(blobs, workspaceId, { partBytes: P })
      const writer = await lake.openWriter(seg('shrink'), 0)
      await writer.append(patternBytes(4 * P + 1, 4))
      // A crashed writer's part beyond the cursor's parts.
      await blobs.put(lake.partKey(seg('shrink'), 5), patternBytes(3, 5))
      await lake.clear(seg('shrink'), 4 * P + 1)
      const left = []
      for await (const entry of blobs.list(blobKey(lake.incarnationKey(seg('shrink'))))) {
        left.push(entry.key)
      }
      expect(left).toEqual([])
      expect((await lake.extent(seg('shrink'), 4 * P + 1)).storedSize).toBe(0)

      // Crash after deleting part 0 only (lowest first): the higher parts must
      // not count, or the mirror would append new bytes after a hole.
      const again = await lake.openWriter(seg('half'), 0)
      await again.append(patternBytes(3 * P, 6))
      await blobs.delete(lake.partKey(seg('half'), 0))
      expect((await lake.extent(seg('half'), 3 * P)).storedSize).toBe(0)
    })

    it('a wiped lake reads as empty, a lost open part as the full parts below it', async () => {
      const { blobs, workspaceId, wipe } = backend()
      const lake = new PartedLake(blobs, workspaceId, { partBytes: P })
      const writer = await lake.openWriter(seg('lost'), 0)
      await writer.append(patternBytes(2 * P + 9, 7))
      await blobs.delete(lake.partKey(seg('lost'), 2))
      expect((await lake.extent(seg('lost'), 2 * P + 9)).storedSize).toBe(2 * P)
      await wipe('m1')
      expect((await lake.extent(seg('lost'), 2 * P + 9)).storedSize).toBe(0)
    })

    it('refuses a stale writer by ifMatch and keeps the winner’s bytes', async () => {
      const { blobs, workspaceId } = backend()
      const lake = new PartedLake(blobs, workspaceId, { partBytes: P })
      const first = await lake.openWriter(seg('race'), 0)
      await first.append(Buffer.from('shared prefix\n'))
      // Two writers open at the same cursor (a daemon connection moving in a fleet).
      const a = await lake.openWriter(seg('race'), 14)
      const b = await lake.openWriter(seg('race'), 14)
      await a.append(Buffer.from('from a\n'))
      await expect(b.append(Buffer.from('from b\n'))).rejects.toBeInstanceOf(LakeWriteConflict)
      expect((await stored(lake, seg('race'))).toString()).toBe('shared prefix\nfrom a\n')

      // A new part is created with ifAbsent: a second creator loses too.
      const c = await lake.openWriter(seg('fresh'), 0)
      const d = await lake.openWriter(seg('fresh'), 0)
      await c.append(Buffer.from('c'))
      await expect(d.append(Buffer.from('d'))).rejects.toBeInstanceOf(LakeWriteConflict)
    })

    it('a source changes version with the cursor and the open part', async () => {
      const { blobs, workspaceId } = backend()
      const lake = new PartedLake(blobs, workspaceId, { partBytes: P })
      let cursor = 0
      const source = lake.source(seg('version'), () => cursor)
      const empty = await source.version()
      const writer = await lake.openWriter(seg('version'), 0)
      await writer.append(Buffer.from('abc'))
      cursor = 3
      const one = await source.version()
      expect(one).not.toBe(empty)
      expect(await source.version()).toBe(one)
      await writer.append(Buffer.from('def'))
      cursor = 6
      expect(await source.version()).not.toBe(one)
      expect(await source.size()).toBe(6)
    })

    describe('through the mirror (real P)', () => {
      function mirrorSetup(lake?: PartedLake) {
        const { blobs, workspaceId } = backend()
        const store = new FakeMirrorStore()
        const fs = new FakeDaemonFs()
        const parted = lake ?? new PartedLake(blobs, workspaceId)
        const mirror = new MirrorService(store, parted, fs.read, Date.now, {
          chunkDelayMs: 0,
          passBudgetBytes: Number.MAX_SAFE_INTEGER,
        })
        return { blobs, store, fs, lake: parted, mirror }
      }
      const PATH = '/transcripts/seg.jsonl'

      it('crosses part boundaries with 256 KB chunks into 1 MiB parts', async () => {
        const { store, fs, lake, mirror } = mirrorSetup()
        const content = patternBytes(2 * LAKE_PART_BYTES + 300_000, 8)
        store.seed(M1, 'big', PATH)
        fs.set(PATH, content)
        await mirror.enqueue(M1, 'big', PATH)
        await settle(mirror)
        expect(store.mirrorCursor(M1, 'big')).toBe(content.length)
        expectBytes(await stored(lake, seg('big')), content)
      })

      it('rotation keeps the predecessor under its own sequence and starts the next', async () => {
        const { store, fs, lake, mirror } = mirrorSetup()
        store.seed(M1, 'rot', PATH)
        const predecessor = patternBytes(LAKE_PART_BYTES + 5, 9)
        fs.set(PATH, predecessor)
        await mirror.enqueue(M1, 'rot', PATH)
        await settle(mirror)
        const replacement = Buffer.from('a new file under the same native id\n')
        fs.replace(PATH, replacement)
        await mirror.enqueue(M1, 'rot', PATH)
        await settle(mirror)
        expectBytes(await stored(lake, seg('rot', 1)), predecessor)
        expectBytes(await stored(lake, seg('rot', 2)), replacement)
        expect(store.incarnationRows(M1, 'rot')).toEqual([
          expect.objectContaining({
            sequence: 1,
            mirroredBytes: predecessor.length,
            active: false,
          }),
          expect.objectContaining({ sequence: 2, active: true }),
        ])
        expect(store.mirrorCursor(M1, 'rot')).toBe(replacement.length)
      })

      it('repairs a lost open-part rewrite through the shorter-than-cursor guard', async () => {
        const { blobs, store, fs, lake, mirror } = mirrorSetup()
        store.seed(M1, 'crash', PATH)
        const content = patternBytes(LAKE_PART_BYTES + 400_000, 10)
        fs.set(PATH, content)
        await mirror.enqueue(M1, 'crash', PATH)
        await settle(mirror)
        // A crash lost the open part's last non-durable rewrite: it comes back
        // as an earlier, shorter version of itself while the cursor stayed.
        const openKey = lake.partKey(seg('crash'), 1)
        const got = await blobs.get(openKey, { offset: 0, length: 100_000 })
        await blobs.put(openKey, await bytesOf(got?.body as ReadableStream<Uint8Array>))
        const grown = Buffer.concat([content, Buffer.from('later turn\n')])
        fs.set(PATH, grown)
        fs.log.length = 0
        await mirror.enqueue(M1, 'crash', PATH)
        await settle(mirror)
        // The guard moved the cursor back to what is stored and re-pulled from there.
        expect(fs.log[0]?.offset).toBe(LAKE_PART_BYTES + 100_000)
        expect(store.mirrorCursor(M1, 'crash')).toBe(grown.length)
        expectBytes(await stored(lake, seg('crash')), grown)
      })

      it('a lost cursor compare-and-set re-reads the cursor and restarts the segment', async () => {
        const { store, fs, lake, mirror } = mirrorSetup()
        store.seed(M1, 'cas', PATH)
        const content = patternBytes(MirrorService.CHUNK_BYTES * 2 + 10, 11)
        fs.set(PATH, content)
        // Another process wins the first advance: it mirrored the same first
        // chunk (byte-identical lake bytes) and moved the cursor itself.
        const advance = store.setMirrorCursor.bind(store)
        let lost = 0
        store.setMirrorCursor = (machineId, nativeId, expected, bytes, at) => {
          if (lost === 0 && expected === 0 && bytes > 0) {
            lost += 1
            store.forceMirrorCursor(machineId, nativeId, bytes)
            return false
          }
          return advance(machineId, nativeId, expected, bytes, at)
        }
        await mirror.enqueue(M1, 'cas', PATH)
        await settle(mirror)
        expect(lost).toBe(1)
        // The restart read from the winner's cursor, not from 0 again.
        expect(fs.log.map((read) => read.offset)).toEqual([
          0,
          MirrorService.CHUNK_BYTES,
          MirrorService.CHUNK_BYTES * 2,
        ])
        expect(store.mirrorCursor(M1, 'cas')).toBe(content.length)
        expectBytes(await stored(lake, seg('cas')), content)
      })

      it('two writers that observe the same new file identity rotate once', async () => {
        const first = mirrorSetup()
        const { store, fs } = first
        const second = new MirrorService(store, first.lake, fs.read, Date.now, {
          chunkDelayMs: 0,
          passBudgetBytes: Number.MAX_SAFE_INTEGER,
        })
        store.seed(M1, 'twice', PATH)
        fs.set(PATH, Buffer.from('the first file\n'))
        await first.mirror.enqueue(M1, 'twice', PATH)
        await settle(first.mirror)
        const replacement = Buffer.from('the replacement file\n')
        fs.replace(PATH, replacement)
        fs.delayMs = 2
        await Promise.all([
          first.mirror.enqueue(M1, 'twice', PATH),
          second.enqueue(M1, 'twice', PATH),
        ])
        await settle(first.mirror)
        await settle(second)
        expect(store.incarnationRows(M1, 'twice').map((row) => [row.sequence, row.active])).toEqual(
          [
            [1, false],
            [2, true],
          ],
        )
        expect((await stored(first.lake, seg('twice', 1))).toString()).toBe('the first file\n')
        expectBytes(await stored(first.lake, seg('twice', 2)), replacement)
        expect(store.mirrorCursor(M1, 'twice')).toBe(replacement.length)
      })

      it('two mirrors over one store and one lake converge to the verbatim source', async () => {
        const first = mirrorSetup()
        const store = first.store
        const fs = first.fs
        const second = new MirrorService(store, first.lake, fs.read, Date.now, {
          chunkDelayMs: 0,
          passBudgetBytes: Number.MAX_SAFE_INTEGER,
        })
        store.seed(M1, 'fleet', PATH)
        const content = patternBytes(LAKE_PART_BYTES + MirrorService.CHUNK_BYTES * 3 + 77, 12)
        fs.set(PATH, content)
        fs.delayMs = 1
        await Promise.all([
          first.mirror.enqueue(M1, 'fleet', PATH),
          second.enqueue(M1, 'fleet', PATH),
        ])
        await settle(first.mirror)
        await settle(second)
        // Whatever interleaving lost, a sweep converges both to the source.
        await first.mirror.enqueue(M1, 'fleet', PATH)
        await settle(first.mirror)
        expect(store.mirrorCursor(M1, 'fleet')).toBe(content.length)
        expectBytes(await stored(first.lake, seg('fleet')), content)
      })
    })
  })
}
