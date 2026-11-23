import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallLedger } from '../../inventory/install-ledger.js'
import { readInstallReceipt } from '../../inventory/install-receipt.js'
import { installRelease } from '../../inventory/managed-install.js'
import type { HarnessInstallPorts } from '../../manifest.js'
import { claudeCodeManagedInstall } from './install.js'
import {
  CLAUDE_FIXTURE_BINARY,
  CLAUDE_MANIFEST_RESPONSE,
  CLAUDE_STABLE_RESPONSE,
  claudeManifestFixture,
  claudeVendorFixture,
} from './install.test-support.js'

const BASE = 'https://downloads.claude.ai/claude-code-releases'
const VERSION = '2.1.311'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-claude-managed-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function ports(overrides: Partial<HarnessInstallPorts> = {}): HarnessInstallPorts {
  return {
    platform: 'linux',
    arch: 'x64',
    env: {
      HOME: '/decoy/home',
      PODIUM_CLAUDE_RELEASE_BASE_URL: 'https://machine-setting.invalid',
    },
    home: join(dir, 'home'),
    installerEnv: { HOME: join(dir, 'home') },
    fetchText: vi.fn(async (url) => {
      if (url === `${BASE}/stable`) return CLAUDE_STABLE_RESPONSE
      if (url === `${BASE}/${VERSION}/manifest.json`) return JSON.stringify(claudeManifestFixture())
      throw new Error(`unexpected vendor URL: ${url}`)
    }),
    fetch: vi.fn(async (_url, out) => {
      writeFileSync(out, CLAUDE_FIXTURE_BINARY)
    }),
    vendorUrl: (url) => url,
    run: vi.fn(async () => {
      throw new Error('must not run a program')
    }),
    runTool: vi.fn(async () => {
      throw new Error('must not run the vendor installer')
    }),
    isMusl: vi.fn(async () => false),
    ...overrides,
  }
}

describe('Claude Code managed install', () => {
  it('reads only the recorded stable pointer, ignoring machine release overrides', async () => {
    const host = ports()
    await expect(claudeCodeManagedInstall.latest(host)).resolves.toEqual({ version: VERSION })
    expect(host.fetchText).toHaveBeenCalledExactlyOnceWith(`${BASE}/stable`)
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    '',
    '2.1.312-alpha',
    '2.1.312-rc.1',
    '2.1.311+build',
    'v2.1.311',
    '2.1.311/../../bin',
    '<html>bad gateway</html>',
  ])('refuses an invalid or prerelease version: %j', async (version) => {
    const host = ports({ fetchText: vi.fn(async () => version) })
    await expect(claudeCodeManagedInstall.latest(host)).rejects.toThrow('stable version')
    await expect(claudeCodeManagedInstall.install({ version }, dir, host)).rejects.toThrow(
      'stable version',
    )
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    ['linux', 'x64', false, 'linux-x64', 'claude'],
    ['linux', 'arm64', false, 'linux-arm64', 'claude'],
    ['linux', 'x64', true, 'linux-x64-musl', 'claude'],
    ['linux', 'arm64', true, 'linux-arm64-musl', 'claude'],
    ['darwin', 'x64', false, 'darwin-x64', 'claude'],
    ['darwin', 'arm64', false, 'darwin-arm64', 'claude'],
    ['win32', 'x64', false, 'win32-x64', 'claude.exe'],
    ['win32', 'arm64', false, 'win32-arm64', 'claude.exe'],
    ['linux', 'x86_64', false, 'linux-x64', 'claude'],
    ['linux', 'aarch64', false, 'linux-arm64', 'claude'],
  ] as const)('downloads and verifies %s/%s (musl %s)', async (platform, arch, musl, target, executable) => {
    const host = ports({ platform, arch, isMusl: vi.fn(async () => musl) })
    const installed = await claudeCodeManagedInstall.install({ version: VERSION }, dir, host)
    const source = `${BASE}/${VERSION}/${target}/${executable}`
    expect(host.fetchText).toHaveBeenCalledExactlyOnceWith(`${BASE}/${VERSION}/manifest.json`)
    expect(host.fetch).toHaveBeenCalledExactlyOnceWith(source, join(dir, '.claude-download'))
    expect(installed).toEqual({
      executable,
      source,
      integrity: {
        kind: 'sha256',
        digest: createHash('sha256').update(CLAUDE_FIXTURE_BINARY).digest('hex'),
        publishedAt: '2026-10-26T19:03:46Z',
      },
    })
    expect(readFileSync(join(dir, executable), 'utf8')).toBe(CLAUDE_FIXTURE_BINARY)
    expect(statSync(join(dir, executable)).mode & 0o777).toBe(0o755)
    expect(readdirSync(dir)).toEqual([executable])
    expect(host.run).not.toHaveBeenCalled()
    expect(host.runTool).not.toHaveBeenCalled()
    if (platform !== 'linux') expect(host.isMusl).not.toHaveBeenCalled()
  })

  it.each([
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
    ['linux', 'constructor'],
  ] as const)('refuses unsupported %s/%s before fetching', async (platform, arch) => {
    const host = ports({ platform, arch })
    await expect(claudeCodeManagedInstall.latest(host)).rejects.toThrow('no standalone release')
    await expect(claudeCodeManagedInstall.install({ version: VERSION }, dir, host)).rejects.toThrow(
      'no standalone release',
    )
    expect(host.fetchText).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('refuses bytes that disagree with the recorded vendor checksum', async () => {
    const host = ports({ fetchText: vi.fn(async () => CLAUDE_MANIFEST_RESPONSE) })
    await expect(claudeCodeManagedInstall.install({ version: VERSION }, dir, host)).rejects.toThrow(
      'checksum verification FAILED',
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    'missing-platform',
    'missing-checksum',
    'bad-checksum',
    'bad-binary',
    'wrong-version',
    'bad-date',
  ] as const)('refuses invalid manifest metadata before downloading: %s', async (fault) => {
    const manifest = claudeManifestFixture()
    const entry = manifest.platforms['linux-x64']
    if (!entry) throw new Error('recorded manifest has no linux-x64')
    switch (fault) {
      case 'missing-platform':
        delete manifest.platforms['linux-x64']
        break
      case 'missing-checksum':
        entry.checksum = ''
        break
      case 'bad-checksum':
        entry.checksum = 'a'.repeat(63)
        break
      case 'bad-binary':
        entry.binary = '../../claude'
        break
      case 'wrong-version':
        manifest.version = '2.1.312'
        break
      case 'bad-date':
        manifest.buildDate = 'unknown'
        break
    }
    const host = ports({ fetchText: vi.fn(async () => JSON.stringify(manifest)) })
    await expect(
      claudeCodeManagedInstall.install({ version: VERSION }, dir, host),
    ).rejects.toThrow()
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it('removes a partial download on network failure', async () => {
    const host = ports({
      fetch: vi.fn(async (_url, out) => {
        writeFileSync(out, 'partial')
        throw new Error('network died mid-download')
      }),
    })
    await expect(claudeCodeManagedInstall.install({ version: VERSION }, dir, host)).rejects.toThrow(
      'network died mid-download',
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it('records the source and verified digest through installRelease and its vendor URL map', async () => {
    const vendor = await claudeVendorFixture.start()
    const ledger = InstallLedger.open({ harnessesDir: join(dir, 'harnesses') })
    try {
      const result = await installRelease('claude-code', {
        ledger,
        commandEnv: { HOME: join(dir, 'personal-home'), PATH: '/usr/bin:/bin' },
        vendorOrigins: vendor.origins,
        probeTimeoutMs: 30_000,
      })
      expect(result).toMatchObject({ outcome: 'installed', version: VERSION })
      if (result.outcome !== 'installed') return
      expect(readInstallReceipt(result.dir)).toMatchObject({
        ok: true,
        receipt: {
          harness: 'claude-code',
          executable: 'claude',
          source: `${BASE}/${VERSION}/linux-x64/claude`,
          integrity: {
            kind: 'sha256',
            digest: createHash('sha256').update(CLAUDE_FIXTURE_BINARY).digest('hex'),
            publishedAt: '2026-10-26T19:03:46Z',
          },
        },
      })
    } finally {
      ledger.close()
      await vendor.stop()
    }
  })
})
