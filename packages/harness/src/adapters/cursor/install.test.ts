import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallLedger } from '../../inventory/install-ledger.js'
import { readInstallReceipt } from '../../inventory/install-receipt.js'
import { installRelease } from '../../inventory/managed-install.js'
import { declaredValue, type HarnessInstallPorts } from '../../manifest.js'
import { harnessHomeVariable } from '../../registry.js'
import { cursorManifest } from './index.js'
import { cursorManagedInstall } from './install.js'
import {
  CURSOR_FIXTURE_FILES,
  CURSOR_SOURCE,
  CURSOR_STABLE_RESPONSE,
  CURSOR_VERSION,
  cursorChecksumFixture,
  cursorTarFixture,
  cursorVendorFixture,
} from './install.test-support.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-cursor-install-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function ports(
  overrides: Partial<HarnessInstallPorts> = {},
  archive = cursorTarFixture(),
): HarnessInstallPorts {
  return {
    platform: 'linux',
    arch: 'x64',
    env: { HOME: '/decoy/home' },
    home: join(dir, 'home'),
    installerEnv: { HOME: join(dir, 'home'), PATH: '/usr/bin:/bin' },
    fetchText: vi.fn(async (url) =>
      url === 'https://cursor.com/install'
        ? CURSOR_STABLE_RESPONSE
        : cursorChecksumFixture(archive),
    ),
    fetch: vi.fn(async (_url, out) => {
      writeFileSync(out, archive)
    }),
    vendorUrl: (url) => url,
    run: vi.fn(async () => '12345678-1234-1234-1234-123456789abc\n'),
    runTool: vi.fn(async () => {
      throw new Error('must not execute the vendor installer or an extraction tool')
    }),
    isMusl: async () => false,
    ...overrides,
  }
}

describe('Cursor managed install', () => {
  it('reads the recorded production installer in one request without running it', async () => {
    const host = ports()
    await expect(cursorManagedInstall.latest(host)).resolves.toEqual({ version: CURSOR_VERSION })
    expect(host.fetchText).toHaveBeenCalledExactlyOnceWith('https://cursor.com/install')
    expect(host.fetch).not.toHaveBeenCalled()
    expect(host.run).not.toHaveBeenCalled()
    expect(host.runTool).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
    expect(declaredValue(cursorManifest.managedInstall)).toBe(cursorManagedInstall)
  })

  it.each([
    CURSOR_STABLE_RESPONSE.replaceAll(CURSOR_VERSION, `${CURSOR_VERSION}-beta`),
    CURSOR_STABLE_RESPONSE.replaceAll(CURSOR_VERSION, '../../escape'),
    CURSOR_STABLE_RESPONSE.replace('https://downloads.cursor.com/lab/', 'https://example.com/'),
    `${CURSOR_STABLE_RESPONSE}\n${CURSOR_STABLE_RESPONSE}`,
    '#!/bin/sh\nVERSION=preview\n',
  ])('refuses ambiguous, unstable or changed release pointers', async (text) => {
    const host = ports({ fetchText: vi.fn(async () => text) })
    await expect(cursorManagedInstall.latest(host)).rejects.toThrow()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it.each([
    '',
    '2026.11.19',
    `${CURSOR_VERSION}-rc.1`,
    '../escape',
    `${CURSOR_VERSION}/x`,
  ])('refuses an invalid requested version: %j', async (version) => {
    const host = ports()
    await expect(cursorManagedInstall.install({ version }, dir, host)).rejects.toThrow(
      'stable date-and-build version',
    )
    expect(host.fetchText).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['linux', 'x64', 'linux/x64'],
    ['linux', 'x86_64', 'linux/x64'],
    ['linux', 'amd64', 'linux/x64'],
    ['linux', 'arm64', 'linux/arm64'],
    ['linux', 'aarch64', 'linux/arm64'],
    ['darwin', 'x64', 'darwin/x64'],
    ['darwin', 'arm64', 'darwin/arm64'],
  ] as const)('keeps the complete %s/%s package and verifies its checksum', async (platform, arch, target) => {
    const host = ports({ platform, arch })
    const result = await cursorManagedInstall.install({ version: CURSOR_VERSION }, dir, host)
    const source = CURSOR_SOURCE.replace('linux/x64', target)
    expect(result).toEqual({
      executable: 'dist-package/cursor-agent',
      source,
      integrity: {
        kind: 'sha256',
        digest: createHash('sha256').update(cursorTarFixture()).digest('hex'),
      },
    })
    expect(host.fetchText).toHaveBeenCalledExactlyOnceWith(`${source}.sha256`)
    expect(host.fetch).toHaveBeenCalledExactlyOnceWith(source, join(dir, '.cursor-download'))
    for (const [path, body] of Object.entries(CURSOR_FIXTURE_FILES))
      expect(readFileSync(join(dir, path), 'utf8')).toBe(body)
    expect(statSync(join(dir, result.executable)).mode & 0o777).toBe(0o755)
    expect(host.run).toHaveBeenCalledExactlyOnceWith(
      join(dir, result.executable),
      ['--disable-auto-update', 'create-chat'],
      {
        ...host.installerEnv,
        CURSOR_CONFIG_DIR: join(host.home, '.cursor'),
        CURSOR_DATA_DIR: join(host.home, '.cursor-data'),
        NODE_COMPILE_CACHE: join(host.home, '.cache'),
      },
    )
    expect(readdirSync(dir)).toEqual(['dist-package'])
    expect(host.runTool).not.toHaveBeenCalled()
  })

  it.each([
    ['win32', 'x64', false],
    ['freebsd', 'x64', false],
    ['linux', 'ia32', false],
    ['linux', 'x64', true],
  ] as const)('refuses unsupported %s/%s (musl=%s) before fetching', async (platform, arch, musl) => {
    const host = ports({ platform, arch, isMusl: async () => musl })
    await expect(cursorManagedInstall.latest(host)).rejects.toThrow('no standalone release')
    await expect(
      cursorManagedInstall.install({ version: CURSOR_VERSION }, dir, host),
    ).rejects.toThrow('no standalone release')
    expect(host.fetchText).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('refuses a checksum mismatch before unpacking or running the package', async () => {
    const host = ports({
      fetchText: vi.fn(
        async () =>
          'a25986eaf0c9330aeeec599a139711cb9f267c64562d073a72b751edf5161695  agent-cli-package.tar.gz\n',
      ),
    })
    await expect(
      cursorManagedInstall.install({ version: CURSOR_VERSION }, dir, host),
    ).rejects.toThrow('checksum verification FAILED')
    expect(host.run).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    '',
    'invalid',
    `${'0'.repeat(64)}  wrong.tar.gz`,
    `${cursorChecksumFixture(cursorTarFixture())}${cursorChecksumFixture(cursorTarFixture())}`,
  ])('refuses a malformed checksum without downgrading integrity', async (checksum) => {
    const host = ports({ fetchText: vi.fn(async () => checksum) })
    await expect(
      cursorManagedInstall.install({ version: CURSOR_VERSION }, dir, host),
    ).rejects.toThrow('valid published SHA-256')
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('removes a partial download and propagates the vendor failure', async () => {
    const host = ports({
      fetch: vi.fn(async (_url, out) => {
        writeFileSync(out, 'partial')
        throw new Error('HTTP 503')
      }),
    })
    await expect(
      cursorManagedInstall.install({ version: CURSOR_VERSION }, dir, host),
    ).rejects.toThrow('HTTP 503')
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses a release whose updater guard cannot be verified', async () => {
    const host = ports({
      run: vi.fn(async () => {
        throw new Error('unknown option --disable-auto-update')
      }),
    })
    await expect(
      cursorManagedInstall.install({ version: CURSOR_VERSION }, dir, host),
    ).rejects.toThrow(
      'cannot be managed: its --disable-auto-update startup guard could not be verified',
    )
    expect(readdirSync(dir)).toEqual(['dist-package'])
  })

  it('rejects a removed guard even when the CLI would bypass unknown options for --help', async () => {
    const archive = cursorTarFixture({
      ...CURSOR_FIXTURE_FILES,
      'dist-package/cursor-agent':
        '#!/bin/sh\ncase "$*" in *--help*) echo "Cursor Agent"; exit 0;; esac\necho "unknown option --disable-auto-update" >&2\nexit 2\n',
    })
    const host = ports(
      {
        run: async (cmd, args, env) => {
          const result = await promisify(execFile)(cmd, [...args], { env })
          return result.stdout
        },
      },
      archive,
    )
    await expect(
      cursorManagedInstall.install({ version: CURSOR_VERSION }, dir, host),
    ).rejects.toThrow('cannot be managed')
  })

  it('publishes a verified receipt without inventing a vendor publication time', async () => {
    const vendor = await cursorVendorFixture.start()
    const ledger = InstallLedger.open({ harnessesDir: join(dir, 'harnesses') })
    try {
      const result = await installRelease('cursor', {
        ledger,
        commandEnv: { HOME: join(dir, 'personal-home'), PATH: '/usr/bin:/bin' },
        vendorOrigins: vendor.origins,
        platform: 'linux',
        arch: 'x64',
      })
      expect(result).toMatchObject({ outcome: 'installed', version: CURSOR_VERSION })
      if (result.outcome !== 'installed') throw new Error(JSON.stringify(result))
      const read = readInstallReceipt(result.dir)
      expect(read).toMatchObject({
        ok: true,
        receipt: {
          harness: 'cursor',
          executable: 'dist-package/cursor-agent',
          integrity: {
            kind: 'sha256',
            digest: createHash('sha256').update(cursorTarFixture()).digest('hex'),
          },
        },
      })
      if (!read.ok) throw new Error(read.error)
      expect(read.receipt.integrity).not.toHaveProperty('publishedAt')
    } finally {
      ledger.close()
      await vendor.stop()
    }
  })

  it('leaves the no-home-variable admission rule to the shared request layer', () => {
    expect(harnessHomeVariable('cursor')).toBeUndefined()
  })
})
