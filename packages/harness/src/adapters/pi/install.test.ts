import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallLedger } from '../../inventory/install-ledger.js'
import { readInstallReceipt } from '../../inventory/install-receipt.js'
import { installRelease } from '../../inventory/managed-install.js'
import { managedInstallRefusal } from '../../inventory/requested-install.js'
import { declaredValue, type HarnessInstallPorts } from '../../manifest.js'
import { harnessHomeVariable } from '../../registry.js'
import zipFixtures from './fixtures/archives.json'
import { piManifest } from './index.js'
import { piManagedInstall } from './install.js'
import {
  PI_FIXTURE_BINARY,
  PI_FIXTURE_FILES,
  PI_STABLE_RESPONSE,
  PI_STANDALONE_RESPONSE,
  piChecksumFixture,
  piStandaloneFixture,
  piTarFixture,
  piVendorFixtureWithIntegrity,
} from './install.test-support.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-pi-install-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function ports(
  overrides: Partial<HarnessInstallPorts> = {},
  archive = piTarFixture(),
): HarnessInstallPorts {
  return {
    platform: 'linux',
    arch: 'x64',
    env: { HOME: '/decoy/home' },
    home: join(dir, 'home'),
    installerEnv: { HOME: join(dir, 'home') },
    fetchText: vi.fn(async (url) => {
      if (url === 'https://pi.dev/api/installer/releases/latest') return PI_STABLE_RESPONSE
      if (url.endsWith('/SHA256SUMS')) return piChecksumFixture(archive)
      return JSON.stringify(piStandaloneFixture(archive))
    }),
    fetch: vi.fn(async (_url, out) => {
      writeFileSync(out, archive)
    }),
    vendorUrl: (url) => url,
    run: vi.fn(async () => {
      throw new Error('must not run a program')
    }),
    runTool: vi.fn(async () => {
      throw new Error('must not run a vendor installer, Node, npm or an extraction tool')
    }),
    isMusl: async () => false,
    ...overrides,
  }
}

describe('Pi managed install', () => {
  it('reads the recorded vendor stable channel in one request', async () => {
    const host = ports()
    await expect(piManagedInstall.latest(host)).resolves.toEqual({ version: '1.6.0' })
    expect(host.fetchText).toHaveBeenCalledExactlyOnceWith(
      'https://pi.dev/api/installer/releases/latest',
    )
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
    expect(declaredValue(piManifest.managedInstall)).toBe(piManagedInstall)
  })

  it.each([
    { version: '1.7.0-rc.1' },
    { version: '1.7.0-beta.1' },
    { version: 'v1.6.0' },
    { version: null },
    { version: '1.6.0/../../escape' },
    { schemaVersion: 2 },
  ])('refuses an unstable or invalid stable-channel response: %j', async (changed) => {
    const metadata = { ...JSON.parse(PI_STABLE_RESPONSE), ...changed }
    const host = ports({ fetchText: vi.fn(async () => JSON.stringify(metadata)) })
    await expect(piManagedInstall.latest(host)).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    '',
    '1.6.1-rc.1',
    'v1.6.0',
    '1.6.0/../../escape',
  ])('refuses an unsafe requested version: %j', async (version) => {
    const host = ports()
    await expect(piManagedInstall.install({ version }, dir, host)).rejects.toThrow('stable version')
    expect(host.fetchText).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['linux', 'x64', 'pi-linux-x64.tar.gz'],
    ['linux', 'arm64', 'pi-linux-arm64.tar.gz'],
    ['linux', 'x86_64', 'pi-linux-x64.tar.gz'],
    ['linux', 'aarch64', 'pi-linux-arm64.tar.gz'],
    ['darwin', 'x64', 'pi-darwin-x64.tar.gz'],
    ['darwin', 'arm64', 'pi-darwin-arm64.tar.gz'],
    ['win32', 'x64', 'pi-windows-x64.zip'],
    ['win32', 'arm64', 'pi-windows-arm64.zip'],
  ] as const)('installs the complete published %s/%s bundle', async (platform, arch, name) => {
    const archive = name.endsWith('.zip')
      ? Buffer.from(zipFixtures.windows, 'base64')
      : piTarFixture()
    const host = ports({ platform, arch }, archive)
    const installed = await piManagedInstall.install({ version: '1.6.0' }, dir, host)
    const source = `https://github.com/earendil-works/pi/releases/download/v1.6.0/${name}`
    const executable = platform === 'win32' ? 'pi/pi.exe' : 'pi/pi'
    expect(host.fetch).toHaveBeenCalledExactlyOnceWith(source, join(dir, '.pi-download'))
    expect(host.fetchText).toHaveBeenCalledWith(
      'https://api.github.com/repos/earendil-works/pi/releases/tags/v1.6.0',
    )
    expect(host.fetchText).toHaveBeenCalledWith(
      'https://github.com/earendil-works/pi/releases/download/v1.6.0/SHA256SUMS',
    )
    expect(installed).toEqual({
      executable,
      source,
      integrity: {
        kind: 'sha256',
        digest: createHash('sha256').update(archive).digest('hex'),
        publishedAt: '2026-11-20T11:35:03Z',
      },
    })
    expect(readFileSync(join(dir, executable), 'utf8')).toBe(PI_FIXTURE_BINARY)
    expect(statSync(join(dir, executable)).mode & 0o777).toBe(0o755)
    for (const [path, body] of Object.entries(PI_FIXTURE_FILES).filter(
      ([path]) => path !== 'pi/pi',
    ))
      expect(readFileSync(join(dir, path), 'utf8')).toBe(body)
    expect(readdirSync(dir)).toEqual(['pi'])
    expect(host.runTool).not.toHaveBeenCalled()
    expect(host.run).not.toHaveBeenCalled()
  })

  it.each([
    ['freebsd', 'x64', false],
    ['linux', 'ia32', false],
    ['linux', 'constructor', false],
    ['linux', 'x64', true],
  ] as const)('refuses unsupported %s/%s (musl=%s) before fetching', async (platform, arch, musl) => {
    const host = ports({ platform, arch, isMusl: async () => musl })
    await expect(piManagedInstall.latest(host)).rejects.toThrow('no standalone release')
    await expect(piManagedInstall.install({ version: '1.6.0' }, dir, host)).rejects.toThrow(
      'no standalone release',
    )
    expect(host.fetchText).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it.each([
    { prerelease: true },
    { draft: true },
    { tag_name: 'v1.7.0-rc.1' },
    { tag_name: 'v1.5.0' },
    { published_at: 'invalid' },
    { assets: [] },
    {
      assets: [{ name: 'pi-linux-x64.tar.gz', browser_download_url: 'https://example.com/other' }],
    },
  ])('refuses inconsistent standalone metadata before downloading: %j', async (changed) => {
    const metadata = { ...JSON.parse(PI_STANDALONE_RESPONSE), ...changed }
    const host = ports({ fetchText: vi.fn(async () => JSON.stringify(metadata)) })
    await expect(piManagedInstall.install({ version: '1.6.0' }, dir, host)).rejects.toThrow()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('refuses a mismatched checksum before unpacking and removes the download', async () => {
    const metadata = JSON.parse(PI_STANDALONE_RESPONSE)
    // Recorded vendor checksums, synthetic archive bytes: the download must fail.
    const host = ports({
      fetchText: vi.fn(async (url) =>
        url.endsWith('/SHA256SUMS')
          ? `${metadata.assets.find((a: { name: string }) => a.name === 'pi-linux-x64.tar.gz').digest.slice(7)}  pi-linux-x64.tar.gz\n`
          : PI_STANDALONE_RESPONSE,
      ),
    })
    await expect(piManagedInstall.install({ version: '1.6.0' }, dir, host)).rejects.toThrow(
      'checksum verification FAILED',
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    'missing',
    'not-a-digest  pi-linux-x64.tar.gz',
    `${'0'.repeat(64)}  pi-linux-x64.tar.gz`,
  ])('refuses missing, malformed or conflicting published checksums: %s', async (sums) => {
    const metadata = JSON.stringify(piStandaloneFixture(piTarFixture()))
    const host = ports({
      fetchText: vi.fn(async (url) => (url.endsWith('/SHA256SUMS') ? sums : metadata)),
    })
    await expect(piManagedInstall.install({ version: '1.6.0' }, dir, host)).rejects.toThrow(
      'SHA256SUMS',
    )
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('verifies SHA256SUMS even when GitHub supplies no per-asset digest', async () => {
    const archive = piTarFixture()
    const metadata = piStandaloneFixture(archive)
    for (const asset of metadata.assets) delete asset.digest
    const host = ports({
      fetchText: vi.fn(async (url) =>
        url.endsWith('/SHA256SUMS') ? piChecksumFixture(archive) : JSON.stringify(metadata),
      ),
    })
    expect(await piManagedInstall.install({ version: '1.6.0' }, dir, host)).toMatchObject({
      integrity: { kind: 'sha256', digest: createHash('sha256').update(archive).digest('hex') },
    })
  })

  it('propagates a download failure and removes a partial download', async () => {
    const host = ports({
      fetch: vi.fn(async (_url, out) => {
        writeFileSync(out, 'partial')
        throw new Error('HTTP 503')
      }),
    })
    await expect(piManagedInstall.install({ version: '1.6.0' }, dir, host)).rejects.toThrow(
      'HTTP 503',
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    'sums',
    'digest',
    'none',
  ] as const)('records the vendor integrity proof: %s', async (kind) => {
    const vendor = await piVendorFixtureWithIntegrity(kind).start()
    const ledger = InstallLedger.open({ harnessesDir: join(dir, 'harnesses') })
    try {
      const result = await installRelease('pi', {
        ledger,
        commandEnv: { HOME: join(dir, 'personal-home'), PATH: '/usr/bin:/bin' },
        vendorOrigins: vendor.origins,
        platform: 'linux',
        arch: 'x64',
      })
      expect(result).toMatchObject({ outcome: 'installed', version: '1.6.0' })
      if (result.outcome !== 'installed') throw new Error(JSON.stringify(result))
      expect(readInstallReceipt(result.dir)).toMatchObject({
        ok: true,
        receipt: {
          harness: 'pi',
          executable: 'pi/pi',
          integrity:
            kind === 'none'
              ? {
                  kind: 'none',
                  reason: expect.stringContaining('neither SHA256SUMS nor an asset digest'),
                }
              : {
                  kind: 'sha256',
                  digest: createHash('sha256').update(piTarFixture()).digest('hex'),
                },
        },
      })
    } finally {
      ledger.close()
      await vendor.stop()
    }
  })

  it('installs beside the person’s own Pi: PI_CODING_AGENT_DIR keeps the copies apart (POD-7372)', () => {
    expect(harnessHomeVariable('pi')).toBe('PI_CODING_AGENT_DIR')
    expect(managedInstallRefusal('pi', true)).toBeUndefined()
    expect(managedInstallRefusal('pi', null)).toBeUndefined()
  })
})
