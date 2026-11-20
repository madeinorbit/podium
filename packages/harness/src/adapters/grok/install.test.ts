import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallLedger } from '../../inventory/install-ledger.js'
import { readInstallReceipt } from '../../inventory/install-receipt.js'
import { installRelease } from '../../inventory/managed-install.js'
import type { HarnessInstallPorts } from '../../manifest.js'
import { grokManagedInstall } from './install.js'
import { GROK_STABLE_RESPONSE, grokVendorFixture } from './install.test-support.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-grok-install-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function ports(overrides: Partial<HarnessInstallPorts> = {}): HarnessInstallPorts {
  return {
    platform: 'linux',
    arch: 'x64',
    env: { HOME: '/decoy/home', GROK_CHANNEL: 'alpha' },
    home: join(dir, 'home'),
    installerEnv: { HOME: join(dir, 'home') },
    fetchText: vi.fn(async () => GROK_STABLE_RESPONSE),
    fetch: vi.fn(async (_url, out) => {
      writeFileSync(out, 'stand-in vendor binary')
    }),
    vendorUrl: (url) => url,
    run: vi.fn(async () => {
      throw new Error('must not run a program')
    }),
    runTool: vi.fn(async () => {
      throw new Error('must not run the vendor installer')
    }),
    isMusl: async () => false,
    ...overrides,
  }
}

describe('Grok managed install', () => {
  it("reads the recorded stable pointer regardless of the machine's vendor channel", async () => {
    const host = ports()
    await expect(grokManagedInstall.latest(host)).resolves.toEqual({ version: '1.0.89' })
    expect(host.fetchText).toHaveBeenCalledExactlyOnceWith('https://x.ai/cli/stable')
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    '',
    '1.0.90-alpha',
    '1.0.90-rc.1',
    '1.0.89+build',
    'v1.0.89',
    '1.0.89/../../bin',
    '<html>bad gateway</html>',
  ])('refuses an invalid or prerelease pointer: %j', async (version) => {
    const host = ports({ fetchText: vi.fn(async () => version) })
    await expect(grokManagedInstall.latest(host)).rejects.toThrow('stable version')
    await expect(grokManagedInstall.install({ version }, dir, host)).rejects.toThrow(
      'stable version',
    )
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    ['linux', 'x64', 'linux-x86_64', ''],
    ['linux', 'arm64', 'linux-aarch64', ''],
    ['darwin', 'x64', 'macos-x86_64', ''],
    ['darwin', 'arm64', 'macos-aarch64', ''],
    ['win32', 'x64', 'windows-x86_64', '.exe'],
    ['win32', 'arm64', 'windows-aarch64', '.exe'],
    ['linux', 'x86_64', 'linux-x86_64', ''],
    ['linux', 'aarch64', 'linux-aarch64', ''],
  ] as const)('downloads the published %s/%s binary directly', async (platform, arch, target, extension) => {
    const host = ports({ platform, arch })
    const installed = await grokManagedInstall.install({ version: '1.0.89' }, dir, host)
    const source = `https://x.ai/cli/grok-1.0.89-${target}${extension}`
    const executable = `grok${extension}`
    expect(host.fetch).toHaveBeenCalledExactlyOnceWith(source, join(dir, executable))
    expect(installed).toEqual({
      executable,
      source,
      integrity: { kind: 'none', reason: expect.stringContaining('no checksum') },
    })
    expect(readFileSync(join(dir, executable), 'utf8')).toBe('stand-in vendor binary')
    expect(statSync(join(dir, executable)).mode & 0o777).toBe(0o755)
    expect(readdirSync(dir)).toEqual([executable])
    expect(host.fetchText).not.toHaveBeenCalled()
    expect(host.run).not.toHaveBeenCalled()
    expect(host.runTool).not.toHaveBeenCalled()
  })

  it.each([
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
    ['linux', 'constructor'],
  ] as const)('refuses unsupported %s/%s before fetching', async (platform, arch) => {
    const host = ports({ platform, arch })
    await expect(grokManagedInstall.latest(host)).rejects.toThrow('no standalone release')
    await expect(grokManagedInstall.install({ version: '1.0.89' }, dir, host)).rejects.toThrow(
      'no standalone release',
    )
    expect(host.fetchText).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('propagates a failed vendor download', async () => {
    const host = ports({
      fetch: vi.fn(async () => {
        throw new Error('HTTP 503')
      }),
    })
    await expect(grokManagedInstall.install({ version: '1.0.89' }, dir, host)).rejects.toThrow(
      'HTTP 503',
    )
    expect(host.runTool).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it('publishes the explicit lack of a vendor checksum in the managed receipt', async () => {
    const vendor = await grokVendorFixture.start()
    const ledger = InstallLedger.open({ harnessesDir: join(dir, 'harnesses') })
    try {
      const result = await installRelease('grok', {
        ledger,
        commandEnv: { HOME: join(dir, 'personal-home'), PATH: '/usr/bin:/bin' },
        vendorOrigins: vendor.origins,
        platform: 'linux',
        arch: 'x64',
      })
      expect(result).toMatchObject({ outcome: 'installed', version: '1.0.89' })
      if (result.outcome !== 'installed') throw new Error(JSON.stringify(result))
      expect(readInstallReceipt(result.dir)).toMatchObject({
        ok: true,
        receipt: {
          harness: 'grok',
          executable: 'grok',
          integrity: { kind: 'none', reason: expect.stringContaining('no checksum') },
          source: 'https://x.ai/cli/grok-1.0.89-linux-x86_64',
        },
      })
    } finally {
      ledger.close()
      await vendor.stop()
    }
  })
})
