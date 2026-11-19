import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asWorkspaceId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { blobKey } from './key'
import { LocalBlobStorage } from './local'
import { MemoryBlobStorage, MemoryBucket } from './memory'
import { bodyText, bytes, describeBlobStoreContract, listKeys } from './testing/contract'

describeBlobStoreContract('local', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'blob-store-contract-'))
  return {
    store: new LocalBlobStorage({ stateDir }).forWorkspace(asWorkspaceId('local')),
    etagPerPut: true,
    dispose: () => rm(stateDir, { recursive: true, force: true }),
  }
})

describeBlobStoreContract('memory', async () => ({
  store: new MemoryBlobStorage().forWorkspace(asWorkspaceId('ws-contract')),
  etagPerPut: true,
}))

describe('memory bucket', () => {
  it('keeps two workspaces with the same keys apart in one bucket', async () => {
    const bucket = new MemoryBucket()
    const storage = new MemoryBlobStorage(bucket)
    const a = storage.forWorkspace(asWorkspaceId('ws-a'))
    const b = storage.forWorkspace(asWorkspaceId('ws-b'))
    const key = blobKey('artifacts/i1/a1/index.html')
    await a.put(key, bytes('from a'))
    await b.put(key, bytes('from b'))
    expect(await bodyText(await a.get(key))).toBe('from a')
    expect(await bodyText(await b.get(key))).toBe('from b')
    await a.delete(key)
    expect(await a.head(key)).toBeUndefined()
    expect(await listKeys(b, blobKey('artifacts'))).toEqual([key])
    expect(bucket.names()).toEqual(['ws-b/artifacts/i1/a1/index.html'])
  })

  it('refuses a workspace id that would escape its prefix', () => {
    const storage = new MemoryBlobStorage()
    expect(() => storage.forWorkspace(asWorkspaceId('a/b'))).toThrow(TypeError)
  })
})
