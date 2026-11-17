import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keySegment, LOCAL_WORKSPACE_ID } from '@podium/blob-store'
import { LocalBlobStorage } from '@podium/blob-store/local'
import { asArtifactId, asIssueId, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PendingUploadStore } from '../modules/issues/pending-uploads'
import type { SessionStore } from '../store'
import { artifactStoreOnDisk } from '../test-support/artifact-store'
import { openTestStore } from '../test-support/open-test-store'
import {
  ARTIFACT_KEY_CONVERSION_MARKER,
  convertArtifactKeys,
  convertPendingUploadRecords,
  PENDING_UPLOAD_RECORDS_MARKER,
} from './artifact-key-conversion'

/**
 * ARTIFACT NAMES BECOME BLOB KEYS (POD-7054). Artifacts stored on a self-hosted disk before
 * the blob store under names outside the key alphabet are renamed to their encoded keys once
 * at boot, and are served again.
 */

const ISSUE = asIssueId('iss_1')
const ART = asArtifactId('a1')

let state: string
let warnings: string[]
const log = {
  info() {},
  warn(message: string) {
    warnings.push(message)
  },
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'podium-artifact-keys-'))
  warnings = []
})
afterEach(() => rmSync(state, { recursive: true, force: true }))

/** Write a member as the pre-blob store did: at its raw relpath under the artifact dir. */
function legacyMember(rel: string, bytes = rel): string {
  const path = join(state, 'artifacts', ISSUE, ART, ...rel.split('/'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

const store = () =>
  artifactStoreOnDisk(state, {
    readAsset: async () => ({ ok: false, error: 'unused' }),
    listDir: async () => ({ ok: false, path: '', entries: [], error: 'unused' }),
  })

const served = async (rel: string) => {
  const found = await store().readStream(ISSUE, ART, rel)
  return found ? await new Response(found.body).text() : null
}

describe('convertArtifactKeys', () => {
  it('leaves plain names alone and converts names with spaces and non-ASCII', async () => {
    legacyMember('index.html')
    legacyMember('img/shot-1.png')
    legacyMember('Screen Shot 1.png')
    legacyMember('résumé.pdf')
    legacyMember('my folder/a b.png')
    expect(await served('Screen Shot 1.png')).toBeNull()

    const result = await convertArtifactKeys({ stateDir: state, log })

    expect(result).toMatchObject({ ran: true, renamed: 4, unencodable: [], conflicts: [] })
    const dir = join(state, 'artifacts', ISSUE, ART)
    expect(readdirSync(dir).sort()).toEqual(
      [
        'img',
        'index.html',
        keySegment('Screen Shot 1.png'),
        keySegment('résumé.pdf'),
        keySegment('my folder'),
      ].sort(),
    )
    for (const rel of [
      'index.html',
      'img/shot-1.png',
      'Screen Shot 1.png',
      'résumé.pdf',
      'my folder/a b.png',
    ]) {
      expect(await served(rel)).toBe(rel)
    }
  })

  it('runs once: the marker skips the walk on later boots', async () => {
    legacyMember('a b.txt')
    expect((await convertArtifactKeys({ stateDir: state, log })).ran).toBe(true)
    expect(existsSync(join(state, ARTIFACT_KEY_CONVERSION_MARKER))).toBe(true)
    legacyMember('c d.txt')
    expect(await convertArtifactKeys({ stateDir: state, log })).toMatchObject({
      ran: false,
      renamed: 0,
    })
    expect(await served('c d.txt')).toBeNull()
  })

  it('resumes after a crash between two renames', async () => {
    // A crash after the child's rename and before its directory's: the child already has its
    // encoded name, the directory not yet, and no marker was written.
    const dir = join(state, 'artifacts', ISSUE, ART, 'my folder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, keySegment('a b.png')), 'my folder/a b.png')
    // A file whose copy reached its target before the crash: the same bytes at both names.
    legacyMember('x y.txt')
    writeFileSync(join(state, 'artifacts', ISSUE, ART, keySegment('x y.txt')), 'x y.txt')

    const result = await convertArtifactKeys({ stateDir: state, log })

    expect(result).toMatchObject({ renamed: 2, conflicts: [] })
    expect(await served('my folder/a b.png')).toBe('my folder/a b.png')
    expect(await served('x y.txt')).toBe('x y.txt')
    expect(readdirSync(join(state, 'artifacts', ISSUE, ART)).sort()).toEqual(
      [keySegment('my folder'), keySegment('x y.txt')].sort(),
    )
  })

  it('keeps both when a different entry already holds the encoded name', async () => {
    legacyMember('x y.txt', 'old')
    writeFileSync(join(state, 'artifacts', ISSUE, ART, keySegment('x y.txt')), 'new')
    const result = await convertArtifactKeys({ stateDir: state, log })
    expect(result.conflicts).toEqual([join(state, 'artifacts', ISSUE, ART, 'x y.txt')])
    expect(await served('x y.txt')).toBe('new')
    expect(warnings).toHaveLength(1)
  })

  it('leaves a name too long to encode in place, logged, unreadable, and boots', async () => {
    const long = `${'é'.repeat(100)}.png`
    const path = legacyMember(long)
    legacyMember('a b.txt')

    const result = await convertArtifactKeys({ stateDir: state, log })

    expect(result).toMatchObject({ ran: true, renamed: 1, unencodable: [path] })
    expect(existsSync(path)).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(await served(long)).toBeNull()
    expect(await served('a b.txt')).toBe('a b.txt')
    // New uploads under such a name are refused by name.
    await expect(
      store().upload({ issueId: ISSUE, filename: long, dataBase64: 'UE5H' }),
    ).rejects.toThrow(`artifact member ${long} has a name too long to store`)
  })

  it('removes staging in the old layout, keeps chunk staging, and skips temp files', async () => {
    const uploads = join(state, 'artifacts', '.uploads')
    // An unpublished upload the old code staged: meta.json and files/ under the upload dir.
    const legacy = join(uploads, ISSUE, 'u-old')
    mkdirSync(join(legacy, 'files', 'sub dir'), { recursive: true })
    writeFileSync(join(legacy, 'meta.json'), '{"action":"begin"}')
    writeFileSync(join(legacy, 'files', 'sub dir', 'a b.md'), 'x')
    // One with only its files/ left, under an issue that holds nothing else.
    const lone = join(uploads, 'iss_2', 'u-lone')
    mkdirSync(join(lone, 'files'), { recursive: true })
    // An upload in the chunk layout, staged since the upgrade: untouched.
    const chunk = join(uploads, ISSUE, 'u-new', '0000', '000000000000')
    mkdirSync(join(chunk, '..'), { recursive: true })
    writeFileSync(chunk, 'x')
    const temp = join(state, 'artifacts', ISSUE, ART, '.tmp-0a1b2c3d-0000-4000-8000-000000000000')
    mkdirSync(join(temp, '..'), { recursive: true })
    writeFileSync(temp, 'partial')

    const result = await convertArtifactKeys({ stateDir: state, log })

    expect(result).toMatchObject({ renamed: 0, legacyUploadsRemoved: 2 })
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(join(uploads, 'iss_2'))).toBe(false)
    expect(existsSync(chunk)).toBe(true)
    expect(existsSync(temp)).toBe(true)
  })

  it('does nothing on a state directory with no artifacts', async () => {
    expect(await convertArtifactKeys({ stateDir: state, log })).toMatchObject({
      ran: true,
      renamed: 0,
    })
  })
})

/**
 * COMPOSER UPLOAD RECORDS LEAVE meta.json (POD-7055). Each upload the pre-blob store held
 * becomes a `pending_uploads` row, its bytes stay where the blob key finds them, and the old
 * store's leftovers go.
 */
describe('convertPendingUploadRecords', () => {
  const UNCLAIMED = '11111111-1111-4111-8111-111111111111'
  const CLAIMED = '22222222-2222-4222-8222-222222222222'
  const SPACED = '33333333-3333-4333-8333-333333333333'
  const BROKEN = '44444444-4444-4444-8444-444444444444'

  let db: SessionStore
  beforeEach(async () => {
    db = await openTestStore(':memory:')
  })
  afterEach(async () => {
    await db.close()
  })

  /** Write an upload as the pre-blob store did: meta.json beside file/<entry>. */
  function legacyUpload(id: string, entry: string, extra: Record<string, unknown> = {}): string {
    const dir = join(state, 'pending-uploads', id)
    mkdirSync(join(dir, 'file'), { recursive: true })
    writeFileSync(join(dir, 'file', entry), `bytes of ${entry}`)
    const meta = {
      id,
      ownerUserId: 'user:alice',
      filename: entry,
      entry,
      mediaType: 'image/png',
      size: 3,
      createdAt: 5_000,
      ...extra,
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
    return dir
  }

  const pendingStore = () =>
    new PendingUploadStore({
      files: new LocalBlobStorage({ stateDir: state }).forWorkspace(LOCAL_WORKSPACE_ID),
      records: db.pendingUploads,
    })

  it('records each upload, claim included, and finds its bytes at the key', async () => {
    legacyUpload(UNCLAIMED, 'shot.png')
    const claimedDir = legacyUpload(CLAIMED, 'b.png', {
      claimed: { issueId: 'iss_1', artifactId: 'a1' },
    })
    // A claimed upload's file was moved into the artifact store already.
    rmSync(join(claimedDir, 'file'), { recursive: true })
    legacyUpload(SPACED, 'Screen Shot 1.png')

    const result = await convertPendingUploadRecords({
      stateDir: state,
      records: db.pendingUploads,
      log,
    })

    expect(result).toEqual({ ran: true, recorded: 3, removed: 0 })
    const pending = pendingStore()
    const unclaimed = await pending.meta(UNCLAIMED)
    expect(unclaimed).toEqual({
      id: UNCLAIMED,
      ownerUserId: 'user:alice',
      filename: 'shot.png',
      entry: 'shot.png',
      mediaType: 'image/png',
      size: 3,
      createdAt: 5_000,
    })
    expect(Buffer.from((await pending.bytes(unclaimed!))!).toString()).toBe('bytes of shot.png')
    expect((await pending.claimedBy(ISSUE)).map((m) => m.id)).toEqual([CLAIMED])
    const spaced = await pending.meta(SPACED)
    expect(Buffer.from((await pending.bytes(spaced!))!).toString()).toBe(
      'bytes of Screen Shot 1.png',
    )
    expect(readdirSync(join(state, 'pending-uploads', SPACED, 'file'))).toEqual([
      keySegment('Screen Shot 1.png'),
    ])
    for (const id of [UNCLAIMED, CLAIMED, SPACED]) {
      expect(existsSync(join(state, 'pending-uploads', id, 'meta.json'))).toBe(false)
    }
    expect(existsSync(join(state, PENDING_UPLOAD_RECORDS_MARKER))).toBe(true)
  })

  it('removes uploads with no record that can be kept, and the old store’s leftovers', async () => {
    const kept = legacyUpload(UNCLAIMED, 'shot.png')
    writeFileSync(join(kept, 'meta.json.0a1b2c3d-0000-4000-8000-000000000000.tmp'), '{')
    mkdirSync(join(kept, 'file.relinquish-0a1b2c3d-0000-4000-8000-000000000000'))
    const noMeta = join(state, 'pending-uploads', CLAIMED)
    mkdirSync(join(noMeta, 'file'), { recursive: true })
    writeFileSync(join(noMeta, 'file', 'x.png'), 'x')
    const broken = legacyUpload(BROKEN, 'y.png')
    writeFileSync(join(broken, 'meta.json'), '{not json')
    const tooLong = legacyUpload(SPACED, `${'é'.repeat(100)}.png`)

    const result = await convertPendingUploadRecords({
      stateDir: state,
      records: db.pendingUploads,
      log,
    })

    expect(result).toEqual({ ran: true, recorded: 1, removed: 3 })
    expect(readdirSync(kept)).toEqual(['file'])
    for (const dir of [noMeta, broken, tooLong]) expect(existsSync(dir)).toBe(false)
    expect(await db.pendingUploads.createdBefore(Number.MAX_SAFE_INTEGER, 10)).toEqual([
      { id: UNCLAIMED, entry: 'shot.png' },
    ])
  })

  it('finishes a conversion that stopped between the row and the meta.json removal, once', async () => {
    const dir = legacyUpload(UNCLAIMED, 'Screen Shot 1.png')
    // The first run renamed the file and wrote the row, then died.
    renameSync(
      join(dir, 'file', 'Screen Shot 1.png'),
      join(dir, 'file', keySegment('Screen Shot 1.png')),
    )
    await db.pendingUploads.insert({
      id: UNCLAIMED,
      ownerUserId: asUserId('user:alice'),
      filename: 'Screen Shot 1.png',
      entry: 'Screen Shot 1.png',
      mediaType: 'image/png',
      size: 3,
      createdAt: 5_000,
    })

    const options = { stateDir: state, records: db.pendingUploads, log }
    expect(await convertPendingUploadRecords(options)).toEqual({
      ran: true,
      recorded: 1,
      removed: 0,
    })
    expect(existsSync(join(dir, 'meta.json'))).toBe(false)
    const meta = await pendingStore().meta(UNCLAIMED)
    expect(Buffer.from((await pendingStore().bytes(meta!))!).toString()).toBe(
      'bytes of Screen Shot 1.png',
    )
    // The marker skips later boots.
    expect(await convertPendingUploadRecords(options)).toEqual({
      ran: false,
      recorded: 0,
      removed: 0,
    })
  })
})
