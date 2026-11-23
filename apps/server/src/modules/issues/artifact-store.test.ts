import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BlobKey, type BlobStore, blobKey } from '@podium/blob-store'
import { LocalBlobStorage } from '@podium/blob-store/local'
import { MemoryBlobStorage } from '@podium/blob-store/memory'
import {
  ARTIFACT_FILE_CAP_BYTES,
  ARTIFACT_FILE_COUNT_CAP,
  ARTIFACT_UPLOAD_CHUNK_BYTES,
  type ArtifactUploadPacket,
  asArtifactId,
  asIssueId,
  type IssueId,
  joinMachinePath,
} from '@podium/model'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
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

/** One member through `readStream`, collected: the store streams, it has no whole-file read. */
async function readWhole(
  store: IssueArtifactStore,
  ...args: Parameters<IssueArtifactStore['readStream']>
): Promise<{ bytes: Buffer; contentType: string; size: number } | null> {
  const found = await store.readStream(...args)
  if (!found) return null
  const bytes = Buffer.from(await new Response(found.body).arrayBuffer())
  return { bytes, contentType: found.contentType, size: found.size }
}

async function keysUnder(files: BlobStore, prefix: string): Promise<string[]> {
  const keys: string[] = []
  for await (const entry of files.list(blobKey(prefix))) keys.push(entry.key)
  return keys
}

async function bytesAt(files: BlobStore, key: string): Promise<Buffer | undefined> {
  const stored = await files.get(blobKey(key))
  return stored ? Buffer.from(await new Response(stored.body).arrayBuffer()) : undefined
}

const chunk = (uploadId: string, file: string, offset: number, bytes: Buffer) =>
  ({
    action: 'chunk',
    uploadId,
    file,
    offset,
    dataBase64: bytes.toString('base64'),
  }) as const satisfies ArtifactUploadPacket

/** Send every packet of one member, in order. */
async function sendMember(
  store: IssueArtifactStore,
  issueId: IssueId,
  uploadId: string,
  file: string,
  bytes: Buffer,
): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += ARTIFACT_UPLOAD_CHUNK_BYTES) {
    const packet = chunk(
      uploadId,
      file,
      offset,
      bytes.subarray(offset, offset + ARTIFACT_UPLOAD_CHUNK_BYTES),
    )
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
}

let db: SessionStore
beforeAll(async () => {
  db = await openTestStore(':memory:')
})
afterAll(async () => {
  await db.close()
})

/**
 * The same suite on both kinds of blob store: the state directory a
 * self-hosted server uses, and an in-memory bucket with object-store semantics.
 */
describe.each([
  ['local disk', 'local'],
  ['object store', 'memory'],
] as const)('IssueArtifactStore on %s', (_label, backend) => {
  let base: string
  let files: BlobStore
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'podium-artifacts-'))
    files =
      backend === 'local'
        ? new LocalBlobStorage({ stateDir: base }).forWorkspace(SELF_HOSTED_WORKSPACE_ID)
        : new MemoryBlobStorage().forWorkspace(SELF_HOSTED_WORKSPACE_ID)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const make = (rpc: ArtifactRpc = fakeRpc({}), over: { files?: BlobStore } = {}) =>
    new IssueArtifactStore({ files: over.files ?? files, uploads: db.artifactUploads, rpc })

  describe('snapshot, upload, read and remove', () => {
    it('snapshots a single file at its basename and reads it back, whole and ranged', async () => {
      const store = make(fakeRpc({ '/wt/shots/a.png': Buffer.from('PNG') }))
      const snap = await store.snapshot({
        issueId: asIssueId('iss_1'),
        root: '/wt',
        sourcePath: 'shots/a.png',
      })
      expect(snap.entry).toBe('a.png')
      expect(snap.files).toEqual([{ path: 'a.png', size: 3 }])
      expect(await keysUnder(files, `artifacts/iss_1/${snap.artifactId}`)).toEqual([
        `artifacts/iss_1/${snap.artifactId}/a.png`,
      ])
      const r = await readWhole(store, asIssueId('iss_1'), snap.artifactId, 'a.png')
      expect(r?.bytes.toString()).toBe('PNG')
      expect(r?.contentType).toBe('image/png')
      expect(r?.size).toBe(3)
      const slice = await readWhole(store, asIssueId('iss_1'), snap.artifactId, 'a.png', {
        offset: 1,
        length: 1,
      })
      expect(slice?.bytes.toString()).toBe('N')
      expect(slice?.size).toBe(3)
    })

    it('streams a member with a range clipped to it', async () => {
      const store = make(fakeRpc({ '/wt/a.txt': Buffer.from('abcdef') }))
      const snap = await store.snapshot({
        issueId: asIssueId('iss_1'),
        root: '/wt',
        sourcePath: 'a.txt',
      })
      const streamed = await store.readStream(asIssueId('iss_1'), snap.artifactId, 'a.txt', {
        offset: 4,
        length: 10,
      })
      expect(streamed).toMatchObject({ size: 6, contentType: 'text/plain; charset=utf-8' })
      expect(await new Response(streamed!.body).text()).toBe('ef')
      const past = await store.readStream(asIssueId('iss_1'), snap.artifactId, 'a.txt', {
        offset: 6,
        length: 1,
      })
      expect(past?.size).toBe(6)
      expect(await new Response(past!.body).text()).toBe('')
      expect(await store.readStream(asIssueId('iss_1'), snap.artifactId, 'b.txt')).toBeNull()
    })

    it.each([
      '/wt',
      'C:\\wt',
      '\\\\nas\\share\\wt',
    ])('machine paths: snapshots remote files and directories under %s', async (root) => {
      const path = joinMachinePath(root, 'shots', 'a.png')
      const dir = joinMachinePath(root, 'shots')
      const store = make(
        fakeRpc({ [path]: Buffer.from('PNG') }, { [dir]: [{ name: 'a.png', isDir: false }] }),
      )
      const single = await store.snapshot({ issueId: asIssueId('iss_1'), root, sourcePath: path })
      expect(single.entry).toBe('a.png')
      expect(single.files).toEqual([{ path: 'a.png', size: 3 }])
      const folder = await store.snapshot({
        issueId: asIssueId('iss_1'),
        root,
        sourcePath: 'shots',
      })
      expect(folder.files).toEqual([{ path: 'a.png', size: 3 }])
      expect(
        (await readWhole(store, asIssueId('iss_1'), folder.artifactId, 'a.png'))?.bytes.toString(),
      ).toBe('PNG')
    })

    it('stores browser bytes directly without a daemon source file', async () => {
      const store = make()
      const snap = await store.upload({
        issueId: asIssueId('iss_1'),
        filename: 'mock.png',
        dataBase64: Buffer.from('PNG').toString('base64'),
      })
      expect(snap).toMatchObject({ entry: 'mock.png', files: [{ path: 'mock.png', size: 3 }] })
      expect(
        (await readWhole(store, asIssueId('iss_1'), snap.artifactId, 'mock.png'))?.bytes.toString(),
      ).toBe('PNG')
    })

    it('keeps a plain member name as its key and encodes any other name', async () => {
      const store = make()
      const snap = await store.upload({
        issueId: asIssueId('iss_1'),
        filename: 'Screen Shot 1.png',
        dataBase64: Buffer.from('PNG').toString('base64'),
      })
      const [key] = await keysUnder(files, `artifacts/iss_1/${snap.artifactId}`)
      expect(key).toMatch(new RegExp(`^artifacts/iss_1/${snap.artifactId}/~[a-z2-7]+$`))
      expect(
        (await readWhole(store, asIssueId('iss_1'), snap.artifactId, 'Screen Shot 1.png'))?.bytes,
      ).toEqual(Buffer.from('PNG'))
    })

    it('rejects a direct-upload filename that could escape its artifact', async () => {
      const store = make()
      await expect(
        store.upload({ issueId: asIssueId('iss_1'), filename: '../mock.png', dataBase64: 'UE5H' }),
      ).rejects.toThrow(/plain filename/)
      expect(await keysUnder(files, 'artifacts/iss_1')).toEqual([])
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
      const store = make(rpc)
      const snap = await store.snapshot({
        issueId: asIssueId('iss_1'),
        root: '/wt',
        sourcePath: 'big.bin',
      })
      expect(calls.length).toBe(3)
      expect(snap.files[0]?.size).toBe(big.length)
      const r = await readWhole(store, asIssueId('iss_1'), snap.artifactId, 'big.bin')
      expect(r?.bytes.equals(big)).toBe(true)
    })

    it('snapshots a directory as a bundle, preserving relpaths; entry = the HTML file', async () => {
      const store = make(
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
        (
          await readWhole(store, asIssueId('iss_1'), snap.artifactId, 'img/x.png')
        )?.bytes.toString(),
      ).toBe('X')
    })

    it('errors the op naming the file when a pull fails — nothing left stored', async () => {
      const store = make(fakeRpc({ '/wt/a.txt': Buffer.from('A') }))
      await expect(
        store.snapshot({
          issueId: asIssueId('iss_1'),
          root: '/wt',
          sourcePath: 'a.txt',
          extraPaths: ['gone.png'],
        }),
      ).rejects.toThrow(/gone\.png/)
      expect(await keysUnder(files, 'artifacts/iss_1')).toEqual([])
    })

    it('a keyed snapshot replaces what a crashed run of the same record left', async () => {
      const store = make(fakeRpc({ '/wt/a.txt': Buffer.from('A') }))
      const id = asArtifactId('keyed1')
      await files.put(blobKey('artifacts/iss_1/keyed1/leftover.txt'), Buffer.from('old'))
      await store.snapshot({
        issueId: asIssueId('iss_1'),
        root: '/wt',
        sourcePath: 'a.txt',
        artifactId: id,
      })
      expect(await keysUnder(files, 'artifacts/iss_1/keyed1')).toEqual([
        'artifacts/iss_1/keyed1/a.txt',
      ])
    })

    it('enforces the per-file cap', async () => {
      const rpc = fakeRpc({ '/wt/huge.bin': Buffer.from('x') })
      // Lie about the size so the test does not allocate 100MB.
      rpc.readAsset = async () => ({
        ok: true,
        dataBase64: Buffer.from('x').toString('base64'),
        size: ARTIFACT_FILE_CAP_BYTES + 1,
      })
      const store = make(rpc)
      await expect(
        store.snapshot({ issueId: asIssueId('iss_1'), root: '/wt', sourcePath: 'huge.bin' }),
      ).rejects.toThrow(/per-file cap/)
      expect(await keysUnder(files, 'artifacts/iss_1')).toEqual([])
    })

    it.each([
      'C:/shot.png',
      String.raw`\a\b.png`,
      String.raw`\\a\b.png`,
    ])('machine paths: snapshots literal POSIX relative filename %s', async (sourcePath) => {
      const store = make(fakeRpc({ ['/wt/' + sourcePath]: Buffer.from('PNG') }))
      const snap = await store.snapshot({ issueId: asIssueId('iss_1'), root: '/wt', sourcePath })
      expect(snap.entry).toBe(sourcePath === 'C:/shot.png' ? 'shot.png' : sourcePath)
      expect(
        (await readWhole(store, asIssueId('iss_1'), snap.artifactId, snap.entry))?.bytes.toString(),
      ).toBe('PNG')
    })

    it('machine paths: walks a POSIX directory whose name begins with a drive-like token', async () => {
      const store = make(
        fakeRpc(
          { '/wt/C:/shots/a.png': Buffer.from('PNG') },
          { '/wt/C:/shots': [{ name: 'a.png', isDir: false }] },
        ),
      )
      const snap = await store.snapshot({
        issueId: asIssueId('iss_1'),
        root: '/wt',
        sourcePath: 'C:/shots',
      })
      expect(snap.sourcePaths).toEqual(['C:/shots/a.png'])
      expect(snap.files).toEqual([{ path: 'a.png', size: 3 }])
    })

    it('enforces the bundle file-count cap during the walk', async () => {
      const entries = Array.from({ length: ARTIFACT_FILE_COUNT_CAP + 1 }, (_, i) => ({
        name: `f${i}.txt`,
        isDir: false,
      }))
      const store = make(fakeRpc({}, { '/wt/d': entries }))
      await expect(
        store.snapshot({ issueId: asIssueId('iss_1'), root: '/wt', sourcePath: 'd' }),
      ).rejects.toThrow(/exceeds 200 files/)
    })

    it('read() guards path traversal and bad ids', async () => {
      const store = make(fakeRpc({ '/wt/a.txt': Buffer.from('A') }))
      const snap = await store.snapshot({
        issueId: asIssueId('iss_1'),
        root: '/wt',
        sourcePath: 'a.txt',
      })
      await files.put(blobKey('artifacts/secret.txt'), Buffer.from('top'))
      await files.put(blobKey('artifacts/iss_1/secret.txt'), Buffer.from('top'))
      expect(
        await readWhole(store, asIssueId('iss_1'), snap.artifactId, '../../secret.txt'),
      ).toBeNull()
      expect(
        await readWhole(store, asIssueId('iss_1'), snap.artifactId, '../secret.txt'),
      ).toBeNull()
      expect(await readWhole(store, asIssueId('..'), snap.artifactId, 'a.txt')).toBeNull()
      expect(await readWhole(store, asIssueId('.'), asArtifactId('.'), 'secret.txt')).toBeNull()
      expect(
        await readWhole(store, asIssueId('iss_1'), asArtifactId('../iss_1'), 'a.txt'),
      ).toBeNull()
      expect(await readWhole(store, asIssueId('iss_1'), snap.artifactId, 'missing.txt')).toBeNull()
      expect(await readWhole(store, asIssueId('iss_1'), snap.artifactId, '')).toBeNull()
      expect(await readWhole(store, asIssueId('iss_1'), snap.artifactId, 'a//a.txt')).toBeNull()
      // Staging is not an issue.
      expect(await readWhole(store, asIssueId('.uploads'), asArtifactId('iss_1'), 'x')).toBeNull()
    })

    it('remove() deletes one snapshot; removeIssue() deletes every snapshot and upload', async () => {
      const store = make(fakeRpc({ '/wt/a.txt': Buffer.from('A') }))
      const issueId = asIssueId('iss_remove')
      const s1 = await store.snapshot({ issueId, root: '/wt', sourcePath: 'a.txt' })
      const s2 = await store.snapshot({ issueId, root: '/wt', sourcePath: 'a.txt' })
      expect(s1.artifactId).not.toBe(s2.artifactId)
      await store.remove(issueId, s1.artifactId)
      expect(await readWhole(store, issueId, s1.artifactId, 'a.txt')).toBeNull()
      expect((await readWhole(store, issueId, s2.artifactId, 'a.txt'))?.bytes.toString()).toBe('A')
      const uploadId = randomUUID()
      await store.transfer(issueId, {
        action: 'begin',
        uploadId,
        path: 'unfinished',
        entry: 'a.txt',
        files: [{ path: 'a.txt', size: 2 }],
      })
      await store.transfer(issueId, chunk(uploadId, 'a.txt', 0, Buffer.from('a')))
      await store.removeIssue(issueId)
      expect(await keysUnder(files, `artifacts/${issueId}`)).toEqual([])
      expect(await keysUnder(files, `artifacts/.uploads/${issueId}`)).toEqual([])
      expect(await db.artifactUploads.get(issueId, uploadId)).toBeUndefined()
    })

    it('the stored copy survives source deletion (snapshot, not live-read)', async () => {
      const source = { '/wt/a.txt': Buffer.from('kept') }
      const store = make(fakeRpc(source))
      const snap = await store.snapshot({
        issueId: asIssueId('iss_1'),
        root: '/wt',
        sourcePath: 'a.txt',
      })
      delete (source as Record<string, Buffer>)['/wt/a.txt']
      expect(
        (await readWhole(store, asIssueId('iss_1'), snap.artifactId, 'a.txt'))?.bytes.toString(),
      ).toBe('kept')
      // On a self-hosted disk the key is today's path under the state directory.
      if (backend === 'local') {
        expect(
          readFileSync(join(base, 'artifacts', 'iss_1', snap.artifactId, 'a.txt'), 'utf8'),
        ).toBe('kept')
      }
    })

    it('adopts a pending chat upload by copy, and relinquishes it back', async () => {
      const store = make()
      const issueId = asIssueId('iss_chat')
      const from = blobKey('pending-uploads/p1/file/shot-one.png')
      await files.put(from, Buffer.from('PNG'))
      const args = { issueId, artifactId: asArtifactId('chat1'), entry: 'shot one.png' }
      const adopted = await store.adopt({ ...args, from })
      expect(adopted.files).toEqual([{ path: 'shot one.png', size: 3 }])
      expect(await files.head(from)).toBeUndefined()
      // A retried claim finds the artifact in place.
      expect((await store.adopt({ ...args, from })).files).toEqual(adopted.files)
      expect((await readWhole(store, issueId, args.artifactId, 'shot one.png'))?.bytes).toEqual(
        Buffer.from('PNG'),
      )
      await store.relinquish({ ...args, to: from })
      expect(await bytesAt(files, from)).toEqual(Buffer.from('PNG'))
      expect(await keysUnder(files, `artifacts/${issueId}`)).toEqual([])
      // Nothing to move a second time.
      await store.relinquish({ ...args, to: from })
      expect(await bytesAt(files, from)).toEqual(Buffer.from('PNG'))
    })

    it('finishes a claim or a release that crashed after its copy', async () => {
      const store = make()
      const issueId = asIssueId('iss_chat')
      const from = blobKey('pending-uploads/p2/file/shot.png')
      const args = { issueId, artifactId: asArtifactId('chat2'), entry: 'shot.png' }
      const member = blobKey(`artifacts/${issueId}/chat2/shot.png`)
      // The claim copied, then crashed before deleting the source.
      await files.put(from, Buffer.from('PNG'))
      await files.copy(from, member)
      expect((await store.adopt({ ...args, from })).files).toEqual([{ path: 'shot.png', size: 3 }])
      expect(await files.head(from)).toBeUndefined()
      // The release copied back, then crashed before deleting the artifact.
      await files.copy(member, from)
      await store.relinquish({ ...args, to: from })
      expect(await bytesAt(files, from)).toEqual(Buffer.from('PNG'))
      expect(await keysUnder(files, `artifacts/${issueId}`)).toEqual([])
    })
  })

  describe('CLI bundle uploads', () => {
    const begin = (uploadId: string, members: { path: string; size: number }[], entry?: string) =>
      ({
        action: 'begin',
        uploadId,
        path: 'proposal',
        entry: entry ?? members[0]!.path,
        files: members,
      }) as const satisfies ArtifactUploadPacket

    it('stores each packet as a chunk object, keyed by member index and padded offset', async () => {
      const store = make()
      const issueId = asIssueId('iss_chunks')
      const uploadId = randomUUID()
      const bytes = Buffer.alloc(ARTIFACT_UPLOAD_CHUNK_BYTES + 7, 3)
      await store.transfer(
        issueId,
        begin(uploadId, [
          { path: 'index.html', size: 1 },
          { path: 'assets/shot.png', size: bytes.length },
        ]),
      )
      await sendMember(store, issueId, uploadId, 'index.html', Buffer.from('x'))
      await sendMember(store, issueId, uploadId, 'assets/shot.png', bytes)
      const staging = `artifacts/.uploads/${issueId}/${uploadId}`
      expect(await keysUnder(files, staging)).toEqual([
        `${staging}/0000/000000000000`,
        `${staging}/0001/000000000000`,
        `${staging}/0001/000000524288`,
      ])
      expect((await db.artifactUploads.get(issueId, uploadId))?.received).toEqual([1, bytes.length])
    })

    it('uploads a bundle in bounded chunks, checks replay and offsets, and publishes only complete bytes', async () => {
      const store = make()
      const issueId = asIssueId('iss_upload')
      const uploadId = randomUUID()
      const bytes = Buffer.alloc(ARTIFACT_UPLOAD_CHUNK_BYTES * 3 + 7, 9)
      await store.transfer(
        issueId,
        begin(
          uploadId,
          [
            { path: 'index.html', size: 1 },
            { path: 'assets/shot.png', size: bytes.length },
          ],
          'index.html',
        ),
      )
      // A retried or competing begin never resets the upload.
      await expect(
        store.transfer(issueId, begin(uploadId, [{ path: 'other.md', size: 1 }])),
      ).rejects.toThrow('already begun')
      const first = chunk(uploadId, 'index.html', 0, Buffer.from('x'))
      await store.transfer(issueId, first)
      await store.transfer(issueId, first)
      await expect(
        store.transfer(issueId, chunk(uploadId, 'index.html', 0, Buffer.from('y'))),
      ).rejects.toThrow('conflicts')
      await expect(store.transfer(issueId, { action: 'commit', uploadId })).rejects.toThrow(
        'upload incomplete',
      )
      await expect(
        store.transfer(asIssueId('iss_other'), { action: 'commit', uploadId }),
      ).rejects.toThrow()
      await sendMember(store, issueId, uploadId, 'assets/shot.png', bytes)
      const result = await store.transfer(issueId, { action: 'commit', uploadId })
      expect(result?.path).toBe('proposal')
      const artifactId = result!.snapshot.artifactId
      expect(
        (await readWhole(store, issueId, artifactId, 'assets/shot.png'))?.bytes.equals(bytes),
      ).toBe(true)
      expect((await readWhole(store, issueId, artifactId, 'index.html'))?.bytes.toString()).toBe(
        'x',
      )
      expect(await keysUnder(files, `artifacts/.uploads/${issueId}/${uploadId}`)).toEqual([])
      expect(await db.artifactUploads.get(issueId, uploadId)).toBeUndefined()
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
      const store = make()
      await expect(
        store.transfer(asIssueId('iss_1'), begin(randomUUID(), [{ path, size: 0 }])),
      ).rejects.toThrow('relative paths')
    })

    it('refuses a member whose name is too long to store', async () => {
      const store = make()
      const path = `${'é'.repeat(100)}.md`
      await expect(
        store.transfer(asIssueId('iss_1'), begin(randomUUID(), [{ path, size: 0 }])),
      ).rejects.toThrow('too long')
    })

    it('refuses gaps and excess bytes and expires or aborts unpublished uploads', async () => {
      const store = make()
      const issueId = asIssueId('iss_gaps')
      const uploadId = randomUUID()
      const packet = begin(uploadId, [{ path: 'report.md', size: 1 }])
      await store.transfer(issueId, packet)
      await expect(
        store.transfer(issueId, chunk(uploadId, 'report.md', 1, Buffer.from('x'))),
      ).rejects.toThrow('skips bytes')
      await expect(
        store.transfer(issueId, chunk(uploadId, 'report.md', 0, Buffer.from('xx'))),
      ).rejects.toThrow('declared size')
      await expect(
        store.transfer(issueId, chunk(uploadId, 'other.md', 0, Buffer.from('x'))),
      ).rejects.toThrow('unknown artifact member')
      await store.transfer(issueId, chunk(uploadId, 'report.md', 0, Buffer.from('x')))
      await store.transfer(issueId, { action: 'abort', uploadId })
      expect(await keysUnder(files, `artifacts/.uploads/${issueId}`)).toEqual([])
      expect(await db.artifactUploads.get(issueId, uploadId)).toBeUndefined()
      // An aborted upload can be begun again from nothing.
      await store.transfer(issueId, packet)
      expect((await db.artifactUploads.get(issueId, uploadId))?.received).toEqual([0])
    })

    it('a staged upload no record ever publishes is swept after a day, not before (POD-6420)', async () => {
      const store = make()
      const issueId = asIssueId('iss_sweep')
      const uploadId = randomUUID()
      // The client died after its bytes arrived: begun and chunked, never committed.
      await store.transfer(issueId, begin(uploadId, [{ path: 'report.md', size: 1 }]))
      await store.transfer(issueId, chunk(uploadId, 'report.md', 0, Buffer.from('x')))
      const staging = `artifacts/.uploads/${issueId}/${uploadId}`

      await store.sweepUploads(Date.now() + 23 * 60 * 60 * 1000)
      expect(await keysUnder(files, staging)).toHaveLength(1)
      expect(await db.artifactUploads.get(issueId, uploadId)).toBeDefined()
      await store.sweepUploads(Date.now() + 25 * 60 * 60 * 1000)
      expect(await keysUnder(files, staging)).toEqual([])
      expect(await db.artifactUploads.get(issueId, uploadId)).toBeUndefined()
      // A publish record arriving after the sweep finds nothing to publish.
      expect(await store.publishUpload(issueId, uploadId, asArtifactId('a1'))).toBeUndefined()
    })

    it('publishes a staged upload under the id it is given, replacing a crashed run', async () => {
      const store = make()
      const issueId = asIssueId('iss_keyed')
      const uploadId = randomUUID()
      await store.transfer(issueId, begin(uploadId, [{ path: 'r.md', size: 1 }]))
      await store.transfer(issueId, chunk(uploadId, 'r.md', 0, Buffer.from('x')))
      // What an earlier run of the same record left half-written.
      await files.put(blobKey(`artifacts/${issueId}/keyed1/stale.md`), Buffer.from('old'))

      const published = await store.publishUpload(issueId, uploadId, asArtifactId('keyed1'))

      expect(published).toMatchObject({ path: 'proposal', snapshot: { artifactId: 'keyed1' } })
      expect(await keysUnder(files, `artifacts/${issueId}/keyed1`)).toEqual([
        `artifacts/${issueId}/keyed1/r.md`,
      ])
      expect(
        (await readWhole(store, issueId, asArtifactId('keyed1'), 'r.md'))?.bytes.toString(),
      ).toBe('x')
      expect(await keysUnder(files, `artifacts/.uploads/${issueId}/${uploadId}`)).toEqual([])
    })

    it('composes members of every size, an empty one included, in key order', async () => {
      const store = make()
      const issueId = asIssueId('iss_compose')
      const uploadId = randomUUID()
      // Distinct bytes per chunk, so an out-of-order compose cannot pass.
      const big = Buffer.alloc(ARTIFACT_UPLOAD_CHUNK_BYTES * 12 + 5)
      for (let i = 0; i < big.length; i += 1) big[i] = Math.floor(i / ARTIFACT_UPLOAD_CHUNK_BYTES)
      await store.transfer(
        issueId,
        begin(
          uploadId,
          [
            { path: 'index.html', size: 4 },
            { path: 'empty.txt', size: 0 },
            { path: 'data/big file.bin', size: big.length },
          ],
          'index.html',
        ),
      )
      await sendMember(store, issueId, uploadId, 'index.html', Buffer.from('<h1>'))
      await sendMember(store, issueId, uploadId, 'data/big file.bin', big)
      const published = await store.publishUpload(issueId, uploadId, asArtifactId('composed'))
      expect(published?.snapshot.files).toEqual([
        { path: 'index.html', size: 4 },
        { path: 'empty.txt', size: 0 },
        { path: 'data/big file.bin', size: big.length },
      ])
      const id = asArtifactId('composed')
      expect((await readWhole(store, issueId, id, 'data/big file.bin'))?.bytes.equals(big)).toBe(
        true,
      )
      expect((await readWhole(store, issueId, id, 'empty.txt'))?.bytes.length).toBe(0)
      expect((await readWhole(store, issueId, id, 'index.html'))?.contentType).toBe(
        'text/html; charset=utf-8',
      )
    })

    it('a chunk missing at publish fails with "upload incomplete" and keeps the staging', async () => {
      const store = make()
      const issueId = asIssueId('iss_missing')
      const uploadId = randomUUID()
      const bytes = Buffer.alloc(ARTIFACT_UPLOAD_CHUNK_BYTES * 2 + 1, 5)
      await store.transfer(
        issueId,
        begin(uploadId, [
          { path: 'a.md', size: 2 },
          { path: 'b.bin', size: bytes.length },
        ]),
      )
      await sendMember(store, issueId, uploadId, 'a.md', Buffer.from('ok'))
      await sendMember(store, issueId, uploadId, 'b.bin', bytes)
      const staging = `artifacts/.uploads/${issueId}/${uploadId}`
      // The row says received; one chunk object is gone (a crash, a partial sweep).
      await files.delete(blobKey(`${staging}/0001/000000524288`))
      const before = await keysUnder(files, staging)

      await expect(store.publishUpload(issueId, uploadId, asArtifactId('half'))).rejects.toThrow(
        'upload incomplete',
      )

      expect(await keysUnder(files, staging)).toEqual(before)
      expect(await db.artifactUploads.get(issueId, uploadId)).toBeDefined()
      // Nothing is published half: not even the complete first member.
      expect(await keysUnder(files, `artifacts/${issueId}/half`)).toEqual([])
    })

    it('accepts a retried packet whose chunk was stored before its row advanced', async () => {
      const store = make()
      const issueId = asIssueId('iss_retry')
      const uploadId = randomUUID()
      await store.transfer(issueId, begin(uploadId, [{ path: 'r.md', size: 2 }]))
      // A crash between the chunk write and the conditional update.
      const key: BlobKey = blobKey(`artifacts/.uploads/${issueId}/${uploadId}/0000/000000000000`)
      await files.put(key, Buffer.from('ab'))
      await store.transfer(issueId, chunk(uploadId, 'r.md', 0, Buffer.from('ab')))
      expect((await db.artifactUploads.get(issueId, uploadId))?.received).toEqual([2])
      expect(await bytesAt(files, key)).toEqual(Buffer.from('ab'))

      // The same crash with different bytes is a conflict, and the stored bytes stay.
      const other = randomUUID()
      await store.transfer(issueId, begin(other, [{ path: 'r.md', size: 2 }]))
      const otherKey = blobKey(`artifacts/.uploads/${issueId}/${other}/0000/000000000000`)
      await files.put(otherKey, Buffer.from('ab'))
      await expect(
        store.transfer(issueId, chunk(other, 'r.md', 0, Buffer.from('zz'))),
      ).rejects.toThrow('conflicts')
      expect((await db.artifactUploads.get(issueId, other))?.received).toEqual([0])
      expect(await bytesAt(files, otherKey)).toEqual(Buffer.from('ab'))
    })

    it('orders packets two server processes receive for one upload through the database', async () => {
      // Two stores over the same blob store and rows: two processes, no shared lock.
      const one = make()
      const two = make()
      const issueId = asIssueId('iss_fleet')
      const uploadId = randomUUID()
      await one.transfer(
        issueId,
        begin(uploadId, [
          { path: 'a.md', size: 2 },
          { path: 'b.md', size: 2 },
        ]),
      )
      const a = chunk(uploadId, 'a.md', 0, Buffer.from('aa'))
      const b = chunk(uploadId, 'b.md', 0, Buffer.from('bb'))
      // The same packet twice, and packets of two members, all at once.
      await Promise.all([
        one.transfer(issueId, a),
        two.transfer(issueId, a),
        one.transfer(issueId, b),
        two.transfer(issueId, b),
      ])
      expect((await db.artifactUploads.get(issueId, uploadId))?.received).toEqual([2, 2])
      const published = await two.publishUpload(issueId, uploadId, asArtifactId('fleet'))
      expect(published?.snapshot.files).toHaveLength(2)
      expect((await readWhole(one, issueId, asArtifactId('fleet'), 'b.md'))?.bytes.toString()).toBe(
        'bb',
      )
    })
  })
})
