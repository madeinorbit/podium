/** Read-only, bounded preview. Nothing in update admission/execution imports this module. */

import type { Stats } from 'node:fs'
import { lstat, opendir, stat, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  platformTargetFor,
  type UpdateSpaceEstimate,
  type UpdateSpaceVolume,
  type UpdateTarget,
  unknownUpdateSpace,
} from '@podium/protocol'

const MiB = 1024 ** 2
const GiB = 1024 ** 3
export const UPDATE_SPACE_MIN_SLACK = 512 * MiB

export interface SpaceAllocation {
  path: string
  /** Allocations in the same phase coexist. Distinct phases use their maximum. */
  phases: { prepare?: number; boot?: number }
}
export interface SpaceFilesystem {
  id: string
  availableBytes: number
}

export function requiredUpdateSpace(peakBytes: number): number {
  return Math.ceil(peakBytes + Math.max(peakBytes * 0.3, UPDATE_SPACE_MIN_SLACK))
}

export async function estimateUpdateVolumes(
  allocations: readonly SpaceAllocation[],
  filesystem: (path: string) => Promise<SpaceFilesystem> = sampleFilesystem,
): Promise<UpdateSpaceVolume[]> {
  const volumes = new Map<
    string,
    { path: string; available: number; prepare: number; boot: number }
  >()
  for (const allocation of allocations) {
    const fs = await filesystem(allocation.path)
    const volume = volumes.get(fs.id) ?? {
      path: allocation.path,
      available: fs.availableBytes,
      prepare: 0,
      boot: 0,
    }
    volume.available = Math.min(volume.available, fs.availableBytes)
    volume.prepare += allocation.phases.prepare ?? 0
    volume.boot += allocation.phases.boot ?? 0
    volumes.set(fs.id, volume)
  }
  return [...volumes.values()].map((volume) => {
    const peakBytes = Math.max(volume.prepare, volume.boot)
    const requiredBytes = requiredUpdateSpace(peakBytes)
    return {
      path: volume.path,
      availableBytes: volume.available,
      peakBytes,
      requiredBytes,
      shortfallBytes: Math.max(0, requiredBytes - volume.available),
    }
  })
}

async function sampleFilesystem(path: string): Promise<SpaceFilesystem> {
  let existing = resolve(path)
  while (true) {
    try {
      const info = await stat(existing)
      const fs = await statfs(existing)
      const availableBytes = Number(fs.bavail) * Number(fs.bsize)
      if (!Number.isSafeInteger(availableBytes) || availableBytes < 0)
        throw new Error('invalid filesystem capacity')
      return { id: String(info.dev), availableBytes }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing)
        throw cause
      existing = dirname(existing)
    }
  }
}

/** No symlink traversal, file reads, shell commands, or unbounded directory walks. */
async function installedBytes(root: string, signal: AbortSignal): Promise<number> {
  let entries = 0
  const visit = async (path: string): Promise<number> => {
    signal.throwIfAborted()
    if (++entries > 20_000) throw new Error('installation sizing budget exceeded')
    let info: Stats
    try {
      info = await lstat(path)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw cause
    }
    if (!info.isDirectory()) return Math.ceil(info.size / 4096) * 4096
    let bytes = 4096
    const directory = await opendir(path)
    for await (const entry of directory) bytes += await visit(join(path, entry.name))
    return bytes
  }
  return visit(root)
}

async function databaseBytes(path: string, signal: AbortSignal): Promise<number> {
  let bytes = 0
  for (const suffix of ['', '-wal', '-shm']) {
    signal.throwIfAborted()
    try {
      bytes += (await stat(path + suffix)).size
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  return bytes
}

export interface UpdateSpaceDeps {
  installDir: string
  stateDir: string
  hostsServer: boolean
  source?: boolean
  platform?: string
  fetch?: typeof fetch
  filesystem?: (path: string) => Promise<SpaceFilesystem>
}

export async function previewUpdateSpace(
  target: UpdateTarget,
  deps: UpdateSpaceDeps,
): Promise<UpdateSpaceEstimate> {
  try {
    const signal = AbortSignal.timeout(4_000)
    const platform = deps.platform ?? platformTargetFor(process.platform, process.arch)
    const deliveries = [target.artifacts.headless, ...(target.artifacts.headlessAlternatives ?? [])]
    const asset = deliveries.find((delivery) => delivery?.platforms[platform])?.platforms[platform]
    if (!asset || target.native !== undefined)
      return unknownUpdateSpace('The update size is unavailable for this installation.')

    // HEAD only. Do not download bytes, resolve a new release, or change frozen targets.
    const response = await (deps.fetch ?? fetch)(asset.url, { method: 'HEAD', signal })
    const length = response.headers.get('content-length')
    const downloadBytes = length === null ? NaN : Number(length)
    if (!response.ok || !Number.isSafeInteger(downloadBytes) || downloadBytes <= 0)
      return unknownUpdateSpace('The update download size could not be verified.')

    const currentBytes = deps.source ? 0 : await installedBytes(deps.installDir, signal)
    // Older releases carry no unpacked sizes. Budget six times the compressed
    // archive and at least twice the current installation for growth. These are
    // deliberately conservative estimates, kept OUT of the artifact descriptor.
    const expandedBytes = Math.max(downloadBytes * 6, currentBytes * 2)
    if (!Number.isSafeInteger(expandedBytes * 4))
      return unknownUpdateSpace('The update size is outside the preview budget.')
    const allocations: SpaceAllocation[] = deps.source
      ? [
          {
            path: join(deps.stateDir, 'builds'),
            phases: { prepare: downloadBytes * 2 + expandedBytes },
          },
          // Disposable source checkout, dependencies and build intermediates.
          { path: tmpdir(), phases: { prepare: expandedBytes * 2 + 2 * GiB } },
        ]
      : [
          {
            path: dirname(deps.installDir),
            phases: { prepare: downloadBytes + expandedBytes, boot: expandedBytes },
          },
        ]
    if (deps.hostsServer) {
      const bytes = await databaseBytes(join(deps.stateDir, 'podium.db'), signal)
      // Budget one full backup and 10% for typical migration growth/WAL, rather
      // than assuming every update rewrites the whole database. The per-volume
      // headroom covers further variation; this is a likely-use preview, not a
      // worst-case bound. Retained files already consume free space; do not add them.
      if (bytes > 0) {
        allocations.push(
          { path: deps.stateDir, phases: { boot: bytes } },
          // A symlinked database can live on another volume than its sibling backups.
          { path: join(deps.stateDir, 'podium.db'), phases: { boot: Math.ceil(bytes * 0.1) } },
        )
      }
    }
    signal.throwIfAborted()
    const volumes = await estimateUpdateVolumes(allocations, deps.filesystem)
    signal.throwIfAborted()
    return {
      status: volumes.some((volume) => volume.shortfallBytes > 0) ? 'low' : 'enough',
      checkedAt: Date.now(),
      volumes,
    }
  } catch {
    return unknownUpdateSpace('Disk space could not be verified within the preview budget.')
  }
}
