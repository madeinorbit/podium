import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import fixtures from '../adapters/opencode/fixtures/archives.json'
import {
  OPENCODE_FIXTURE_BINARY,
  opencodeTarFixture,
} from '../adapters/opencode/install.test-support.js'
import { extractReleaseFile, releaseArchiveMember } from './release-archive.js'

describe('Release archive members', () => {
  it('writes just the fixed destination and refuses existing files, links and unsafe outputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-archive-'))
    try {
      const archive = join(root, 'vendor.tar.gz')
      writeFileSync(archive, opencodeTarFixture())
      await extractReleaseFile(archive, 'tar.gz', 'opencode', root, 'managed-binary')
      expect(readFileSync(join(root, 'managed-binary'), 'utf8')).toBe(OPENCODE_FIXTURE_BINARY)
      await expect(
        extractReleaseFile(archive, 'tar.gz', 'opencode', root, 'managed-binary'),
      ).rejects.toThrow()
      writeFileSync(join(root, 'personal'), 'unchanged')
      symlinkSync('personal', join(root, 'linked'))
      await expect(
        extractReleaseFile(archive, 'tar.gz', 'opencode', root, 'linked'),
      ).rejects.toThrow()
      expect(readFileSync(join(root, 'personal'), 'utf8')).toBe('unchanged')
      for (const output of ['../outside', '/absolute', 'C:\\outside', 'bin/nested', '.', '']) {
        await expect(
          extractReleaseFile(archive, 'tar.gz', 'opencode', root, output),
        ).rejects.toThrow()
      }
      expect(readdirSync(root).sort()).toEqual([
        'linked',
        'managed-binary',
        'personal',
        'vendor.tar.gz',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads the measured top-level tar member', async () => {
    const binary = await releaseArchiveMember(opencodeTarFixture(), 'tar.gz', 'opencode')
    expect(binary.toString()).toBe(OPENCODE_FIXTURE_BINARY)
  })

  it.each(['../escape', '/opencode', 'bin/opencode'])('refuses a tar path %s', async (path) => {
    await expect(
      releaseArchiveMember(opencodeTarFixture(path), 'tar.gz', 'opencode'),
    ).rejects.toThrow('regular member')
  })

  it.each(['1', '2', '5'])('refuses tar links and directories (type %s)', async (type) => {
    await expect(
      releaseArchiveMember(opencodeTarFixture('opencode', 'target', type), 'tar.gz', 'opencode'),
    ).rejects.toThrow('regular member')
  })

  it('refuses a truncated tar member or a second member', async () => {
    const tar = gunzipSync(opencodeTarFixture())
    await expect(
      releaseArchiveMember(gzipSync(tar.subarray(0, 520)), 'tar.gz', 'opencode'),
    ).rejects.toThrow('regular member')
    const duplicate = Buffer.concat([tar.subarray(0, 1024), tar])
    await expect(releaseArchiveMember(gzipSync(duplicate), 'tar.gz', 'opencode')).rejects.toThrow(
      'regular member',
    )
  })

  it.each(Object.entries(fixtures))('reads a standard ZIP fixture: %s', async (name, base64) => {
    const executable = name.startsWith('opencode.exe-') ? 'opencode.exe' : 'opencode'
    const binary = await releaseArchiveMember(Buffer.from(base64, 'base64'), 'zip', executable)
    expect(binary.toString()).toBe(OPENCODE_FIXTURE_BINARY)
  })

  it('reads a named tar member without extracting other safe members', async () => {
    const other = gunzipSync(opencodeTarFixture('assets/readme', 'companion asset'))
    const binary = gunzipSync(opencodeTarFixture())
    const combined = gzipSync(Buffer.concat([other.subarray(0, 1024), binary]))
    expect((await releaseArchiveMember(combined, 'tar.gz', 'opencode')).toString()).toBe(
      OPENCODE_FIXTURE_BINARY,
    )
  })

  it('refuses an oversized tar entry before allocating its body', async () => {
    const tar = gunzipSync(opencodeTarFixture())
    tar.write(`${(513 * 1024 * 1024).toString(8).padStart(11, '0')}\0`, 124)
    tar.fill(32, 148, 156)
    const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0)
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    await expect(releaseArchiveMember(gzipSync(tar), 'tar.gz', 'opencode')).rejects.toThrow(
      'oversized',
    )
  })

  it.each([
    [
      'traversal name',
      (zip: Buffer, central: number) => {
        zip.write('../other', 30)
        zip.write('../other', central + 46)
      },
    ],
    [
      'symbolic link',
      (zip: Buffer, central: number) => {
        zip.writeUInt32LE(0o120777 * 65536, central + 38)
      },
    ],
    [
      'encrypted member',
      (zip: Buffer, central: number) => {
        zip.writeUInt16LE(1, central + 8)
      },
    ],
    [
      'missing local header',
      (zip: Buffer) => {
        zip.writeUInt32LE(0, 0)
      },
    ],
    [
      'invalid size',
      (zip: Buffer, central: number) => {
        zip.writeUInt32LE(0xffffffff, central + 20)
      },
    ],
    [
      'multiple members',
      (zip: Buffer) => {
        zip.writeUInt16LE(2, zip.length - 12)
      },
    ],
    [
      'oversized entry',
      (zip: Buffer, central: number) => {
        zip.writeUInt32LE(513 * 1024 * 1024, central + 24)
      },
    ],
  ] as const)('refuses ZIP %s', async (_name, corrupt) => {
    const zip = Buffer.from(fixtures['opencode-stored'], 'base64')
    const central = zip.readUInt32LE(zip.length - 6)
    corrupt(zip, central)
    await expect(releaseArchiveMember(zip, 'zip', 'opencode')).rejects.toThrow('regular member')
  })

  it('refuses a truncated ZIP', async () => {
    await expect(releaseArchiveMember(Buffer.from('no zip'), 'zip', 'opencode')).rejects.toThrow(
      'regular member',
    )
  })
})
