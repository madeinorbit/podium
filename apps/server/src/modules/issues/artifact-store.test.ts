import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ARTIFACT_FILE_CAP_BYTES,
  ARTIFACT_FILE_COUNT_CAP,
  type ArtifactRpc,
  IssueArtifactStore,
} from './artifact-store'

/** Fake daemon: a flat map of absolute path → bytes, plus dir listings. */
function fakeRpc(
  files: Record<string, Buffer>,
  dirs: Record<string, { name: string; isDir: boolean }[]> = {},
): ArtifactRpc {
  return {
    async readAsset(input) {
      const buf = files[input.path]
      if (!buf) return { ok: false, error: 'not found' }
      const offset = input.offset ?? 0
      const length = input.length ?? buf.length
      return {
        ok: true,
        dataBase64: buf.subarray(offset, offset + length).toString('base64'),
        size: buf.length,
      }
    },
    async listDir(input) {
      const path = input.path ?? input.root
      const entries = dirs[path]
      if (!entries) return { ok: false, path, entries: [], error: 'not a directory' }
      return { ok: true, path, entries }
    },
  }
}

describe('IssueArtifactStore [spec:SP-0fc9]', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'podium-artifacts-'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('snapshots a single file at its basename and reads it back', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({ '/wt/shots/a.png': Buffer.from('PNG') }))
    const snap = await store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'shots/a.png' })
    expect(snap.entry).toBe('a.png')
    expect(snap.files).toEqual([{ path: 'a.png', size: 3 }])
    const r = await store.read('iss_1', snap.artifactId, 'a.png')
    expect(r?.bytes.toString()).toBe('PNG')
    expect(r?.contentType).toBe('image/png')
  })

  it('pulls large files chunk by chunk (multiple ranged round-trips)', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 7) // > 4MB chunk → 3 pulls
    const calls: Array<number | undefined> = []
    const rpc = fakeRpc({ '/wt/big.bin': big })
    const inner = rpc.readAsset.bind(rpc)
    rpc.readAsset = (i) => {
      calls.push(i.offset)
      return inner(i)
    }
    const store = new IssueArtifactStore(base, rpc)
    const snap = await store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'big.bin' })
    expect(calls.length).toBe(3)
    expect(snap.files[0]?.size).toBe(big.length)
    const r = await store.read('iss_1', snap.artifactId, 'big.bin')
    expect(r?.bytes.equals(big)).toBe(true)
  })

  it('snapshots a directory as a bundle, preserving relpaths; entry = the HTML file', async () => {
    const store = new IssueArtifactStore(
      base,
      fakeRpc(
        {
          '/wt/report/index.html': Buffer.from('<html>'),
          '/wt/report/img/x.png': Buffer.from('X'),
        },
        {
          '/wt/report': [
            { name: 'img', isDir: true },
            { name: 'index.html', isDir: false },
          ],
          '/wt/report/img': [{ name: 'x.png', isDir: false }],
        },
      ),
    )
    const snap = await store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'report' })
    expect(snap.entry).toBe('index.html')
    expect(snap.files.map((f) => f.path).sort()).toEqual(['img/x.png', 'index.html'])
    expect((await store.read('iss_1', snap.artifactId, 'img/x.png'))?.bytes.toString()).toBe('X')
  })

  it('errors the op naming the file when a pull fails — nothing left on disk', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({}))
    await expect(
      store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'gone.png' }),
    ).rejects.toThrow(/gone\.png/)
    expect(existsSync(join(base, 'iss_1'))).toBe(false)
  })

  it('enforces the per-file cap', async () => {
    const rpc = fakeRpc({ '/wt/huge.bin': Buffer.from('x') })
    // Lie about the size so the test does not allocate 100MB.
    rpc.readAsset = async () => ({
      ok: true,
      dataBase64: Buffer.from('x').toString('base64'),
      size: ARTIFACT_FILE_CAP_BYTES + 1,
    })
    const store = new IssueArtifactStore(base, rpc)
    await expect(
      store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'huge.bin' }),
    ).rejects.toThrow(/per-file cap/)
  })

  it('enforces the bundle file-count cap during the walk', async () => {
    const entries = Array.from({ length: ARTIFACT_FILE_COUNT_CAP + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      isDir: false,
    }))
    const store = new IssueArtifactStore(base, fakeRpc({}, { '/wt/d': entries }))
    await expect(
      store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'd' }),
    ).rejects.toThrow(/exceeds 200 files/)
  })

  it('read() guards path traversal and bad ids', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({ '/wt/a.txt': Buffer.from('A') }))
    const snap = await store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'a.txt' })
    writeFileSync(join(base, 'secret.txt'), 'top')
    expect(await store.read('iss_1', snap.artifactId, '../../secret.txt')).toBeNull()
    expect(await store.read('..', snap.artifactId, 'a.txt')).toBeNull()
    expect(await store.read('iss_1', '../iss_1', 'a.txt')).toBeNull()
    expect(await store.read('iss_1', snap.artifactId, 'missing.txt')).toBeNull()
  })

  it('remove() deletes one snapshot dir; removeIssue() deletes them all', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({ '/wt/a.txt': Buffer.from('A') }))
    const s1 = await store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'a.txt' })
    const s2 = await store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'a.txt' })
    expect(s1.artifactId).not.toBe(s2.artifactId)
    await store.remove('iss_1', s1.artifactId)
    expect(await store.read('iss_1', s1.artifactId, 'a.txt')).toBeNull()
    expect((await store.read('iss_1', s2.artifactId, 'a.txt'))?.bytes.toString()).toBe('A')
    await store.removeIssue('iss_1')
    expect(existsSync(join(base, 'iss_1'))).toBe(false)
  })

  it('the stored copy survives source deletion (snapshot, not live-read)', async () => {
    const files = { '/wt/a.txt': Buffer.from('kept') }
    const store = new IssueArtifactStore(base, fakeRpc(files))
    const snap = await store.snapshot({ issueId: 'iss_1', root: '/wt', sourcePath: 'a.txt' })
    delete (files as Record<string, Buffer>)['/wt/a.txt']
    expect((await store.read('iss_1', snap.artifactId, 'a.txt'))?.bytes.toString()).toBe('kept')
    // and the bytes really are server-local
    expect(readFileSync(join(base, 'iss_1', snap.artifactId, 'a.txt'), 'utf8')).toBe('kept')
  })
})
