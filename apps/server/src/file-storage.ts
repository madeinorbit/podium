/**
 * THE SERVER'S FILE STORAGE [POD-6963 design 2.2 and 2.8].
 *
 * Built once by the composition root from the resolved `fileStorage` config:
 * `local` is the state directory (today's paths, writes inside the transfer
 * fence); `s3` is one S3-compatible bucket with a prefix per workspace. Each
 * workspace's service graph takes its own handle through `forWorkspace`, so a
 * caller can never name another workspace's files.
 */

import type { BlobStorage, PortableStateWriteFence } from '@podium/blob-store'
import { type LeftoverTempFileOptions, LocalBlobStorage } from '@podium/blob-store/local'
import { S3BlobStorage } from '@podium/blob-store/s3'
import type { FileStorageConfig } from '@podium/runtime/config'

export interface ServerFileStorage {
  storage: BlobStorage
  /** Which backend holds the files: the state directory or a bucket. */
  backend: FileStorageConfig['backend']
  /**
   * Remove the temp files a crashed local put left behind, so they do not pile
   * up or reach a later transfer snapshot. The server runs it once it listens
   * (POD-7541). Nothing to do on a bucket.
   */
  removeLeftoverTempFiles(options?: LeftoverTempFileOptions): Promise<number>
}

export function createServerFileStorage(
  config: FileStorageConfig,
  local: { stateDir: string; fence: PortableStateWriteFence },
): ServerFileStorage {
  if (config.backend === 'local') {
    const storage = new LocalBlobStorage({ stateDir: local.stateDir, fence: local.fence })
    return {
      storage,
      backend: 'local',
      removeLeftoverTempFiles: (options) => storage.removeLeftoverTempFiles(options),
    }
  }
  const storage = new S3BlobStorage({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  })
  return { storage, backend: config.backend, removeLeftoverTempFiles: async () => 0 }
}
