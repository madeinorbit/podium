import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keySegment } from '@podium/blob-store'
import { asArtifactId, asIssueId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { artifactStoreOnDisk } from '../test-support/artifact-store'
import { ARTIFACT_KEY_CONVERSION_MARKER, convertArtifactKeys } from './artifact-key-conversion'

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

const served = async (rel: string) =>
  (await store().read(ISSUE, ART, rel))?.bytes.toString() ?? null

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

  it('skips the upload staging and the local adapter temp files', async () => {
    const staging = join(state, 'artifacts', '.uploads', ISSUE, 'u1', 'files', 'a b.md')
    mkdirSync(join(staging, '..'), { recursive: true })
    writeFileSync(staging, 'x')
    const temp = join(state, 'artifacts', ISSUE, ART, '.tmp-0a1b2c3d-0000-4000-8000-000000000000')
    mkdirSync(join(temp, '..'), { recursive: true })
    writeFileSync(temp, 'partial')

    const result = await convertArtifactKeys({ stateDir: state, log })

    expect(result.renamed).toBe(0)
    expect(existsSync(staging)).toBe(true)
    expect(existsSync(temp)).toBe(true)
  })

  it('does nothing on a state directory with no artifacts', async () => {
    expect(await convertArtifactKeys({ stateDir: state, log })).toMatchObject({
      ran: true,
      renamed: 0,
    })
  })
})
