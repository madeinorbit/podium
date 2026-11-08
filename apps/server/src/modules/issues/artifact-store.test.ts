import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARTIFACT_FILE_CAP_BYTES,
  ARTIFACT_FILE_COUNT_CAP,
  ARTIFACT_UPLOAD_CHUNK_BYTES,
  asArtifactId,
  asIssueId,
  joinMachinePath,
} from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ArtifactRpc, IssueArtifactStore } from './artifact-store'

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
    const snap = await store.snapshot({
      issueId: asIssueId('iss_1'),
      root: '/wt',
      sourcePath: 'shots/a.png',
    })
    expect(snap.entry).toBe('a.png')
    expect(snap.files).toEqual([{ path: 'a.png', size: 3 }])
    const r = await store.read(asIssueId('iss_1'), snap.artifactId, 'a.png')
    expect(r?.bytes.toString()).toBe('PNG')
    expect(r?.contentType).toBe('image/png')
    expect(r?.size).toBe(3)
    const slice = await store.read(asIssueId('iss_1'), snap.artifactId, 'a.png', {
      offset: 1,
      length: 1,
    })
    expect(slice?.bytes.toString()).toBe('N')
    expect(slice?.size).toBe(3)
  })

  it.each([
    '/wt',
    'C:\\wt',
    '\\\\nas\\share\\wt',
  ])('machine paths: snapshots remote files and directories under %s', async (root) => {
    const path = joinMachinePath(root, 'shots', 'a.png')
    const dir = joinMachinePath(root, 'shots')
    const store = new IssueArtifactStore(
      base,
      fakeRpc({ [path]: Buffer.from('PNG') }, { [dir]: [{ name: 'a.png', isDir: false }] }),
    )
    const single = await store.snapshot({ issueId: asIssueId('iss_1'), root, sourcePath: path })
    expect(single.entry).toBe('a.png')
    expect(single.files).toEqual([{ path: 'a.png', size: 3 }])
    const folder = await store.snapshot({ issueId: asIssueId('iss_1'), root, sourcePath: 'shots' })
    expect(folder.files).toEqual([{ path: 'a.png', size: 3 }])
    expect(
      (await store.read(asIssueId('iss_1'), folder.artifactId, 'a.png'))?.bytes.toString(),
    ).toBe('PNG')
  })

  it('stores browser bytes directly without a daemon source file', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({}))
    const snap = await store.upload({
      issueId: asIssueId('iss_1'),
      filename: 'mock.png',
      dataBase64: Buffer.from('PNG').toString('base64'),
    })

    expect(snap).toMatchObject({ entry: 'mock.png', files: [{ path: 'mock.png', size: 3 }] })
    expect(
      (await store.read(asIssueId('iss_1'), snap.artifactId, 'mock.png'))?.bytes.toString(),
    ).toBe('PNG')
  })

  it('uploads a bundle in bounded chunks, checks replay and offsets, and publishes only complete bytes', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({}))
    const issueId = asIssueId('iss_upload')
    const uploadId = randomUUID()
    const bytes = Buffer.alloc(ARTIFACT_UPLOAD_CHUNK_BYTES * 3 + 7, 9)
    await store.transfer(issueId, {
      action: 'begin',
      uploadId,
      path: 'proposal',
      entry: 'index.html',
      files: [
        { path: 'index.html', size: 1 },
        { path: 'assets/shot.png', size: bytes.length },
      ],
    })
    const first = {
      action: 'chunk' as const,
      uploadId,
      file: 'index.html',
      offset: 0,
      dataBase64: 'eA==',
    }
    await store.transfer(issueId, first)
    await store.transfer(issueId, first)
    await expect(store.transfer(issueId, { ...first, dataBase64: 'eQ==' })).rejects.toThrow(
      'conflicts',
    )
    await expect(store.transfer(issueId, { action: 'commit', uploadId })).rejects.toThrow(
      'incomplete',
    )
    await expect(
      store.transfer(asIssueId('iss_other'), { action: 'commit', uploadId }),
    ).rejects.toThrow()
    expect(await store.read(issueId, asArtifactId(uploadId), 'index.html')).toBeNull()
    for (let offset = 0; offset < bytes.length; offset += ARTIFACT_UPLOAD_CHUNK_BYTES) {
      const packet = {
        action: 'chunk' as const,
        uploadId,
        file: 'assets/shot.png',
        offset,
        dataBase64: bytes.subarray(offset, offset + ARTIFACT_UPLOAD_CHUNK_BYTES).toString('base64'),
      }
      expect(
        Buffer.byteLength(
          JSON.stringify({
            router: 'issues',
            proc: 'panelApply',
            input: { id: issueId, op: 'artifact-upload', upload: packet },
          }),
        ),
      ).toBeLessThan(1024 * 1024)
      await store.transfer(issueId, packet)
    }
    const result = await store.transfer(issueId, { action: 'commit', uploadId })
    expect(result?.path).toBe('proposal')
    expect(
      (await store.read(issueId, result!.snapshot.artifactId, 'assets/shot.png'))?.bytes,
    ).toEqual(bytes)
    expect(existsSync(join(base, '.uploads', issueId, uploadId))).toBe(false)
  })

  it.each([
    '../secret',
    '/absolute',
    'nested/../../secret',
    'nested\\secret',
    'C:/secret',
    '.. /secret',
    'NUL.txt',
    'file:stream',
    'file\tname',
  ])('refuses unsafe upload member %s', async (path) => {
    const store = new IssueArtifactStore(base, fakeRpc({}))
    await expect(
      store.transfer(asIssueId('iss_1'), {
        action: 'begin',
        uploadId: randomUUID(),
        path: 'report',
        entry: path,
        files: [{ path, size: 0 }],
      }),
    ).rejects.toThrow('relative paths')
  })

  it('refuses gaps and excess bytes and expires or aborts unpublished uploads', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({}))
    const issueId = asIssueId('iss_1')
    const uploadId = randomUUID()
    const begin = {
      action: 'begin' as const,
      uploadId,
      path: 'report',
      entry: 'report.md',
      files: [{ path: 'report.md', size: 1 }],
    }
    await store.transfer(issueId, begin)
    expect(
      await store.read(asIssueId('.uploads'), asArtifactId(issueId), `${uploadId}/files/report.md`),
    ).toBeNull()
    await expect(
      store.transfer(issueId, {
        action: 'chunk',
        uploadId,
        file: 'report.md',
        offset: 1,
        dataBase64: 'eA==',
      }),
    ).rejects.toThrow('skips bytes')
    await expect(
      store.transfer(issueId, {
        action: 'chunk',
        uploadId,
        file: 'report.md',
        offset: 0,
        dataBase64: 'eHg=',
      }),
    ).rejects.toThrow('declared size')
    await store.transfer(issueId, { action: 'abort', uploadId })
    expect(existsSync(join(base, '.uploads', issueId, uploadId))).toBe(false)
    await store.transfer(issueId, begin)
    await store.sweepUploads(Date.now() + 25 * 60 * 60 * 1000)
    expect(existsSync(join(base, '.uploads', issueId, uploadId))).toBe(false)
  })

  it('a staged upload no record ever publishes is swept after a day, not before (POD-6420)', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({}))
    const issueId = asIssueId('iss_1')
    const uploadId = randomUUID()
    const staged = join(base, '.uploads', issueId, uploadId)
    // The client died after its bytes arrived: begun and chunked, never committed.
    await store.transfer(issueId, {
      action: 'begin',
      uploadId,
      path: 'report.md',
      entry: 'report.md',
      files: [{ path: 'report.md', size: 1 }],
    })
    await store.transfer(issueId, {
      action: 'chunk',
      uploadId,
      file: 'report.md',
      offset: 0,
      dataBase64: 'eA==',
    })

    await store.sweepUploads(Date.now() + 23 * 60 * 60 * 1000)
    expect(existsSync(staged)).toBe(true)
    await store.sweepUploads(Date.now() + 25 * 60 * 60 * 1000)
    expect(existsSync(staged)).toBe(false)
    // A publish record arriving after the sweep finds nothing to publish.
    expect(await store.publishUpload(issueId, uploadId, asArtifactId('a1'))).toBeUndefined()
  })

  it('publishes a staged upload under the id it is given, replacing a crashed run', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({}))
    const issueId = asIssueId('iss_1')
    const uploadId = randomUUID()
    await store.transfer(issueId, {
      action: 'begin',
      uploadId,
      path: 'r.md',
      entry: 'r.md',
      files: [{ path: 'r.md', size: 1 }],
    })
    await store.transfer(issueId, {
      action: 'chunk',
      uploadId,
      file: 'r.md',
      offset: 0,
      dataBase64: 'eA==',
    })

    const published = await store.publishUpload(issueId, uploadId, asArtifactId('keyed1'))

    expect(published).toMatchObject({ path: 'r.md', snapshot: { artifactId: 'keyed1' } })
    expect((await store.read(issueId, asArtifactId('keyed1'), 'r.md'))?.bytes.toString()).toBe('x')
    expect(existsSync(join(base, '.uploads', issueId, uploadId))).toBe(false)
  })

  it('rejects a direct-upload filename that could escape its artifact directory', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({}))
    await expect(
      store.upload({ issueId: asIssueId('iss_1'), filename: '../mock.png', dataBase64: 'UE5H' }),
    ).rejects.toThrow(/plain filename/)
    expect(existsSync(join(base, 'iss_1'))).toBe(false)
  })

  it('pulls large files chunk by chunk (multiple ranged round-trips)', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 7) // > 4MB chunk → 3 pulls
    const calls: Array<number | undefined> = []
    const rpc = fakeRpc({ '/wt/big.bin': big })
    const inner = rpc.readAsset.bind(rpc)
    rpc.readAsset = async (i) => {
      calls.push(i.offset)
      return await inner(i)
    }
    const store = new IssueArtifactStore(base, rpc)
    const snap = await store.snapshot({
      issueId: asIssueId('iss_1'),
      root: '/wt',
      sourcePath: 'big.bin',
    })
    expect(calls.length).toBe(3)
    expect(snap.files[0]?.size).toBe(big.length)
    const r = await store.read(asIssueId('iss_1'), snap.artifactId, 'big.bin')
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
    const snap = await store.snapshot({
      issueId: asIssueId('iss_1'),
      root: '/wt',
      sourcePath: 'report',
    })
    expect(snap.entry).toBe('index.html')
    expect(snap.files.map((f) => f.path).sort()).toEqual(['img/x.png', 'index.html'])
    expect(
      (await store.read(asIssueId('iss_1'), snap.artifactId, 'img/x.png'))?.bytes.toString(),
    ).toBe('X')
  })

  it('errors the op naming the file when a pull fails — nothing left on disk', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({}))
    await expect(
      store.snapshot({ issueId: asIssueId('iss_1'), root: '/wt', sourcePath: 'gone.png' }),
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
      store.snapshot({ issueId: asIssueId('iss_1'), root: '/wt', sourcePath: 'huge.bin' }),
    ).rejects.toThrow(/per-file cap/)
  })

  it.each([
    'C:/shot.png',
    String.raw`\a\b.png`,
    String.raw`\\a\b.png`,
  ])('machine paths: snapshots literal POSIX relative filename %s', async (sourcePath) => {
    const store = new IssueArtifactStore(
      base,
      fakeRpc({ ['/wt/' + sourcePath]: Buffer.from('PNG') }),
    )
    const snap = await store.snapshot({ issueId: asIssueId('iss_1'), root: '/wt', sourcePath })
    expect(snap.entry).toBe(sourcePath === 'C:/shot.png' ? 'shot.png' : sourcePath)
    expect(
      (await store.read(asIssueId('iss_1'), snap.artifactId, snap.entry))?.bytes.toString(),
    ).toBe('PNG')
  })

  it('machine paths: walks a POSIX directory whose name begins with a drive-like token', async () => {
    const root = '/wt'
    const sourcePath = 'C:/shots'
    const path = '/wt/C:/shots/a.png'
    const store = new IssueArtifactStore(
      base,
      fakeRpc(
        { [path]: Buffer.from('PNG') },
        { '/wt/C:/shots': [{ name: 'a.png', isDir: false }] },
      ),
    )
    const snap = await store.snapshot({ issueId: asIssueId('iss_1'), root, sourcePath })
    expect(snap.sourcePaths).toEqual(['C:/shots/a.png'])
    expect(snap.files).toEqual([{ path: 'a.png', size: 3 }])
  })

  it('enforces the bundle file-count cap during the walk', async () => {
    const entries = Array.from({ length: ARTIFACT_FILE_COUNT_CAP + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      isDir: false,
    }))
    const store = new IssueArtifactStore(base, fakeRpc({}, { '/wt/d': entries }))
    await expect(
      store.snapshot({ issueId: asIssueId('iss_1'), root: '/wt', sourcePath: 'd' }),
    ).rejects.toThrow(/exceeds 200 files/)
  })

  it('read() guards path traversal and bad ids', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({ '/wt/a.txt': Buffer.from('A') }))
    const snap = await store.snapshot({
      issueId: asIssueId('iss_1'),
      root: '/wt',
      sourcePath: 'a.txt',
    })
    writeFileSync(join(base, 'secret.txt'), 'top')
    expect(await store.read(asIssueId('iss_1'), snap.artifactId, '../../secret.txt')).toBeNull()
    expect(await store.read(asIssueId('..'), snap.artifactId, 'a.txt')).toBeNull()
    // dot ids must be rejected structurally: '.'/'.' would resolve to baseDir itself
    expect(await store.read(asIssueId('.'), asArtifactId('.'), 'secret.txt')).toBeNull()
    expect(await store.read(asIssueId('iss_1'), asArtifactId('../iss_1'), 'a.txt')).toBeNull()
    expect(await store.read(asIssueId('iss_1'), snap.artifactId, 'missing.txt')).toBeNull()
  })

  it('remove() deletes one snapshot dir; removeIssue() deletes them all', async () => {
    const store = new IssueArtifactStore(base, fakeRpc({ '/wt/a.txt': Buffer.from('A') }))
    const s1 = await store.snapshot({
      issueId: asIssueId('iss_1'),
      root: '/wt',
      sourcePath: 'a.txt',
    })
    const s2 = await store.snapshot({
      issueId: asIssueId('iss_1'),
      root: '/wt',
      sourcePath: 'a.txt',
    })
    expect(s1.artifactId).not.toBe(s2.artifactId)
    await store.remove(asIssueId('iss_1'), s1.artifactId)
    expect(await store.read(asIssueId('iss_1'), s1.artifactId, 'a.txt')).toBeNull()
    expect((await store.read(asIssueId('iss_1'), s2.artifactId, 'a.txt'))?.bytes.toString()).toBe(
      'A',
    )
    const uploadId = randomUUID()
    await store.transfer(asIssueId('iss_1'), {
      action: 'begin',
      uploadId,
      path: 'unfinished',
      entry: 'a.txt',
      files: [{ path: 'a.txt', size: 1 }],
    })
    await store.removeIssue(asIssueId('iss_1'))
    expect(existsSync(join(base, 'iss_1'))).toBe(false)
    expect(existsSync(join(base, '.uploads', 'iss_1'))).toBe(false)
  })

  it('the stored copy survives source deletion (snapshot, not live-read)', async () => {
    const files = { '/wt/a.txt': Buffer.from('kept') }
    const store = new IssueArtifactStore(base, fakeRpc(files))
    const snap = await store.snapshot({
      issueId: asIssueId('iss_1'),
      root: '/wt',
      sourcePath: 'a.txt',
    })
    delete (files as Record<string, Buffer>)['/wt/a.txt']
    expect((await store.read(asIssueId('iss_1'), snap.artifactId, 'a.txt'))?.bytes.toString()).toBe(
      'kept',
    )
    // and the bytes really are server-local
    expect(readFileSync(join(base, 'iss_1', snap.artifactId, 'a.txt'), 'utf8')).toBe('kept')
  })
})
