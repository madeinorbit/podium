import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import fixtures from '../adapters/opencode/fixtures/archives.json'
import {
  OPENCODE_FIXTURE_BINARY,
  opencodeTarFixture,
} from '../adapters/opencode/install.test-support.js'
import piZipFixtures from '../adapters/pi/fixtures/archives.json'
import { PI_FIXTURE_FILES, piTarFixture } from '../adapters/pi/install.test-support.js'
import {
  extractReleaseBundle,
  extractReleaseDirectory,
  extractReleaseFile,
  releaseArchiveMember,
} from './release-archive.js'

describe('Release archive bundles', () => {
  const member = (name: string, body: string, type = '0') =>
    gunzipSync(opencodeTarFixture(name, body, type)).subarray(0, -1024)
  const field = (key: string, value: string) => {
    const payload = `${key}=${value}\n`
    let count = Buffer.byteLength(payload) + 2
    while (Buffer.byteLength(`${count} ${payload}`) !== count)
      count = Buffer.byteLength(`${count} ${payload}`)
    return `${count} ${payload}`
  }
  const pax = (payload: string) => member('././@PaxHeader', payload, 'x')

  it('reads Codex PAX timestamps and validates a next-entry UTF-8 path override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-pax-'))
    try {
      const archive = join(root, 'download')
      const path = 'codex-resources/évidence.txt'
      writeFileSync(
        archive,
        gzipSync(
          Buffer.concat([
            pax(field('mtime', '1795200000.1234567')),
            member('bin/codex', 'binary'),
            pax(field('path', path) + field('mtime', '1795200000.1234567')),
            member('truncated', 'resource'),
            member('plain.txt', 'next entry has no override'),
            Buffer.alloc(1024),
          ]),
        ),
      )
      await extractReleaseBundle(archive, 'tar.gz', root, 'package')
      expect(readFileSync(join(root, 'package', path), 'utf8')).toBe('resource')
      expect(readFileSync(join(root, 'package/plain.txt'), 'utf8')).toBe(
        'next entry has no override',
      )
      expect(readdirSync(join(root, 'package'))).toEqual(['bin', 'codex-resources', 'plain.txt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses malformed, dangerous, duplicate and orphan PAX records before writing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-pax-'))
    try {
      const archive = join(root, 'download')
      const timestamp = field('mtime', '1795200000.1234567')
      const binary = member('bin/codex', 'binary')
      const bad = [
        ...['../escape', '/absolute', 'a/../../escape', 'C:\\escape'].map((name) =>
          Buffer.concat([pax(field('path', name)), binary]),
        ),
        Buffer.concat([pax(field('linkpath', 'elsewhere')), binary]),
        Buffer.concat([pax(field('size', '10000')), binary]),
        Buffer.concat([pax(field('GNU.sparse.name', 'elsewhere')), binary]),
        Buffer.concat([pax(timestamp + timestamp), binary]),
        Buffer.concat([pax(timestamp), pax(timestamp), binary]),
        Buffer.concat([pax('99 mtime=1\n'), binary]),
        Buffer.concat([pax('0 mtime=1\n'), binary]),
        Buffer.concat([pax('12 mtime=1'), binary]),
        Buffer.concat([pax(field('mtime', 'not-a-time')), binary]),
        Buffer.concat([pax(timestamp), member('bin/link', 'target', '2')]),
        Buffer.concat([binary, pax(field('path', 'bin/codex')), member('other', 'duplicate')]),
        pax(timestamp),
      ]
      for (const records of bad) {
        writeFileSync(archive, gzipSync(Buffer.concat([records, Buffer.alloc(1024)])))
        await expect(extractReleaseBundle(archive, 'tar.gz', root, 'package')).rejects.toThrow(
          'regular member',
        )
        expect(readdirSync(root)).toEqual(['download'])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps multiple archive roots in one fresh directory with executable helpers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-bundle-'))
    try {
      const archive = join(root, 'download')
      writeFileSync(
        archive,
        piTarFixture({
          'bin/codex': 'binary',
          'codex-path/rg': 'helper',
          'codex-package.json': '{}',
        }),
      )
      await extractReleaseBundle(archive, 'tar.gz', root, 'package')
      expect(readFileSync(join(root, 'package/codex-package.json'), 'utf8')).toBe('{}')
      expect(readFileSync(join(root, 'package/codex-path/rg'), 'utf8')).toBe('helper')
      expect(statSync(join(root, 'package/codex-path/rg')).mode & 0o111).toBe(0o111)
      await expect(extractReleaseBundle(archive, 'tar.gz', root, 'package')).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses links, traversal and duplicate names before writing the bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-bundle-'))
    try {
      const archive = join(root, 'download')
      const member = (name: string, type = '0') =>
        gunzipSync(opencodeTarFixture(name, 'bytes', type)).subarray(0, -1024)
      for (const bad of [
        member('../escape'),
        member('/absolute'),
        member('bin/link', '2'),
        member('bin/hardlink', '1'),
        member('bin/codex'),
      ]) {
        writeFileSync(
          archive,
          gzipSync(Buffer.concat([member('bin/codex'), bad, Buffer.alloc(1024)])),
        )
        await expect(extractReleaseBundle(archive, 'tar.gz', root, 'package')).rejects.toThrow(
          'regular member',
        )
        expect(readdirSync(root)).toEqual(['download'])
      }
      writeFileSync(archive, piTarFixture({ 'bin/codex': 'binary' }))
      symlinkSync(root, join(root, 'package'))
      await expect(extractReleaseBundle(archive, 'tar.gz', root, 'package')).rejects.toThrow()
      for (const name of ['../escape', '/absolute', 'nested/path'])
        await expect(extractReleaseBundle(archive, 'tar.gz', root, name)).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Release archive directories', () => {
  const longPath = `pi/${'long-directory/'.repeat(8)}resource.txt`
  const rawMember = (name: string, body: string, type = '0') =>
    gunzipSync(opencodeTarFixture(name, body, type)).subarray(0, -1024)
  const longRecord = (name: string) => rawMember('././@LongLink', `${name}\0`, 'L')

  it('keeps GNU long file and directory names as published by Cursor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-longnames-'))
    try {
      const archive = join(root, 'download')
      const directory = longPath.slice(0, longPath.lastIndexOf('/') + 1)
      writeFileSync(
        archive,
        gzipSync(
          Buffer.concat([
            longRecord(directory),
            rawMember(directory, '', '5'),
            longRecord(longPath),
            rawMember(longPath, 'native resource'),
            Buffer.alloc(1024),
          ]),
        ),
      )
      await extractReleaseDirectory(archive, 'tar.gz', 'pi', root)
      expect(readFileSync(join(root, longPath), 'utf8')).toBe('native resource')
      expect(
        (await releaseArchiveMember(readFileSync(archive), 'tar.gz', longPath)).toString(),
      ).toBe('native resource')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses unsafe, linked, duplicate, malformed and orphan GNU names before writing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-longnames-'))
    try {
      const archive = join(root, 'download')
      const good = rawMember('pi/pi', 'binary')
      const member = rawMember(longPath, 'native resource')
      const malicious = [
        ...[
          '../escape',
          'pi/../../escape',
          '/absolute',
          'pi//ambiguous',
          'C:\\outside',
          'other-root/resource',
        ].map((name) => Buffer.concat([longRecord(name), member])),
        Buffer.concat([longRecord('pi/pi'), rawMember('truncated', 'duplicate')]),
        Buffer.concat([longRecord(longPath), rawMember('truncated', '', '2')]),
        Buffer.concat([longRecord(longPath), rawMember('truncated', '', '1')]),
        Buffer.concat([longRecord(longPath), longRecord(longPath), member]),
        longRecord(longPath),
        Buffer.concat([rawMember('././@LongLink', longPath, 'L'), member]),
        Buffer.concat([longRecord('pi/one\0two'), member]),
        Buffer.concat([longRecord(`pi/${'a'.repeat(4096)}`), member]),
      ]
      for (const bad of malicious) {
        writeFileSync(archive, gzipSync(Buffer.concat([good, bad, Buffer.alloc(1024)])))
        await expect(extractReleaseDirectory(archive, 'tar.gz', 'pi', root)).rejects.toThrow(
          'regular member',
        )
        expect(readdirSync(root)).toEqual(['download'])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    'tar.gz',
    'zip',
  ] as const)('keeps the full %s bundle in a fresh directory', async (format) => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-tree-'))
    try {
      const archive = join(root, 'download')
      const bytes =
        format === 'tar.gz' ? piTarFixture() : Buffer.from(piZipFixtures.windows, 'base64')
      writeFileSync(archive, bytes)
      await extractReleaseDirectory(archive, format, 'pi', root)
      for (const [name, body] of Object.entries(PI_FIXTURE_FILES)) {
        const output = format === 'zip' && name === 'pi/pi' ? 'pi/pi.exe' : name
        expect(readFileSync(join(root, output), 'utf8')).toBe(body)
      }
      if (format === 'zip') expect(statSync(join(root, 'pi/package.json')).mode & 0o777).toBe(0o644)
      expect(statSync(join(root, format === 'zip' ? 'pi/pi.exe' : 'pi/pi')).mode & 0o777).toBe(
        0o755,
      )
      await expect(extractReleaseDirectory(archive, format, 'pi', root)).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps empty directories and resource files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-tree-'))
    try {
      const archive = join(root, 'download')
      const directory = gunzipSync(opencodeTarFixture('pi/empty/', '', '5')).subarray(0, -1024)
      const files = gunzipSync(piTarFixture({ ...PI_FIXTURE_FILES, 'pi/empty-file': '' }))
      writeFileSync(archive, gzipSync(Buffer.concat([directory, files])))
      await extractReleaseDirectory(archive, 'tar.gz', 'pi', root)
      expect(readdirSync(join(root, 'pi/empty'))).toEqual([])
      expect(readFileSync(join(root, 'pi/empty-file'))).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses unsafe entries, links and duplicates before writing the tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-tree-'))
    try {
      const archive = join(root, 'download')
      const good = gunzipSync(piTarFixture())
      const malicious = [
        ['../outside', '0'],
        ['pi/../../outside', '0'],
        ['pi//ambiguous', '0'],
        ['other-root/file', '0'],
        ['pi/link', '1'],
        ['pi/link', '2'],
        ['pi/pi', '0'],
      ]
      for (const [name, type] of malicious) {
        const entry = gunzipSync(opencodeTarFixture(name, 'malicious', type)).subarray(0, -1024)
        writeFileSync(
          archive,
          gzipSync(Buffer.concat([good.subarray(0, -1024), entry, Buffer.alloc(1024)])),
        )
        await expect(extractReleaseDirectory(archive, 'tar.gz', 'pi', root)).rejects.toThrow(
          'regular member',
        )
        expect(readdirSync(root)).toEqual(['download'])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a pre-existing directory symlink and unsafe destination roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-tree-'))
    try {
      const archive = join(root, 'download')
      writeFileSync(archive, piTarFixture())
      symlinkSync(root, join(root, 'pi'))
      await expect(extractReleaseDirectory(archive, 'tar.gz', 'pi', root)).rejects.toThrow()
      for (const member of ['../outside', '/absolute', 'bin/nested', '.', '', 'C:\\outside'])
        await expect(extractReleaseDirectory(archive, 'tar.gz', member, root)).rejects.toThrow()
      expect(readdirSync(root).sort()).toEqual(['download', 'pi'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

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
