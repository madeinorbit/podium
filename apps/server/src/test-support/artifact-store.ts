/**
 * An IssueArtifactStore for tests that do not open a database (POD-7054).
 *
 * The store keeps CLI upload state in `artifact_uploads`; tests that never
 * upload, or that test the issue service around the store, take these
 * in-memory rows instead. They keep the repository's one rule that matters to
 * the store: `advance` writes only where the row still holds `previous`.
 */

import { LOCAL_WORKSPACE_ID } from '@podium/blob-store'
import { LocalBlobStorage } from '@podium/blob-store/local'
import type { IssueId } from '@podium/model'
import {
  type ArtifactRpc,
  type ArtifactUploadState,
  IssueArtifactStore,
} from '../modules/issues/artifact-store'
import type { ArtifactUploadRef, ArtifactUploadRow } from '../store/artifact-uploads'

export function memoryArtifactUploads(): ArtifactUploadState {
  const rows = new Map<string, ArtifactUploadRow>()
  const id = (issueId: IssueId, uploadId: string) => `${issueId}\0${uploadId}`
  return {
    async begin(row) {
      if (rows.has(id(row.issueId, row.uploadId))) return false
      rows.set(id(row.issueId, row.uploadId), { ...row, received: [...row.received] })
      return true
    },
    async get(issueId, uploadId) {
      return rows.get(id(issueId, uploadId))
    },
    async advance(issueId, uploadId, previous, next) {
      const row = rows.get(id(issueId, uploadId))
      if (!row || JSON.stringify(row.received) !== JSON.stringify(previous)) return false
      rows.set(id(issueId, uploadId), { ...row, received: [...next] })
      return true
    },
    async delete(issueId, uploadId) {
      rows.delete(id(issueId, uploadId))
    },
    async deleteIssue(issueId) {
      for (const [key, row] of rows) if (row.issueId === issueId) rows.delete(key)
    },
    async createdBefore(before, limit): Promise<ArtifactUploadRef[]> {
      return [...rows.values()]
        .filter((row) => row.createdAt < before)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit)
        .map(({ issueId, uploadId }) => ({ issueId, uploadId }))
    },
  }
}

/** A store whose members live under `<stateDir>/artifacts`, as on a self-hosted disk. */
export function artifactStoreOnDisk(
  stateDir: string,
  rpc: ArtifactRpc,
  uploads: ArtifactUploadState = memoryArtifactUploads(),
): IssueArtifactStore {
  return new IssueArtifactStore({
    files: new LocalBlobStorage({ stateDir }).forWorkspace(LOCAL_WORKSPACE_ID),
    uploads,
    rpc,
  })
}
