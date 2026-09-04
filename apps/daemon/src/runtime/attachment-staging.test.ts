import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runtimeAttachmentBelongsToSession,
  writeRuntimeAttachment,
} from './attachment-staging'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime attachment staging', () => {
  it('persists exact bytes in the existing per-session upload store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-attachment-'))
    roots.push(root)
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const staged = await writeRuntimeAttachment(root, {
      sessionId: asSessionId('session-attachment'),
      source: {
        bytes,
        filename: '../diagram.png',
        mediaType: 'image/png',
      },
    })

    expect(staged).toMatchObject({
      filename: 'diagram.png',
      mediaType: 'image/png',
      kind: 'image',
    })
    expect(staged.path.startsWith(join(root, 'uploads', 'session-attachment'))).toBe(true)
    expect(new Uint8Array(await readFile(staged.path))).toEqual(bytes)
    expect((await stat(staged.path)).mode & 0o777).toBe(0o600)
  })

  it('accepts only real files minted inside the sending session staging directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-attachment-authority-'))
    roots.push(root)
    const sessionId = asSessionId('session-owner')
    const staged = await writeRuntimeAttachment(root, {
      sessionId,
      source: {
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'notes.txt',
        mediaType: 'text/plain',
      },
    })

    expect(runtimeAttachmentBelongsToSession(root, sessionId, staged)).toBe(true)
    expect(runtimeAttachmentBelongsToSession(root, 'another-session', staged)).toBe(false)
    expect(
      runtimeAttachmentBelongsToSession(root, sessionId, {
        ...staged,
        id: 'id_rsa',
        path: '/home/victim/.ssh/id_rsa',
      }),
    ).toBe(false)

    const outside = join(root, 'outside-secret')
    await writeFile(outside, 'secret')
    const escapeId = 'symlink-escape'
    const escapePath = join(root, 'uploads', sessionId, `${escapeId}.bin`)
    await symlink(outside, escapePath)
    expect(
      runtimeAttachmentBelongsToSession(root, sessionId, {
        ...staged,
        id: escapeId,
        path: escapePath,
      }),
    ).toBe(false)
  })
})
