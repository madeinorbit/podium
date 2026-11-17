import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asWorkspaceId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobKey } from './key'
import { LocalBlobStorage } from './local'
import { bodyText, bytes, listKeys } from './testing/contract'
import { BlobConditionFailed, type BlobStore, type PortableStateWriteFence } from './types'

/** The workspace these tests store files for: a self-hosted install's. */
const WORKSPACE = asWorkspaceId('local')

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'blob-store-local-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(stateDir, { recursive: true, force: true })
})

const localStore = (fence?: PortableStateWriteFence): BlobStore =>
  new LocalBlobStorage({ stateDir, ...(fence ? { fence } : {}) }).forWorkspace(WORKSPACE)

const TEMP = '.tmp-0c0a7e4e-1a2b-4c3d-8e9f-001122334455'
const TEMP_2 = '.tmp-ffffffff-0000-4000-8000-123456789abc'

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const visit = async (at: string, rel: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(join(at, entry.name), childRel)
      else out.push(childRel)
    }
  }
  await visit(dir, '')
  return out.sort()
}

/** Spy on FileHandle.sync, which the adapter calls for a file and for a directory. */
async function spyOnSync() {
  const probe = await open(join(stateDir, 'probe'), 'w')
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
  await probe.close()
  await rm(join(stateDir, 'probe'))
  return vi.spyOn(proto, 'sync')
}

describe('local workspace mapping', () => {
  it('serves the one workspace it is first asked for and refuses every other workspace id', () => {
    const storage = new LocalBlobStorage({ stateDir })
    expect(storage.forWorkspace(WORKSPACE)).toBe(storage.forWorkspace(asWorkspaceId('local')))
    for (const id of ['ws-1', 'Local', 'local2', '']) {
      expect(() => storage.forWorkspace(asWorkspaceId(id))).toThrow(/only workspace 'local'/)
    }
    // No workspace is built in: a state directory first asked for another holds that one.
    const other = new LocalBlobStorage({ stateDir })
    expect(other.forWorkspace(asWorkspaceId('ws-1'))).toBe(
      other.forWorkspace(asWorkspaceId('ws-1')),
    )
    expect(() => other.forWorkspace(WORKSPACE)).toThrow(/only workspace 'ws-1'/)
  })

  it('keeps a key at the same relative path under the state directory', async () => {
    const store = localStore()
    await store.put(blobKey('artifacts/POD-1/art_1/site/index.html'), bytes('<p>hi</p>'))
    expect(await readFile(join(stateDir, 'artifacts/POD-1/art_1/site/index.html'), 'utf8')).toBe(
      '<p>hi</p>',
    )
    await writeFile(join(stateDir, 'artifacts/POD-1/art_1/site/existing.css'), 'b{}')
    expect(
      await bodyText(await store.get(blobKey('artifacts/POD-1/art_1/site/existing.css'))),
    ).toBe('b{}')
  })

  it('treats a directory as no object', async () => {
    const store = localStore()
    await store.put(blobKey('dir/child'), bytes('x'))
    expect(await store.get(blobKey('dir'))).toBeUndefined()
    expect(await store.head(blobKey('dir'))).toBeUndefined()
    expect(await store.get(blobKey('dir/child/below'))).toBeUndefined()
  })
})

describe('local puts', () => {
  it('fsyncs the file and the directory on a durable put (the default)', async () => {
    const store = localStore()
    const sync = await spyOnSync()
    await store.put(blobKey('d/x'), bytes('durable'))
    expect(sync).toHaveBeenCalledTimes(2)
    sync.mockClear()
    await store.put(blobKey('d/y'), bytes('durable'), { durable: true })
    expect(sync).toHaveBeenCalledTimes(2)
    sync.mockClear()
    await store.copy(blobKey('d/x'), blobKey('d/z'))
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('skips every fsync on a non-durable put and still replaces atomically', async () => {
    const store = localStore()
    const sync = await spyOnSync()
    await store.put(blobKey('n/x'), bytes('first'), { durable: false })
    await store.put(blobKey('n/x'), bytes('second'), { durable: false })
    await store.copy(blobKey('n/x'), blobKey('n/y'), { durable: false })
    expect(sync).not.toHaveBeenCalled()
    expect(await readFile(join(stateDir, 'n/x'), 'utf8')).toBe('second')
    expect(await filesUnder(join(stateDir, 'n'))).toEqual(['x', 'y'])
  })

  it('fsyncs the directory after a durable delete (the default), not after a relaxed one', async () => {
    const store = localStore()
    await store.put(blobKey('r/x'), bytes('x'), { durable: false })
    await store.put(blobKey('r/y'), bytes('y'), { durable: false })
    const sync = await spyOnSync()
    await store.delete(blobKey('r/x'))
    expect(sync).toHaveBeenCalledTimes(1)
    sync.mockClear()
    await store.delete(blobKey('r/y'), { durable: false })
    await store.delete(blobKey('r/never'))
    expect(sync).not.toHaveBeenCalled()
    expect(await filesUnder(join(stateDir, 'r'))).toEqual([])
  })

  it('removes the directories a delete leaves empty, never the root directory', async () => {
    const store = localStore()
    await store.put(blobKey('artifacts/iss/a1/img/x.png'), bytes('x'))
    await store.put(blobKey('artifacts/iss/a1/index.html'), bytes('i'))
    await store.put(blobKey('artifacts/iss/a2/y.md'), bytes('y'))
    await store.delete(blobKey('artifacts/iss/a1/img/x.png'))
    // `img` is empty and goes; `a1` still holds index.html and stays.
    expect(await readdir(join(stateDir, 'artifacts/iss/a1'))).toEqual(['index.html'])
    await store.delete(blobKey('artifacts/iss/a1/index.html'))
    expect(await readdir(join(stateDir, 'artifacts/iss'))).toEqual(['a2'])
    await store.delete(blobKey('artifacts/iss/a2/y.md'))
    // Everything below the root is gone; the root itself stays.
    expect(await readdir(join(stateDir, 'artifacts'))).toEqual([])
    // A put into a removed directory makes it again; a one-segment key is fine too.
    await store.put(blobKey('artifacts/iss/a3/z.md'), bytes('z'))
    expect(await bodyText(await store.get(blobKey('artifacts/iss/a3/z.md')))).toBe('z')
    await store.put(blobKey('top'), bytes('t'))
    await store.delete(blobKey('top'))
    expect(await readdir(stateDir)).toEqual(['artifacts'])
  })

  it('keeps a put racing the delete of its directory', async () => {
    const store = localStore()
    for (let i = 0; i < 20; i += 1) {
      await store.put(blobKey(`artifacts/race/${i}/a`), bytes('a'))
      await Promise.all([
        store.delete(blobKey(`artifacts/race/${i}/a`)),
        store.put(blobKey(`artifacts/race/${i}/b`), bytes('b')),
      ])
      expect(await bodyText(await store.get(blobKey(`artifacts/race/${i}/b`)))).toBe('b')
    }
  })

  it('makes a new inode on every put and uses inode, size and mtime as the etag', async () => {
    const store = localStore()
    const first = await store.put(blobKey('e/x'), bytes('same'))
    const inode1 = (await stat(join(stateDir, 'e/x'))).ino
    const second = await store.put(blobKey('e/x'), bytes('same'))
    const stats = await stat(join(stateDir, 'e/x'), { bigint: true })
    expect(stats.ino).not.toBe(BigInt(inode1))
    expect(second.etag).not.toBe(first.etag)
    expect(second.etag).toBe(
      `${stats.ino.toString(36)}-${stats.size.toString(36)}-${stats.mtimeNs.toString(36)}`,
    )
  })

  it('refuses ifMatch after a write outside the store', async () => {
    const store = localStore()
    const put = await store.put(blobKey('e/y'), bytes('v1'))
    await writeFile(join(stateDir, 'e/y'), 'edited in place')
    await expect(
      store.put(blobKey('e/y'), bytes('v2'), { ifMatch: put.etag }),
    ).rejects.toBeInstanceOf(BlobConditionFailed)
    expect(await readFile(join(stateDir, 'e/y'), 'utf8')).toBe('edited in place')
  })

  it('leaves no temp file behind after a refused condition or a failed body', async () => {
    const store = localStore()
    await store.put(blobKey('t/x'), bytes('v1'))
    await expect(store.put(blobKey('t/x'), bytes('v2'), { ifAbsent: true })).rejects.toBeInstanceOf(
      BlobConditionFailed,
    )
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('partial'))
        controller.error(new Error('upstream broke'))
      },
    })
    await expect(store.put(blobKey('t/x'), failing)).rejects.toThrow('upstream broke')
    expect(await filesUnder(join(stateDir, 't'))).toEqual(['x'])
    expect(await readFile(join(stateDir, 't/x'), 'utf8')).toBe('v1')
  })

  it('serves a read that started before a replace from the old bytes', async () => {
    const store = localStore()
    await store.put(blobKey('r/x'), bytes('old bytes'))
    const reading = await store.get(blobKey('r/x'))
    await store.put(blobKey('r/x'), bytes('new bytes, longer'))
    expect(reading?.size).toBe(9)
    expect(await bodyText(reading)).toBe('old bytes')
    expect(await bodyText(await store.get(blobKey('r/x')))).toBe('new bytes, longer')
  })

  it('closes the descriptor when a read is cancelled', async () => {
    const store = localStore()
    await store.put(blobKey('r/big'), new Uint8Array(512 * 1024))
    const got = await store.get(blobKey('r/big'))
    if (got === undefined) throw new Error('missing r/big')
    const reader = got.body.getReader()
    await reader.read()
    await reader.cancel()
    await store.delete(blobKey('r/big'))
    expect(await store.head(blobKey('r/big'))).toBeUndefined()
  })
})

describe('local temp files', () => {
  it('removes leftover temp files under the key roots at boot, and nothing else', async () => {
    const leftovers = [
      `artifacts/POD-1/art/${TEMP}`,
      `transcripts/m/n/000001/${TEMP_2}`,
      `pending-uploads/${TEMP}`,
    ]
    const kept = [
      'artifacts/POD-1/art/index.html',
      'artifacts/POD-1/art/.tmp-not-a-uuid',
      `other-root/${TEMP}`,
      `state.db`,
    ]
    for (const path of [...leftovers, ...kept]) {
      await mkdir(join(stateDir, path, '..'), { recursive: true })
      await writeFile(join(stateDir, path), 'x')
    }
    const storage = new LocalBlobStorage({ stateDir })
    expect(await storage.removeLeftoverTempFiles()).toBe(3)
    expect(await filesUnder(stateDir)).toEqual([...kept].sort())
    expect(await storage.removeLeftoverTempFiles()).toBe(0)
  })

  it('walks only the roots it is given', async () => {
    await mkdir(join(stateDir, 'artifacts'), { recursive: true })
    await mkdir(join(stateDir, 'custom'), { recursive: true })
    await writeFile(join(stateDir, 'artifacts', TEMP), 'x')
    await writeFile(join(stateDir, 'custom', TEMP), 'x')
    expect(
      await new LocalBlobStorage({ stateDir, roots: ['custom'] }).removeLeftoverTempFiles(),
    ).toBe(1)
    expect(await filesUnder(stateDir)).toEqual([`artifacts/${TEMP}`])
  })

  it('never lists a temp file or a name that is not a key segment', async () => {
    const store = localStore()
    await store.put(blobKey('artifacts/a/x'), bytes('x'))
    await writeFile(join(stateDir, 'artifacts/a', TEMP), 'in flight')
    await writeFile(join(stateDir, 'artifacts/a', 'has space'), 'stray')
    expect(await listKeys(store, blobKey('artifacts'))).toEqual(['artifacts/a/x'])
  })
})

describe('local transfer fence', () => {
  function countingFence() {
    let held = false
    const fence = {
      writers: 0,
      hold() {
        held = true
      },
      async runWriter<T>(writer: () => Promise<T>): Promise<T> {
        if (held) throw new Error('portable state is fenced for server transfer')
        fence.writers += 1
        return writer()
      },
    }
    return fence
  }

  it('runs every write inside the fence and no read', async () => {
    const fence = countingFence()
    const storage = new LocalBlobStorage({ stateDir, fence })
    const store = storage.forWorkspace(WORKSPACE)
    await store.put(blobKey('artifacts/f/x'), bytes('x'))
    await store.copy(blobKey('artifacts/f/x'), blobKey('artifacts/f/y'))
    await store.delete(blobKey('artifacts/f/y'))
    await storage.removeLeftoverTempFiles()
    expect(fence.writers).toBe(4)
    await store.get(blobKey('artifacts/f/x')).then((got) => got?.body.cancel())
    await store.head(blobKey('artifacts/f/x'))
    await listKeys(store, blobKey('artifacts'))
    expect(fence.writers).toBe(4)
  })

  it('refuses writes while the fence is held and leaves the files untouched', async () => {
    const fence = countingFence()
    const storage = new LocalBlobStorage({ stateDir, fence })
    const store = storage.forWorkspace(WORKSPACE)
    await store.put(blobKey('artifacts/f/x'), bytes('before'))
    await mkdir(join(stateDir, 'transcripts'), { recursive: true })
    await writeFile(join(stateDir, 'transcripts', TEMP), 'x')
    fence.hold()
    await expect(store.put(blobKey('artifacts/f/x'), bytes('after'))).rejects.toThrow(/fenced/)
    await expect(store.put(blobKey('artifacts/f/new'), bytes('new'))).rejects.toThrow(/fenced/)
    await expect(store.copy(blobKey('artifacts/f/x'), blobKey('artifacts/f/y'))).rejects.toThrow(
      /fenced/,
    )
    await expect(store.delete(blobKey('artifacts/f/x'))).rejects.toThrow(/fenced/)
    await expect(storage.removeLeftoverTempFiles()).rejects.toThrow(/fenced/)
    expect(await filesUnder(stateDir)).toEqual(['artifacts/f/x', `transcripts/${TEMP}`])
    expect(await readFile(join(stateDir, 'artifacts/f/x'), 'utf8')).toBe('before')
    expect(await bodyText(await store.get(blobKey('artifacts/f/x')))).toBe('before')
  })
})
