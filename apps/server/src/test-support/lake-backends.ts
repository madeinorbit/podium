/**
 * The transcript lake's two test backends (POD-6963 design 2.3): local disk for
 * workspace `local` and the in-memory adapter with object-store semantics, so a
 * lake test runs on both. `write` puts bytes into a segment incarnation through
 * the parted lake, never at a path.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobStore } from '@podium/blob-store'
import { LocalBlobStorage } from '@podium/blob-store/local'
import { MemoryBlobStorage } from '@podium/blob-store/memory'
import { asWorkspaceId, type MachineId, type WorkspaceId } from '@podium/model'
import { PartedLake } from '@podium/sync'
import type { TranscriptLakeStorage } from '../modules/memory/lake'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'

/** A cursor past every test segment (1 GiB): reads stop at the stored size. */
const UNBOUNDED = 2 ** 30

export interface LakeTestBackend {
  readonly storage: TranscriptLakeStorage
  readonly lake: PartedLake
  /** Write `bytes` as the whole content of one incarnation (sequence 1 by default). */
  write(
    machineId: MachineId,
    nativeId: string,
    bytes: string | Uint8Array,
    incarnation?: number,
  ): Promise<void>
  /** Every stored byte of one incarnation, unbounded by any cursor. */
  read(machineId: MachineId, nativeId: string, incarnation?: number): Promise<Buffer>
  dispose(): void
}

function backend(blobs: BlobStore, workspaceId: WorkspaceId, dispose: () => void): LakeTestBackend {
  const lake = new PartedLake(blobs, workspaceId)
  return {
    storage: { blobs, workspaceId },
    lake,
    async write(machineId, nativeId, bytes, incarnation = 1) {
      const writer = await lake.openWriter({ machineId, nativeId, incarnation }, 0)
      await writer.append(typeof bytes === 'string' ? Buffer.from(bytes) : bytes)
    },
    async read(machineId, nativeId, incarnation = 1) {
      const source = lake.source({ machineId, nativeId, incarnation }, () => UNBOUNDED)
      return Buffer.from(await source.read(0, await source.size()))
    },
    dispose,
  }
}

export const LAKE_BACKENDS: readonly {
  readonly name: 'local' | 'memory'
  create(workspaceId?: string): LakeTestBackend
}[] = [
  {
    name: 'local',
    create() {
      const stateDir = mkdtempSync(join(tmpdir(), 'podium-lake-'))
      const blobs = new LocalBlobStorage({ stateDir }).forWorkspace(SELF_HOSTED_WORKSPACE_ID)
      return backend(blobs, SELF_HOSTED_WORKSPACE_ID, () =>
        rmSync(stateDir, { recursive: true, force: true }),
      )
    },
  },
  {
    name: 'memory',
    create(workspaceId = 'w-test') {
      const id = asWorkspaceId(workspaceId)
      return backend(new MemoryBlobStorage().forWorkspace(id), id, () => {})
    },
  },
]
