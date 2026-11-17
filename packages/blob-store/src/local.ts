/**
 * The local-disk adapter [POD-6963 design 2.1 and 2.2].
 *
 * Workspace `local` maps a key to the same relative path under the state
 * directory, so today's files stay where they are; every other workspace id is
 * refused, because a self-hosted install has one workspace and a second id can
 * only be a bug.
 *
 * - **Atomic replace.** A put writes `.tmp-<uuid>` in the target directory and
 *   renames it over the key, so a reader sees the old bytes or the new ones.
 *   `durable` (default true) fsyncs the file before the rename and the
 *   directory after it.
 * - **Conditional writes.** The etag is the file's inode, size and modification
 *   time; a replace always makes a new inode, so every put changes it. The
 *   condition check and the rename run under a per-key in-process mutex, which
 *   assumes one server process per state directory, as the in-process transfer
 *   fence and the sweeps already do.
 * - **Reads.** `get` opens the file once and streams from that descriptor, so a
 *   replace during the read cannot mix bytes. The caller must read the body to
 *   the end or cancel it; either closes the descriptor.
 * - **List** walks the directory tree in key-byte order and skips anything that
 *   is not a valid key segment: in-flight temp files, stray files, symlinks.
 * - **Temp files** left by a crash are removed by
 *   {@link LocalBlobStorage.removeLeftoverTempFiles} at boot, so they never
 *   reach a transfer snapshot.
 * - **Fence.** With a {@link PortableStateWriteFence}, every write (put, copy,
 *   delete, the temp cleanup) runs inside `fence.runWriter`.
 */

import { randomUUID } from 'node:crypto'
import type { BigIntStats, Dirent } from 'node:fs'
import { type FileHandle, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkspaceId } from '@podium/model'
import { bodyChunks, KeyedMutex } from './internal'
import { type BlobKey, blobKey, isKeySegment, TEMP_PREFIX } from './key'
import {
  type BlobBody,
  BlobConditionFailed,
  type BlobCopyOptions,
  type BlobGetResult,
  type BlobHead,
  type BlobListEntry,
  BlobNotFound,
  type BlobPutOptions,
  type BlobRange,
  type BlobStorage,
  type BlobStore,
  clipRange,
  LOCAL_WORKSPACE_ID,
  type PortableStateWriteFence,
} from './types'

/** The key roots of design 2.2 that hold blob-store files under the state directory. */
export const DEFAULT_LOCAL_BLOB_ROOTS: readonly string[] = [
  'artifacts',
  'pending-uploads',
  'transcripts',
]

const TEMP_FILE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const READ_CHUNK = 64 * 1024

export interface LocalBlobStorageOptions {
  /** The server's state directory; workspace `local` keys resolve under it. */
  stateDir: string
  /** Wraps every write; the server passes its `PortableStateFence`. */
  fence?: PortableStateWriteFence
  /** The top-level directories the boot temp cleanup walks (default {@link DEFAULT_LOCAL_BLOB_ROOTS}). */
  roots?: readonly string[]
}

interface WriteConditions {
  ifAbsent?: true
  ifMatch?: string
  durable: boolean
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

/** A path that does not resolve to a readable file: absent, or a component is not a directory. */
function isMissing(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function localEtag(stats: BigIntStats): string {
  return `${stats.ino.toString(36)}-${stats.size.toString(36)}-${stats.mtimeNs.toString(36)}`
}

function headOf(stats: BigIntStats): BlobHead {
  return { size: Number(stats.size), etag: localEtag(stats) }
}

async function fsyncDirectory(dir: string): Promise<void> {
  // Windows cannot open a directory for fsync; its rename is already durable
  // enough for the desktop install, and there is no other way to ask.
  if (process.platform === 'win32') return
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function fileStream(handle: FileHandle, start: number, end: number): ReadableStream<Uint8Array> {
  let position = start
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await handle.close()
  }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (position >= end) {
        await close()
        controller.close()
      }
    },
    async pull(controller) {
      try {
        const want = Math.min(READ_CHUNK, end - position)
        const buffer = new Uint8Array(want)
        const { bytesRead } = await handle.read(buffer, 0, want, position)
        if (bytesRead > 0) {
          position += bytesRead
          controller.enqueue(bytesRead === want ? buffer : buffer.subarray(0, bytesRead))
        }
        // A short read past the end means the file shrank under an
        // out-of-band writer; end the body there rather than loop.
        if (bytesRead === 0 || position >= end) {
          await close()
          controller.close()
        }
      } catch (error) {
        await close().catch(() => {})
        controller.error(error)
      }
    },
    async cancel() {
      await close()
    },
  })
}

class LocalBlobStore implements BlobStore {
  readonly conditionalWrites = true
  private readonly mutex = new KeyedMutex()

  constructor(
    private readonly stateDir: string,
    private readonly fence: PortableStateWriteFence | undefined,
  ) {}

  async put(key: BlobKey, body: BlobBody, opts: BlobPutOptions = {}): Promise<BlobHead> {
    const valid = blobKey(key)
    return this.write(() =>
      this.writeObject(
        valid,
        async (handle) => {
          for await (const chunk of bodyChunks(body)) await writeAll(handle, chunk)
        },
        {
          ...(opts.ifAbsent ? { ifAbsent: true as const } : {}),
          ...(opts.ifMatch !== undefined ? { ifMatch: opts.ifMatch } : {}),
          durable: opts.durable ?? true,
        },
      ),
    )
  }

  async get(key: BlobKey, range?: BlobRange): Promise<BlobGetResult | undefined> {
    const handle = await this.openFile(blobKey(key))
    if (handle === undefined) return undefined
    try {
      const stats = await handle.stat({ bigint: true })
      if (!stats.isFile()) {
        await handle.close()
        return undefined
      }
      const head = headOf(stats)
      const { start, end } = clipRange(head.size, range)
      return { ...head, body: fileStream(handle, start, end) }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  async head(key: BlobKey): Promise<BlobHead | undefined> {
    const stats = await this.statFile(this.path(blobKey(key)))
    return stats === undefined ? undefined : headOf(stats)
  }

  async delete(key: BlobKey): Promise<void> {
    const valid = blobKey(key)
    return this.write(() =>
      this.mutex.run(valid, async () => {
        try {
          await unlink(this.path(valid))
        } catch (error) {
          if (!isMissing(error)) throw error
        }
      }),
    )
  }

  async *list(prefix: BlobKey): AsyncIterable<BlobListEntry> {
    yield* this.walk(blobKey(prefix), this.path(prefix))
  }

  async copy(from: BlobKey, to: BlobKey, opts: BlobCopyOptions = {}): Promise<void> {
    const source = blobKey(from)
    const target = blobKey(to)
    return this.write(async () => {
      const handle = await this.openFile(source)
      if (handle === undefined) throw new BlobNotFound(source)
      try {
        if (!(await handle.stat()).isFile()) throw new BlobNotFound(source)
        await this.writeObject(
          target,
          async (out) => {
            const buffer = new Uint8Array(READ_CHUNK)
            let position = 0
            while (true) {
              const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
              if (bytesRead === 0) return
              await writeAll(out, buffer.subarray(0, bytesRead))
              position += bytesRead
            }
          },
          { durable: opts.durable ?? true },
        )
      } finally {
        await handle.close()
      }
    })
  }

  /** Remove every `.tmp-<uuid>` file under `roots`; returns how many were removed. */
  removeLeftoverTempFiles(roots: readonly string[]): Promise<number> {
    return this.write(async () => {
      let removed = 0
      const visit = async (dir: string): Promise<void> => {
        let entries: Dirent[]
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch (error) {
          if (isMissing(error)) return
          throw error
        }
        for (const entry of entries) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) {
            await visit(path)
          } else if (entry.isFile() && TEMP_FILE.test(entry.name)) {
            await rm(path, { force: true })
            removed += 1
          }
        }
      }
      for (const root of roots) await visit(join(this.stateDir, ...blobKey(root).split('/')))
      return removed
    })
  }

  private write<T>(writer: () => Promise<T>): Promise<T> {
    return this.fence === undefined ? writer() : this.fence.runWriter(writer)
  }

  private async writeObject(
    key: BlobKey,
    fill: (handle: FileHandle) => Promise<void>,
    conditions: WriteConditions,
  ): Promise<BlobHead> {
    const path = this.path(key)
    const dir = dirname(path)
    await mkdir(dir, { recursive: true })
    const temp = join(dir, `${TEMP_PREFIX}${randomUUID()}`)
    let renamed = false
    try {
      let head: BlobHead
      const handle = await open(temp, 'wx')
      try {
        await fill(handle)
        if (conditions.durable) await handle.sync()
        // The rename keeps the inode and the modification time, so the
        // descriptor's stats are the object's etag after the rename.
        head = headOf(await handle.stat({ bigint: true }))
      } finally {
        await handle.close()
      }
      return await this.mutex.run(key, async () => {
        if (conditions.ifAbsent || conditions.ifMatch !== undefined) {
          const current = await this.statFile(path)
          if (conditions.ifAbsent && current !== undefined)
            throw new BlobConditionFailed(key, 'ifAbsent')
          if (
            conditions.ifMatch !== undefined &&
            (current === undefined || localEtag(current) !== conditions.ifMatch)
          ) {
            throw new BlobConditionFailed(key, 'ifMatch')
          }
        }
        await rename(temp, path)
        renamed = true
        if (conditions.durable) await fsyncDirectory(dir)
        return head
      })
    } finally {
      if (!renamed) await rm(temp, { force: true })
    }
  }

  private async *walk(key: string, dir: string): AsyncGenerator<BlobListEntry> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    // Sorting siblings by name, with '/' after a directory's name, walks the
    // tree in the byte order of the full keys: every key under directory `a`
    // starts with `a/`, which is how it compares against a sibling file `a-b`.
    const children = entries
      .filter((entry) => (entry.isFile() || entry.isDirectory()) && isKeySegment(entry.name))
      .map((entry) => ({ entry, order: entry.isDirectory() ? `${entry.name}/` : entry.name }))
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    for (const { entry } of children) {
      const childKey = `${key}/${entry.name}`
      const childPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        yield* this.walk(childKey, childPath)
        continue
      }
      const stats = await this.statFile(childPath)
      if (stats !== undefined) yield { key: childKey as BlobKey, size: Number(stats.size) }
    }
  }

  private async openFile(key: BlobKey): Promise<FileHandle | undefined> {
    try {
      return await open(this.path(key), 'r')
    } catch (error) {
      if (isMissing(error) || errorCode(error) === 'EISDIR') return undefined
      throw error
    }
  }

  private async statFile(path: string): Promise<BigIntStats | undefined> {
    try {
      const stats = await stat(path, { bigint: true })
      return stats.isFile() ? stats : undefined
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  private path(key: BlobKey): string {
    return join(this.stateDir, ...key.split('/'))
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    offset += bytesWritten
  }
}

export class LocalBlobStorage implements BlobStorage {
  private readonly store: LocalBlobStore
  private readonly roots: readonly string[]

  constructor(options: LocalBlobStorageOptions) {
    this.store = new LocalBlobStore(options.stateDir, options.fence)
    this.roots = options.roots ?? DEFAULT_LOCAL_BLOB_ROOTS
  }

  /** The one store of workspace `local`; any other workspace id throws. */
  forWorkspace(workspaceId: WorkspaceId): BlobStore {
    if (workspaceId !== LOCAL_WORKSPACE_ID) {
      throw new Error(
        `the local blob store serves only workspace '${LOCAL_WORKSPACE_ID}', not ${JSON.stringify(workspaceId)}`,
      )
    }
    return this.store
  }

  /** Boot step: remove temp files a crashed put left behind. Returns how many were removed. */
  removeLeftoverTempFiles(): Promise<number> {
    return this.store.removeLeftoverTempFiles(this.roots)
  }
}
