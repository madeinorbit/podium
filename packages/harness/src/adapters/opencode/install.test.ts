import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallLedger } from '../../inventory/install-ledger.js'
import { readInstallReceipt } from '../../inventory/install-receipt.js'
import { installRelease } from '../../inventory/managed-install.js'
import type { HarnessInstallPorts } from '../../manifest.js'
import { declaredValue } from '../../manifest.js'
import { harnessHomeVariable, serverDriverExecutable } from '../../registry.js'
import zipFixtures from './fixtures/archives.json'
import { opencodeManifest } from './index.js'
import { opencodeManagedInstall } from './install.js'
import {
  OPENCODE_FIXTURE_BINARY,
  OPENCODE_STABLE_RESPONSE,
  opencodeTarFixture,
  opencodeVendorFixtureWithDigest,
} from './install.test-support.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-opencode-install-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function ports(
  overrides: Partial<HarnessInstallPorts> = {},
  archive = opencodeTarFixture(),
): HarnessInstallPorts {
  const metadata = JSON.parse(OPENCODE_STABLE_RESPONSE)
  for (const asset of metadata.assets)
    asset.digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
  return {
    platform: 'linux',
    arch: 'x64',
    env: { HOME: '/decoy/home', OPENCODE_CHANNEL: 'preview' },
    home: join(dir, 'home'),
    installerEnv: { HOME: join(dir, 'home') },
    fetchText: vi.fn(async () => JSON.stringify(metadata)),
    fetch: vi.fn(async (_url, out) => {
      writeFileSync(out, archive)
    }),
    vendorUrl: (url) => url,
    run: vi.fn(async () => {
      throw new Error('must not run a program')
    }),
    runTool: vi.fn(async () => {
      throw new Error('must not run a vendor installer or extraction tool')
    }),
    isMusl: async () => false,
    ...overrides,
  }
}

describe('OpenCode managed install', () => {
  it('reads the recorded stable GitHub response, independent of the machine channel', async () => {
    const host = ports({ fetchText: vi.fn(async () => OPENCODE_STABLE_RESPONSE) })
    await expect(opencodeManagedInstall.latest(host)).resolves.toEqual({ version: '1.19.6' })
    expect(host.fetchText).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/repos/anomalyco/opencode/releases/latest',
    )
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
    expect(declaredValue(opencodeManifest.managedInstall)).toBe(opencodeManagedInstall)
  })

  it.each([
    { prerelease: true },
    { draft: true },
    { tag_name: 'v1.20.0-rc.1' },
    { tag_name: 'v0.0.0-beta-18866' },
    { tag_name: 'v1.19.6/../../escape' },
    { tag_name: '1.19.6' },
    { assets: [] },
    { tag_name: null },
  ])('refuses an unstable, unpublished or unavailable release: %j', async (changed) => {
    const metadata = { ...JSON.parse(OPENCODE_STABLE_RESPONSE), ...changed }
    const host = ports({ fetchText: vi.fn(async () => JSON.stringify(metadata)) })
    await expect(opencodeManagedInstall.latest(host)).rejects.toThrow()
    await expect(opencodeManagedInstall.install({ version: '1.19.6' }, dir, host)).rejects.toThrow()
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    '',
    '1.19.7-rc.1',
    'v1.19.6',
    '1.19.6/../../escape',
  ])('refuses an unsafe requested version: %j', async (version) => {
    const host = ports()
    await expect(opencodeManagedInstall.install({ version }, dir, host)).rejects.toThrow(
      'stable version',
    )
    expect(host.fetchText).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['linux', 'x64', false, 'opencode-linux-x64.tar.gz'],
    ['linux', 'arm64', false, 'opencode-linux-arm64.tar.gz'],
    ['linux', 'x64', true, 'opencode-linux-x64-musl.tar.gz'],
    ['linux', 'arm64', true, 'opencode-linux-arm64-musl.tar.gz'],
    ['linux', 'x86_64', false, 'opencode-linux-x64.tar.gz'],
    ['linux', 'aarch64', false, 'opencode-linux-arm64.tar.gz'],
    ['darwin', 'x64', false, 'opencode-darwin-x64.zip'],
    ['darwin', 'arm64', false, 'opencode-darwin-arm64.zip'],
    ['win32', 'x64', false, 'opencode-windows-x64.zip'],
    ['win32', 'arm64', false, 'opencode-windows-arm64.zip'],
  ] as const)('installs the published %s/%s archive (musl=%s)', async (platform, arch, musl, name) => {
    const executable = platform === 'win32' ? 'opencode.exe' : 'opencode'
    const archive = name.endsWith('.tar.gz')
      ? opencodeTarFixture()
      : Buffer.from(zipFixtures[`${executable}-deflated`], 'base64')
    const host = ports({ platform, arch, isMusl: async () => musl }, archive)
    const installed = await opencodeManagedInstall.install({ version: '1.19.6' }, dir, host)
    const source = `https://github.com/anomalyco/opencode/releases/download/v1.19.6/${name}`
    expect(host.fetch).toHaveBeenCalledExactlyOnceWith(source, join(dir, '.opencode-download'))
    expect(host.fetchText).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/repos/anomalyco/opencode/releases/tags/v1.19.6',
    )
    expect(installed).toEqual({
      executable,
      source,
      integrity: {
        kind: 'sha256',
        digest: createHash('sha256').update(archive).digest('hex'),
        publishedAt: '2026-11-17T07:21:32Z',
      },
    })
    expect(readFileSync(join(dir, executable), 'utf8')).toBe(OPENCODE_FIXTURE_BINARY)
    expect(statSync(join(dir, executable)).mode & 0o777).toBe(0o755)
    expect(readdirSync(dir)).toEqual([executable])
    expect(host.runTool).not.toHaveBeenCalled()
    expect(host.run).not.toHaveBeenCalled()
  })

  it.each([
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
    ['linux', 'constructor'],
  ] as const)('refuses unsupported %s/%s before fetching', async (platform, arch) => {
    const host = ports({ platform, arch })
    await expect(opencodeManagedInstall.latest(host)).rejects.toThrow('no standalone release')
    await expect(opencodeManagedInstall.install({ version: '1.19.6' }, dir, host)).rejects.toThrow(
      'no standalone release',
    )
    expect(host.fetchText).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('refuses a platform with no asset in the recorded stable release', async () => {
    const metadata = JSON.parse(OPENCODE_STABLE_RESPONSE)
    metadata.assets = []
    const host = ports({ fetchText: vi.fn(async () => JSON.stringify(metadata)) })
    await expect(opencodeManagedInstall.latest(host)).rejects.toThrow(
      'no published opencode-linux-x64.tar.gz',
    )
    await expect(opencodeManagedInstall.install({ version: '1.19.6' }, dir, host)).rejects.toThrow(
      'no published',
    )
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it.each([
    { tag_name: 'v1.19.5' },
    { published_at: 'not a date' },
    {
      assets: [
        {
          name: 'opencode-linux-x64.tar.gz',
          browser_download_url: 'https://example.com/other-file',
        },
      ],
    },
  ])('refuses inconsistent metadata: %j', async (changed) => {
    const metadata = { ...JSON.parse(OPENCODE_STABLE_RESPONSE), ...changed }
    const host = ports({ fetchText: vi.fn(async () => JSON.stringify(metadata)) })
    await expect(opencodeManagedInstall.install({ version: '1.19.6' }, dir, host)).rejects.toThrow()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('refuses a checksum mismatch before unpacking and cleans the download', async () => {
    const host = ports({ fetchText: vi.fn(async () => OPENCODE_STABLE_RESPONSE) })
    await expect(opencodeManagedInstall.install({ version: '1.19.6' }, dir, host)).rejects.toThrow(
      'checksum verification FAILED',
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    'sha256:short',
    'sha512:abcd',
    'invalid',
  ])('never downgrades an invalid digest: %s', async (digest) => {
    const metadata = JSON.parse(OPENCODE_STABLE_RESPONSE)
    for (const asset of metadata.assets) asset.digest = digest
    const host = ports({ fetchText: vi.fn(async () => JSON.stringify(metadata)) })
    await expect(opencodeManagedInstall.install({ version: '1.19.6' }, dir, host)).rejects.toThrow(
      'invalid SHA-256',
    )
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('propagates a download failure and removes a partial download', async () => {
    const host = ports({
      fetch: vi.fn(async (_url, out) => {
        writeFileSync(out, 'partial download')
        throw new Error('HTTP 503')
      }),
    })
    await expect(opencodeManagedInstall.install({ version: '1.19.6' }, dir, host)).rejects.toThrow(
      'HTTP 503',
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    undefined,
    null,
  ] as const)('publishes the vendor integrity proof in the receipt (digest=%s)', async (digest) => {
    const vendor = await opencodeVendorFixtureWithDigest(digest).start()
    const ledger = InstallLedger.open({ harnessesDir: join(dir, 'harnesses') })
    try {
      const result = await installRelease('opencode', {
        ledger,
        commandEnv: { HOME: join(dir, 'personal-home'), PATH: '/usr/bin:/bin' },
        vendorOrigins: vendor.origins,
        platform: 'linux',
        arch: 'x64',
      })
      expect(result).toMatchObject({ outcome: 'installed', version: '1.19.6' })
      if (result.outcome !== 'installed') throw new Error(JSON.stringify(result))
      const integrity =
        digest === null
          ? { kind: 'none', reason: expect.stringContaining('no asset digest') }
          : {
              kind: 'sha256',
              digest: createHash('sha256').update(opencodeTarFixture()).digest('hex'),
            }
      expect(readInstallReceipt(result.dir)).toMatchObject({
        ok: true,
        receipt: { harness: 'opencode', executable: 'opencode', integrity },
      })
    } finally {
      ledger.close()
      await vendor.stop()
    }
  })

  it('leaves folder admission and the separate preview executable outside this adapter', () => {
    expect(harnessHomeVariable('opencode')).toBeUndefined()
    expect(serverDriverExecutable('opencode2-server')).toBe('opencode2')
    expect(opencodeManifest.inventory.executable.names).toEqual(['opencode'])
  })
})
