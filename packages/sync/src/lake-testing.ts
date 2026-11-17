/**
 * Test support for the parted lake and the mirror (POD-6963 design 2.3): the
 * lake's two test backends, so every lake and mirror test runs on local disk
 * and on object-store semantics alike, plus a fake daemon filesystem and an
 * in-memory MirrorStore. Imported by tests only.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BlobStore, blobKey } from '@podium/blob-store'
import { LocalBlobStorage } from '@podium/blob-store/local'
import { MemoryBlobStorage } from '@podium/blob-store/memory'
import type { WorkspaceId } from '@podium/model'
import type { MirrorReadResult, MirrorStore } from './mirror'

export interface LakeBackend {
  readonly blobs: BlobStore
  readonly workspaceId: WorkspaceId
  /** Remove every lake part of a machine: the "lake wiped" ops event. */
  wipe(machine: string): Promise<void>
  dispose(): void
}

export interface LakeAdapter {
  readonly name: 'local' | 'memory'
  create(): LakeBackend
}

async function wipeMachine(blobs: BlobStore, machine: string): Promise<void> {
  const keys = []
  for await (const entry of blobs.list(blobKey(`transcripts/${machine}`))) keys.push(entry.key)
  for (const key of keys) await blobs.delete(key)
}

export const LAKE_ADAPTERS: readonly LakeAdapter[] = [
  {
    name: 'local',
    create() {
      const stateDir = mkdtempSync(join(tmpdir(), 'podium-lake-'))
      // A state directory holds the one workspace it is first asked for.
      const workspaceId = 'w-test' as WorkspaceId
      const blobs = new LocalBlobStorage({ stateDir }).forWorkspace(workspaceId)
      return {
        blobs,
        workspaceId,
        wipe: async (machine) => await wipeMachine(blobs, machine),
        dispose: () => rmSync(stateDir, { recursive: true, force: true }),
      }
    },
  },
  {
    name: 'memory',
    create() {
      const workspaceId = 'w-test' as WorkspaceId
      const blobs = new MemoryBlobStorage().forWorkspace(workspaceId)
      return {
        blobs,
        workspaceId,
        wipe: async (machine) => await wipeMachine(blobs, machine),
        dispose: () => {},
      }
    },
  },
]

export interface ReadLog {
  path: string
  offset: number
  maxBytes: number
}

/** In-memory "daemon filesystem": one buffer per path, ranged reads, request log,
 *  optional per-path error injection and in-flight concurrency tracking. */
export class FakeDaemonFs {
  private readonly files = new Map<string, Buffer>()
  private readonly identities = new Map<string, { device: string; inode: string }>()
  private nextInode = 1
  readonly log: ReadLog[] = []
  /** performance.now() at each read — lets tests assert inter-chunk spacing. */
  readonly readTimes: number[] = []
  readonly errors = new Map<string, string>()
  delayMs = 0
  /** Optional deterministic gate for parking an issued daemon read in flight. */
  readBarrier?: Promise<void>
  /** Synchronous spin per read — models the wire decode/encode CPU a real chunk
   *  costs the server (JSON + zod + base64), for the loop-lag regression test. */
  busyMs = 0
  private inFlight = 0
  maxInFlight = 0

  set(path: string, content: string | Buffer): void {
    this.files.set(path, Buffer.from(content))
    if (!this.identities.has(path)) {
      this.identities.set(path, { device: '7', inode: String(this.nextInode++) })
    }
  }

  replace(path: string, content: string | Buffer): void {
    this.files.set(path, Buffer.from(content))
    this.identities.set(path, { device: '7', inode: String(this.nextInode++) })
  }

  read = async (
    _machineId: string,
    req: { path: string; offset: number; maxBytes: number },
  ): Promise<MirrorReadResult> => {
    this.log.push({ ...req })
    this.readTimes.push(performance.now())
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    if (this.readBarrier) await this.readBarrier
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
    return {
      data: slice.toString('base64'),
      fileSize: size,
      eof: end >= size,
      ...this.identities.get(req.path),
    }
  }
}

/**
 * In-memory `MirrorStore` double — no SQLite, no apps/server
 * ConversationsRepository (this package must not depend on apps/*): just the
 * segment bookkeeping (mirrored/reported byte cursors per machine+nativeId)
 * MirrorService actually reads and writes.
 */
export class FakeMirrorStore implements MirrorStore {
  private readonly segments = new Map<
    string,
    { path: string; mirroredBytes: number; reportedBytes: number | null }
  >()
  private readonly incarnations = new Map<
    string,
    { sequence: number; device: string; inode: string; mirroredBytes: number; active: boolean }[]
  >()

  private key(machineId: string, nativeId: string): string {
    return `${machineId}\n${nativeId}`
  }

  /** Seed path evidence for a segment (mirrors
   *  ConversationsRepository.ensureConversationIdentity's shape: an optional
   *  last-reported size, `mirroredBytes` always starts at 0). */
  seed(machineId: string, nativeId: string, path: string, sizeBytes?: number): void {
    this.segments.set(this.key(machineId, nativeId), {
      path,
      mirroredBytes: 0,
      reportedBytes: sizeBytes ?? null,
    })
  }

  async segmentsToMirror(
    machineId: string,
  ): Promise<{ nativeId: string; path: string; mirroredBytes: number }[]> {
    const prefix = `${machineId}\n`
    return [...this.segments.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({
        nativeId: k.slice(prefix.length),
        path: v.path,
        mirroredBytes: v.mirroredBytes,
      }))
  }

  async segmentsToMirrorDirty(
    machineId: string,
  ): Promise<{ nativeId: string; path: string; mirroredBytes: number }[]> {
    return (await this.segmentsToMirror(machineId)).filter((seg) => {
      const v = this.segments.get(this.key(machineId, seg.nativeId))
      return v !== undefined && (v.reportedBytes == null || v.reportedBytes !== v.mirroredBytes)
    })
  }

  setReportedBytes(machineId: string, nativeId: string, bytes: number): void {
    const v = this.segments.get(this.key(machineId, nativeId))
    if (v) v.reportedBytes = bytes
  }

  /** Not part of MirrorStore — a test-only accessor (mirrors
   *  ConversationsRepository.reportedBytes, used by assertions below). */
  reportedBytes(machineId: string, nativeId: string): number | undefined {
    return this.segments.get(this.key(machineId, nativeId))?.reportedBytes ?? undefined
  }

  mirrorCursor(machineId: string, nativeId: string): number {
    return this.segments.get(this.key(machineId, nativeId))?.mirroredBytes ?? 0
  }

  /** The compare-and-set: applies only while the cursor equals `expected`. */
  setMirrorCursor(
    machineId: string,
    nativeId: string,
    expected: number,
    bytes: number,
    _at: string,
  ): boolean {
    const v = this.segments.get(this.key(machineId, nativeId))
    if (!v || v.mirroredBytes !== expected) return false
    v.mirroredBytes = bytes
    return true
  }

  /** Not part of MirrorStore — a test-only unconditional cursor write. */
  forceMirrorCursor(machineId: string, nativeId: string, bytes: number): void {
    const v = this.segments.get(this.key(machineId, nativeId))
    if (v) v.mirroredBytes = bytes
  }

  activeIncarnation(machineId: string, nativeId: string) {
    return this.incarnations.get(this.key(machineId, nativeId))?.find((row) => row.active)
  }

  startIncarnation(
    machineId: string,
    nativeId: string,
    identity: { device: string; inode: string },
    _at: string,
  ): void {
    const key = this.key(machineId, nativeId)
    const rows = this.incarnations.get(key) ?? []
    if (rows.some((row) => row.active)) return
    rows.push({ sequence: rows.length + 1, ...identity, mirroredBytes: 0, active: true })
    this.incarnations.set(key, rows)
  }

  rotateIncarnation(
    machineId: string,
    nativeId: string,
    from: { sequence: number; device: string; inode: string },
    identity: { device: string; inode: string },
    archivedBytes: number,
    _at: string,
  ): boolean {
    const key = this.key(machineId, nativeId)
    const rows = this.incarnations.get(key) ?? []
    const active = rows.find((row) => row.active)
    if (
      !active ||
      active.sequence !== from.sequence ||
      active.device !== from.device ||
      active.inode !== from.inode
    ) {
      return false
    }
    active.active = false
    active.mirroredBytes = archivedBytes
    rows.push({ sequence: active.sequence + 1, ...identity, mirroredBytes: 0, active: true })
    this.incarnations.set(key, rows)
    this.forceMirrorCursor(machineId, nativeId, 0)
    return true
  }

  incarnationRows(machineId: string, nativeId: string) {
    return this.incarnations.get(this.key(machineId, nativeId)) ?? []
  }
}

export function patternBytes(size: number, seed = 0): Buffer {
  const b = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) % 251
  return b
}
