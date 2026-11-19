/**
 * CONVERTING A SELF-HOSTED LAKE INTO PARTS [POD-6963 design 2.3.1].
 *
 * Before the parted lake, the mirror kept one file per segment incarnation
 * under `<state>/transcripts`: `<machine>/<native>.jsonl` for the active
 * incarnation (or a segment with no incarnation row) and
 * `<machine>/<native>.incarnation-<seq>.jsonl` for an archived one. This boot
 * step splits each of those files into the parted lake's parts, once, after the
 * store migrations and before the mirror starts.
 *
 * - **Work list from the database**, never a directory walk: a co-located
 *   daemon keeps its own files under the same `transcripts/` name. Segments
 *   with `mirrored_bytes > 0`, then retired incarnation rows with
 *   `mirrored_bytes > 0`, each in key order and in pages.
 * - **Per source file**: absent means done (converted earlier, or never
 *   written). Otherwise its bytes are put as parts with `durable: true`,
 *   overwriting what a crashed run left, and any part above the last one is
 *   removed, so the incarnation holds exactly the source; every part is read
 *   back and compared with the source; only then is the source deleted, with a
 *   directory fsync. A source shorter (or longer) than its cursor is converted
 *   as it is: the mirror's guard and its writer repair the cursor afterwards.
 * - **Resumable.** A present source means "not yet converted", so a run killed
 *   anywhere starts that file again from byte 0 and ends byte-identical.
 * - **Free space.** One source file is converted at a time, so the preflight
 *   needs the largest remaining source plus a margin, never the whole lake.
 * - **Done marker.** `lake-parts-conversion.done` in the state directory,
 *   outside the transferred roots; its presence skips the step.
 */

import { type FileHandle, open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  type BlobKey,
  type BlobStore,
  InvalidBlobKey,
  type PortableStateWriteFence,
} from '@podium/blob-store'
import type { MachineId, WorkspaceId } from '@podium/model'
import { type LakeSegment, PartedLake } from '@podium/sync'
import type { LakeConversionArchived, LakeConversionSegment } from '../store/conversations/mirror'
import { freeDiskBytes } from './backup'

/** The marker a finished conversion writes; its presence skips the step. */
export const LAKE_PARTS_CONVERSION_MARKER = 'lake-parts-conversion.done'

/** Free space kept beyond the largest source file. */
export const LAKE_CONVERSION_MARGIN_BYTES = 64 * 1024 * 1024

/** One progress line per this many segments (and per this many archived files). */
const PROGRESS_EVERY = 100

/** Rows read per page of the work list. */
const DEFAULT_PAGE_SIZE = 500

/** The rows the work list is read from: the mirror repository's two pages. */
export interface LakeConversionRows {
  lakeConversionSegments(
    after: { machineId: MachineId; nativeId: string } | undefined,
    limit: number,
  ): Promise<LakeConversionSegment[]>
  lakeConversionArchived(
    after: { machineId: MachineId; nativeId: string; sequence: number } | undefined,
    limit: number,
  ): Promise<LakeConversionArchived[]>
}

export interface LakeConversionLog {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface LakePartsConversionOptions {
  /** The state directory: the legacy files sit under its `transcripts/`, the marker beside it. */
  stateDir: string
  rows: LakeConversionRows
  /** The workspace's blob store the parted lake writes to. */
  blobs: BlobStore
  workspaceId: WorkspaceId
  log: LakeConversionLog
  /** Wraps the source deletes and the marker write; the server passes its transfer fence. */
  fence?: PortableStateWriteFence
  /**
   * Free bytes where the parts land, for the preflight. The default measures
   * the state directory; `undefined` skips the preflight (parts on a bucket).
   */
  freeBytes?: (() => number) | undefined
  /** TEST ONLY: the lake's part size. */
  partBytes?: number
  /** TEST ONLY: rows per page. */
  pageSize?: number
}

export interface LakePartsConversionResult {
  /** True when the marker said the conversion had already run. */
  skipped: boolean
  /** Segments visited (rows with mirrored bytes). */
  segments: number
  /** Archived incarnations visited. */
  archived: number
  /** Source files split into parts and removed. */
  converted: number
  /** Row-named source files that were already absent. */
  absent: number
  /** Bytes moved into parts. */
  bytes: number
  /** Row-named files left in place because their ids cannot form a lake key. */
  unaddressable: number
}

/** The preflight found less free space than one source file needs. */
export class LakeConversionNoSpace extends Error {
  override readonly name = 'LakeConversionNoSpace'
  constructor(
    readonly neededBytes: number,
    readonly freeBytes: number,
    readonly largestPath: string,
  ) {
    super(
      `the transcript lake conversion needs ${neededBytes} bytes free (the largest lake file, ` +
        `${largestPath}, plus a ${LAKE_CONVERSION_MARGIN_BYTES}-byte margin); ${freeBytes} are free`,
    )
  }
}

/** A part read back did not hold the source's bytes; the source is kept. */
export class LakeConversionMismatch extends Error {
  override readonly name = 'LakeConversionMismatch'
  constructor(
    readonly sourcePath: string,
    readonly key: BlobKey,
  ) {
    super(`lake part ${key} does not match its source ${sourcePath}; the source is kept`)
  }
}

/** One row-named legacy file and the incarnation its bytes become. */
interface WorkItem {
  readonly path: string
  readonly segment: LakeSegment
}

/**
 * Run the conversion unless its marker exists. Blocking: it returns when every
 * row-named legacy file is converted, and throws (leaving the marker unwritten)
 * on a failed preflight, a mismatch or an I/O error, so the next boot resumes.
 */
export async function convertLakeToParts(
  options: LakePartsConversionOptions,
): Promise<LakePartsConversionResult> {
  const result: LakePartsConversionResult = {
    skipped: false,
    segments: 0,
    archived: 0,
    converted: 0,
    absent: 0,
    bytes: 0,
    unaddressable: 0,
  }
  const marker = join(options.stateDir, LAKE_PARTS_CONVERSION_MARKER)
  if (await exists(marker)) return { ...result, skipped: true }

  const lake = new PartedLake(options.blobs, options.workspaceId, {
    ...(options.partBytes === undefined ? {} : { partBytes: options.partBytes }),
  })
  const root = resolve(options.stateDir, 'transcripts')
  const work = () => workList(options.rows, root, options.pageSize ?? DEFAULT_PAGE_SIZE)
  const runWriter = <T>(writer: () => Promise<T>): Promise<T> =>
    options.fence === undefined ? writer() : options.fence.runWriter(writer)

  // Preflight: one file at a time, so the largest remaining source plus a margin.
  const freeBytes =
    'freeBytes' in options ? options.freeBytes : () => freeDiskBytes(options.stateDir)
  if (freeBytes !== undefined) {
    let largest = { size: 0, path: '' }
    for await (const { item } of work()) {
      const size = await fileSize(item.path)
      if (size !== undefined && size > largest.size) largest = { size, path: item.path }
    }
    if (largest.size > 0) {
      const needed = largest.size + LAKE_CONVERSION_MARGIN_BYTES
      const free = freeBytes()
      if (free < needed) throw new LakeConversionNoSpace(needed, free, largest.path)
    }
  }

  const started = Date.now()
  options.log.info('converting the transcript lake into parts')
  for await (const { item, kind } of work()) {
    if (kind === 'segment') result.segments += 1
    else result.archived += 1
    try {
      lake.incarnationKey(item.segment)
    } catch (error) {
      if (!(error instanceof InvalidBlobKey)) throw error
      // The mirror cannot address these bytes either; leave the file for an operator.
      result.unaddressable += 1
      options.log.warn('lake file left in place: its ids cannot form a lake key', {
        path: item.path,
      })
      continue
    }
    const bytes = await convertFile(lake, options.blobs, item, runWriter)
    if (bytes === undefined) result.absent += 1
    else {
      result.converted += 1
      result.bytes += bytes
    }
    const count = kind === 'segment' ? result.segments : result.archived
    if (count % PROGRESS_EVERY === 0) {
      options.log.info('transcript lake conversion progress', {
        segments: result.segments,
        archived: result.archived,
        converted: result.converted,
        bytes: result.bytes,
      })
    }
  }
  await runWriter(() =>
    writeMarker(marker, {
      layout: 'parted',
      convertedAt: new Date().toISOString(),
      converted: result.converted,
      bytes: result.bytes,
    }),
  )
  options.log.info('transcript lake converted into parts', {
    segments: result.segments,
    archived: result.archived,
    converted: result.converted,
    absent: result.absent,
    unaddressable: result.unaddressable,
    bytes: result.bytes,
    durationMs: Date.now() - started,
  })
  return result
}

/**
 * The work list, page by page from the rows: the canonical file of every
 * segment with mirrored bytes (as its active incarnation, or 1 with no row),
 * then the archived file of every retired incarnation with a byte count.
 */
async function* workList(
  rows: LakeConversionRows,
  root: string,
  pageSize: number,
): AsyncGenerator<{ item: WorkItem; kind: 'segment' | 'archived' }> {
  let after: { machineId: MachineId; nativeId: string } | undefined
  for (;;) {
    const page = await rows.lakeConversionSegments(after, pageSize)
    for (const row of page) {
      const path = legacyPath(root, row.machineId, `${row.nativeId}.jsonl`)
      const segment = {
        machineId: row.machineId,
        nativeId: row.nativeId,
        incarnation: row.activeSequence ?? 1,
      }
      // A name that leaves the lake root was never a lake file: leave it alone.
      if (path !== undefined) yield { item: { path, segment }, kind: 'segment' }
    }
    const last = page.at(-1)
    if (last === undefined || page.length < pageSize) break
    after = { machineId: last.machineId, nativeId: last.nativeId }
  }
  let afterArchived: { machineId: MachineId; nativeId: string; sequence: number } | undefined
  for (;;) {
    const page = await rows.lakeConversionArchived(afterArchived, pageSize)
    for (const row of page) {
      const path = legacyPath(
        root,
        row.machineId,
        `${row.nativeId}.incarnation-${row.sequence}.jsonl`,
      )
      const segment = {
        machineId: row.machineId,
        nativeId: row.nativeId,
        incarnation: row.sequence,
      }
      if (path !== undefined) yield { item: { path, segment }, kind: 'archived' }
    }
    const last = page.at(-1)
    if (last === undefined || page.length < pageSize) break
    afterArchived = { machineId: last.machineId, nativeId: last.nativeId, sequence: last.sequence }
  }
}

/**
 * The pre-parts mirror's path for a lake file (`join(root, machine, name)`), or
 * undefined when the ids would resolve outside the machine's own directory.
 */
function legacyPath(root: string, machineId: string, name: string): string | undefined {
  const machineDir = resolve(root, machineId)
  if (dirname(machineDir) !== root) return undefined
  const path = resolve(machineDir, name)
  return path.startsWith(machineDir + sep) ? path : undefined
}

/**
 * Split one source file into its incarnation's parts, verify them, delete the
 * source. Returns the bytes converted, or undefined when the source is absent.
 */
async function convertFile(
  lake: PartedLake,
  blobs: BlobStore,
  item: WorkItem,
  runWriter: <T>(writer: () => Promise<T>) => Promise<T>,
): Promise<number | undefined> {
  const handle = await openIfPresent(item.path)
  if (handle === undefined) return undefined
  const P = lake.partBytes
  let size: number
  try {
    size = (await handle.stat()).size
    const parts = Math.ceil(size / P)
    for (let part = 0; part < parts; part += 1) {
      const bytes = await readChunk(handle, part * P, Math.min(P, size - part * P))
      await blobs.put(lake.partKey(item.segment, part), bytes, { durable: true })
    }
    // Parts above the source's last one (a mirror that ran on this incarnation
    // before the conversion existed) would make the stored size lie.
    for (let part = parts; ; part += 1) {
      const key = lake.partKey(item.segment, part)
      if ((await blobs.head(key)) === undefined) break
      await blobs.delete(key, { durable: true })
    }
    for (let part = 0; part < parts; part += 1) {
      const length = Math.min(P, size - part * P)
      const key = lake.partKey(item.segment, part)
      const source = await readChunk(handle, part * P, length)
      const got = await blobs.get(key)
      const stored = got === undefined ? undefined : await collect(got.body)
      if (stored === undefined || !Buffer.from(stored).equals(Buffer.from(source))) {
        throw new LakeConversionMismatch(item.path, key)
      }
    }
  } finally {
    await handle.close()
  }
  await runWriter(async () => {
    await unlink(item.path)
    await fsyncDirectory(dirname(item.path))
  })
  return size
}

async function readChunk(handle: FileHandle, offset: number, length: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(length)
  let at = 0
  while (at < length) {
    const { bytesRead } = await handle.read(buffer, at, length - at, offset + at)
    if (bytesRead === 0) break
    at += bytesRead
  }
  // Nothing writes a legacy file once the mirror writes parts, so a short read
  // means the file changed under the conversion: stop rather than guess.
  if (at < length) throw new Error(`lake file shrank during conversion at byte ${offset + at}`)
  return buffer
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer())
}

async function openIfPresent(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, 'r')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const stats = await stat(path)
    return stats.isFile() ? stats.size : undefined
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  return (await fileSize(path)) !== undefined
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Write the marker durably: a temp file, fsync, rename, directory fsync. */
async function writeMarker(path: string, body: Record<string, unknown>): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(body)}\n`)
  const handle = await open(temp, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
  await fsyncDirectory(dirname(path))
}

async function fsyncDirectory(dir: string): Promise<void> {
  // Windows cannot open a directory for fsync; its unlink and rename are
  // already durable enough for the desktop install.
  if (process.platform === 'win32') return
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
