import {
  BlobConditionFailed,
  type BlobKey,
  type BlobStore,
  joinKey,
  keySegment,
  padNumber,
} from '@podium/blob-store'
import type { MachineId, WorkspaceId } from '@podium/model'

/**
 * The parted transcript lake (POD-6963 design 2.3; docs/spec/transcript-mirror.md 2.1).
 *
 * One mirrored segment incarnation is stored as fixed-size parts on a
 * {@link BlobStore}: part `n` holds bytes `[n·P, (n+1)·P)` under
 * `transcripts/<machine>/<native>/<incarnation>/<part>`. Only the open last
 * part is rewritten as the segment grows; a full part is never written with
 * other bytes. The part list needs no table: the cursor in the database says
 * how many bytes exist, so it says which parts exist.
 *
 * The same implementation runs on local disk and on an object store; the
 * adapter is the whole difference.
 *
 * - **Write** ({@link LakeWriter.append}) reads the open part's kept prefix,
 *   appends, and puts the part with `ifMatch` the etag it read (`ifAbsent` for
 *   a part that does not exist yet). A refused condition is a
 *   {@link LakeWriteConflict}: another writer changed the part, and the caller
 *   re-reads the cursor and starts over.
 * - **Durability.** A put is durable when it completes a part or when it
 *   replaces bytes past its own write offset. Every other put only extends the
 *   part's own prefix, so a crash that loses it brings the part back shorter,
 *   never longer with other bytes, and the mirror's guard repairs the cursor.
 * - **Size** is `openPart · P + size(openPart)`, where the open part is the one
 *   the cursor points into; readers are bounded by `min(cursor, stored size)`.
 * - **Shrink** ({@link PartedLake.clear}) deletes every part of the incarnation,
 *   lowest first and durably, before the caller resets the cursor.
 */

/** P: the part size. A constant chosen for write cost; F10 measures it (design 2.3). */
export const LAKE_PART_BYTES = 1024 * 1024

/** Part numbers are padded so lexicographic key order is numeric order. */
const PART_DIGITS = 8
/** Incarnation sequences follow the same rule as every number in a key. */
const INCARNATION_DIGITS = 8

/** One incarnation of one mirrored segment. */
export interface LakeSegment {
  readonly machineId: MachineId
  readonly nativeId: string
  /** The active incarnation row's `sequence`, or 1 for a segment with no row yet. */
  readonly incarnation: number
}

/**
 * The bytes of one lake incarnation for the transcript readers. Structurally
 * the `ByteSource` of `@podium/harness/store` (design 2.6), declared here so
 * this package does not depend on the harness.
 */
export interface LakeByteSource {
  /** `<workspaceId>/transcripts/<machine>/<native>/<incarnation>`: the
   *  process-wide slice caches key on it, so it names the workspace. */
  readonly id: string
  size(): Promise<number>
  read(offset: number, length: number): Promise<Uint8Array>
  /** The cursor and the open part's etag. */
  version(): Promise<string>
}

/** A conditional part write was refused: another writer changed the part first. */
export class LakeWriteConflict extends Error {
  override readonly name = 'LakeWriteConflict'
  constructor(readonly key: BlobKey) {
    super(`lake part changed under this writer: ${key}`)
  }
}

/** What a writer knows about one part: its etag and size, or that it is absent. */
interface PartState {
  readonly part: number
  readonly etag: string | undefined
  readonly size: number
  /** The part's bytes when this writer wrote them last, so the next append needs no read. */
  readonly bytes?: Uint8Array
}

/** The stored extent of an incarnation, read against a cursor. */
export interface LakeExtent {
  /** Bytes stored contiguously from 0, as far as the cursor's open part. */
  readonly storedSize: number
  /** The part holding the last stored byte (or part 0), as read. */
  readonly top: PartState
}

export class PartedLake {
  readonly partBytes: number

  constructor(
    private readonly blobs: BlobStore,
    private readonly workspaceId: WorkspaceId,
    options: { partBytes?: number } = {},
  ) {
    this.partBytes = options.partBytes ?? LAKE_PART_BYTES
    if (!Number.isSafeInteger(this.partBytes) || this.partBytes < 1) {
      throw new RangeError(`lake part size must be a positive integer, got ${this.partBytes}`)
    }
  }

  /** `transcripts/<machine>/<native>/<incarnation>` with ids encoded as key segments. */
  incarnationKey(segment: LakeSegment): BlobKey {
    return joinKey(
      'transcripts',
      keySegment(segment.machineId),
      keySegment(segment.nativeId),
      padNumber(segment.incarnation, INCARNATION_DIGITS),
    )
  }

  partKey(segment: LakeSegment, part: number): BlobKey {
    return joinKey(this.incarnationKey(segment), padNumber(part, PART_DIGITS))
  }

  /** The source id the slice caches key on; distinct per workspace. */
  sourceId(segment: LakeSegment): string {
    return `${this.workspaceId}/${this.incarnationKey(segment)}`
  }

  /**
   * How many bytes the incarnation holds, read against `cursor`: the formula of
   * design 2.3 (`openPart · P + size(openPart)`), with two repairs for a lake
   * that lost parts. When the open part is absent and so is the full part
   * below it, the extent is the contiguous run of parts from 0. When part 0 is
   * missing under a present higher part (a shrink delete that crashed midway,
   * lowest first), the incarnation holds nothing.
   */
  async extent(segment: LakeSegment, cursor: number): Promise<LakeExtent> {
    const P = this.partBytes
    const open = Math.floor(Math.max(0, cursor) / P)
    let top = await this.partState(segment, open)
    if (top.etag === undefined && open > 0) {
      const below = await this.partState(segment, open - 1)
      top =
        below.etag !== undefined && below.size === P
          ? below
          : await this.contiguousTop(segment, open - 1)
    }
    if (top.etag === undefined) return { storedSize: 0, top: absent(0) }
    if (top.part > 0 && (await this.blobs.head(this.partKey(segment, 0))) === undefined) {
      return { storedSize: 0, top: await this.partState(segment, 0) }
    }
    return { storedSize: top.part * P + top.size, top }
  }

  /** `min(cursor, stored size)`: what a reader or an archive may count on. */
  async readableSize(segment: LakeSegment, cursor: number): Promise<number> {
    return Math.min(cursor, (await this.extent(segment, cursor)).storedSize)
  }

  /**
   * A writer positioned at `min(cursor, stored size)`, conditioned on the parts
   * as they are now. The returned `storedSize` is what the mirror's
   * shorter-than-cursor guard compares with the cursor.
   */
  async openWriter(segment: LakeSegment, cursor: number): Promise<LakeWriter> {
    const { storedSize, top } = await this.extent(segment, cursor)
    const position = Math.min(cursor, storedSize)
    const known = top.part === Math.floor(position / this.partBytes) ? top : undefined
    return new LakeWriter(this, segment, position, storedSize, known)
  }

  /**
   * The shrink delete: remove every part of the incarnation, lowest first and
   * durably, so a crash midway leaves part 0 absent and {@link extent} reads
   * the incarnation as empty. Parts past the cursor's open part (a crashed or
   * stale writer's) are removed too, by probing upward until one is absent.
   */
  async clear(segment: LakeSegment, cursor: number): Promise<void> {
    const { storedSize } = await this.extent(segment, cursor)
    const last = Math.floor(Math.max(cursor, storedSize) / this.partBytes)
    for (let part = 0; part <= last; part += 1) {
      await this.blobs.delete(this.partKey(segment, part), { durable: true })
    }
    for (let part = last + 1; ; part += 1) {
      const key = this.partKey(segment, part)
      if ((await this.blobs.head(key)) === undefined) return
      await this.blobs.delete(key, { durable: true })
    }
  }

  /**
   * The incarnation as a byte source bounded by `min(cursor(), stored size)`.
   * `cursor` is read on every call: the active incarnation's is the segment's
   * live `mirrored_bytes`, an archived one's is its recorded byte count.
   */
  source(segment: LakeSegment, cursor: () => number | Promise<number>): LakeByteSource {
    return {
      id: this.sourceId(segment),
      size: async () => await this.readableSize(segment, await cursor()),
      read: async (offset, length) =>
        await this.read(segment, await this.readableSize(segment, await cursor()), offset, length),
      version: async () => {
        const at = await cursor()
        const open = await this.blobs.head(this.partKey(segment, Math.floor(at / this.partBytes)))
        return `${at}:${open?.etag ?? '-'}`
      },
    }
  }

  /** Bytes `[offset, offset + length)` clipped to `limit`, one ranged get per part touched. */
  private async read(
    segment: LakeSegment,
    limit: number,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const start = Math.max(0, offset)
    const end = Math.min(limit, start + Math.max(0, length))
    if (end <= start) return new Uint8Array(0)
    const out = new Uint8Array(end - start)
    let at = start
    while (at < end) {
      const part = Math.floor(at / this.partBytes)
      const within = at - part * this.partBytes
      const want = Math.min(this.partBytes - within, end - at)
      const got = await this.blobs.get(this.partKey(segment, part), {
        offset: within,
        length: want,
      })
      if (got === undefined) break
      const bytes = await collect(got.body)
      out.set(bytes, at - start)
      at += bytes.byteLength
      // A short part ends the contiguous bytes: the source is shorter only at its end.
      if (bytes.byteLength < want) break
    }
    return at === end ? out : out.subarray(0, at - start)
  }

  /** @internal The writer's view of one part, by a head. */
  async partState(segment: LakeSegment, part: number): Promise<PartState> {
    const head = await this.blobs.head(this.partKey(segment, part))
    return head === undefined ? absent(part) : { part, etag: head.etag, size: head.size }
  }

  /** @internal The part's first `length` bytes and the etag they were read at. */
  async readPrefix(
    segment: LakeSegment,
    part: number,
    length: number,
  ): Promise<{ bytes: Uint8Array; etag: string } | undefined> {
    const got = await this.blobs.get(this.partKey(segment, part), { offset: 0, length })
    if (got === undefined) return undefined
    return { bytes: await collect(got.body), etag: got.etag }
  }

  /** @internal Put one part, conditioned on what the writer last saw of it. */
  async putPart(
    segment: LakeSegment,
    part: number,
    body: Uint8Array,
    seen: PartState,
    durable: boolean,
  ): Promise<string> {
    const key = this.partKey(segment, part)
    const condition = !this.blobs.conditionalWrites
      ? {}
      : seen.etag === undefined
        ? { ifAbsent: true as const }
        : { ifMatch: seen.etag }
    try {
      return (await this.blobs.put(key, body, { ...condition, durable })).etag
    } catch (error) {
      if (error instanceof BlobConditionFailed) throw new LakeWriteConflict(key)
      throw error
    }
  }

  /** The highest part of the contiguous run from part 0 up to `limit` (absent when part 0 is). */
  private async contiguousTop(segment: LakeSegment, limit: number): Promise<PartState> {
    let top = absent(0)
    for (let part = 0; part <= limit; part += 1) {
      const state = await this.partState(segment, part)
      if (state.etag === undefined) return top
      top = state
      if (state.size < this.partBytes) return top
    }
    return top
  }
}

/**
 * Appends to one incarnation from a fixed position; built by
 * {@link PartedLake.openWriter}. It remembers the etag of the part it wrote
 * last, so every rewrite of the open part names the version this writer
 * produced or read, and a part changed by anyone else refuses the put.
 */
export class LakeWriter {
  private known: PartState | undefined

  constructor(
    private readonly lake: PartedLake,
    readonly segment: LakeSegment,
    private at: number,
    /** The extent read when the writer was opened. */
    readonly storedSize: number,
    known: PartState | undefined,
  ) {
    this.known = known
  }

  /** Where the next append lands: the cursor this writer has made durable in the lake. */
  get position(): number {
    return this.at
  }

  /**
   * Write `bytes` at {@link position}: complete the open part, start the next
   * as needed. Throws {@link LakeWriteConflict} when another writer changed a
   * part since this writer last saw it; parts already put stay put.
   */
  async append(bytes: Uint8Array): Promise<void> {
    const P = this.lake.partBytes
    let rest = bytes
    while (rest.byteLength > 0) {
      const part = Math.floor(this.at / P)
      const within = this.at - part * P
      const take = Math.min(P - within, rest.byteLength)
      const seen =
        this.known?.part === part ? this.known : await this.lake.partState(this.segment, part)
      if (within > 0 && (seen.etag === undefined || seen.size < within)) {
        // The kept prefix is gone or short: the lake lost bytes under this writer.
        throw new LakeWriteConflict(this.lake.partKey(this.segment, part))
      }
      let prefix = seen.bytes?.subarray(0, within)
      if (within > 0 && (prefix === undefined || prefix.byteLength < within)) {
        const read = await this.lake.readPrefix(this.segment, part, within)
        if (read === undefined || read.etag !== seen.etag || read.bytes.byteLength < within) {
          throw new LakeWriteConflict(this.lake.partKey(this.segment, part))
        }
        prefix = read.bytes
      }
      const body = new Uint8Array(within + take)
      if (prefix !== undefined && within > 0) body.set(prefix.subarray(0, within), 0)
      body.set(rest.subarray(0, take), within)
      // Durable when the part is complete, or when the put drops bytes past
      // `within` that another writer or a crashed run left: only a put that
      // purely extends the part's own prefix may be lost to a crash.
      const durable = within + take === P || seen.size > within
      const etag = await this.lake.putPart(this.segment, part, body, seen, durable)
      this.known = { part, etag, size: body.byteLength, bytes: body }
      this.at += take
      rest = rest.subarray(take)
    }
  }
}

function absent(part: number): PartState {
  return { part, etag: undefined, size: 0 }
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}
