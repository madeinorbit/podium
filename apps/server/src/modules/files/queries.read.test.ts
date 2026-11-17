/**
 * `files.read` OF AN ARTIFACT MEMBER (POD-6963 design 2.7).
 *
 * The read goes through the workspace's artifact store, the same one
 * `/files/artifact` streams from: a real `IssueArtifactStore` over the in-memory
 * blob store. No daemon is involved, so the rpc is never reached.
 */

import { type BlobStore, joinKey, keySegment } from '@podium/blob-store'
import { MemoryBlobStorage } from '@podium/blob-store/memory'
import { asArtifactId, asIssueId, asWorkspaceId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import { IssueArtifactStore } from '../issues/artifact-store'
import { FILE_QUERIES } from './queries'
import type { FileState } from './registry'

const ISSUE = asIssueId('iss_1')
const ARTIFACT = asArtifactId('abc123')

async function put(files: BlobStore, rel: string, bytes: Uint8Array): Promise<void> {
  await files.put(joinKey('artifacts', ISSUE, ARTIFACT, ...rel.split('/').map(keySegment)), bytes)
}

const stateOver = (files: BlobStore): FileState =>
  ({
    artifacts: new IssueArtifactStore({ files, uploads: {} as never, rpc: {} as never }),
    rpc: new Proxy({}, { get: () => () => Promise.reject(new Error('no daemon here')) }),
  }) as unknown as FileState

const read = (state: FileState, path: string) =>
  FILE_QUERIES.read.run(state, { issueId: ISSUE, artifactId: ARTIFACT, path })

describe('files.read of an artifact member', () => {
  it('returns the member text from the workspace store', async () => {
    const files = new MemoryBlobStorage().forWorkspace(SELF_HOSTED_WORKSPACE_ID)
    await put(files, 'notes/read me.md', new TextEncoder().encode('# Title\n\nbody ü\n'))
    expect(await read(stateOver(files), 'notes/read me.md')).toEqual({
      ok: true,
      path: 'notes/read me.md',
      content: '# Title\n\nbody ü\n',
    })
  })

  it('reads a large member whole and keeps a leading byte order mark', async () => {
    const files = new MemoryBlobStorage().forWorkspace(SELF_HOSTED_WORKSPACE_ID)
    const text = `﻿${'line of text\n'.repeat(200_000)}`
    await put(files, 'big.txt', new TextEncoder().encode(text))
    const r = await read(stateOver(files), 'big.txt')
    expect(r.ok).toBe(true)
    const content = 'content' in r ? (r.content ?? '') : ''
    expect(content.length).toBe(text.length)
    expect(content === text).toBe(true)
  })

  it('answers not found for a missing member or a path that is not a key', async () => {
    const files = new MemoryBlobStorage().forWorkspace(SELF_HOSTED_WORKSPACE_ID)
    const state = stateOver(files)
    for (const path of ['gone.md', '../escape.md']) {
      expect(await read(state, path)).toEqual({
        ok: false,
        path,
        error: 'artifact file not found',
      })
    }
  })

  it('never reads another workspace under the same ids', async () => {
    const storage = new MemoryBlobStorage()
    await put(
      storage.forWorkspace(asWorkspaceId('ws_other')),
      'a.md',
      new TextEncoder().encode('x'),
    )
    const r = await read(stateOver(storage.forWorkspace(SELF_HOSTED_WORKSPACE_ID)), 'a.md')
    expect(r.ok).toBe(false)
  })
})
