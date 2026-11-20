import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessInstallPorts } from '../../manifest.js'
import { codexManagedInstall } from './install.js'
import {
  CODEX_FIXTURE_FILES,
  CODEX_STABLE_RESPONSE,
  codexChecksumFixture,
  codexReleaseFixture,
  codexTarFixture,
} from './install.test-support.js'

const BASE = 'https://releases.openai.com/codex'
const API = 'https://api.github.com/repos/openai/codex/releases'
const GITHUB = 'https://github.com/openai/codex/releases/download/rust-v0.171.0'
const VERSION = '0.171.0'
const NAME = 'codex-package-x86_64-unknown-linux-musl.tar.gz'
const SUMS = 'codex-package_SHA256SUMS'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-codex-managed-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function ports(overrides: Partial<HarnessInstallPorts> = {}): HarnessInstallPorts {
  const archive = codexTarFixture()
  return {
    platform: 'linux',
    arch: 'x64',
    env: { HOME: '/decoy/home' },
    home: join(dir, 'home'),
    installerEnv: { HOME: join(dir, 'home') },
    fetchText: vi.fn(async (url) => {
      if (url.endsWith(SUMS)) return codexChecksumFixture(archive)
      if (url === `${BASE}/channels/latest` || url === `${BASE}/releases/${VERSION}/release.json`)
        return JSON.stringify(codexReleaseFixture(archive))
      throw new Error(`unexpected vendor URL: ${url}`)
    }),
    fetch: vi.fn(async (_url, out) => {
      writeFileSync(out, archive)
    }),
    vendorUrl: (url) => url,
    run: vi.fn(async () => {
      throw new Error('must not run a program')
    }),
    runTool: vi.fn(async () => {
      throw new Error('must not run an installer')
    }),
    isMusl: vi.fn(async () => false),
    ...overrides,
  }
}

describe('Codex managed install', () => {
  it('reads the recorded stable channel in one small request without writing files', async () => {
    const host = ports({ fetchText: vi.fn(async () => CODEX_STABLE_RESPONSE) })
    await expect(codexManagedInstall.latest(host)).resolves.toEqual({ version: VERSION })
    expect(host.fetchText).toHaveBeenCalledExactlyOnceWith(`${BASE}/channels/latest`)
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    ['linux', 'x64', 'x86_64-unknown-linux-musl', 'codex'],
    ['linux', 'arm64', 'aarch64-unknown-linux-musl', 'codex'],
    ['darwin', 'x64', 'x86_64-apple-darwin', 'codex'],
    ['darwin', 'arm64', 'aarch64-apple-darwin', 'codex'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc', 'codex.exe'],
    ['linux', 'x86_64', 'x86_64-unknown-linux-musl', 'codex'],
    ['linux', 'aarch64', 'aarch64-unknown-linux-musl', 'codex'],
  ] as const)('keeps and verifies the complete %s/%s package', async (platform, arch, target, binary) => {
    const archive = codexTarFixture({
      ...CODEX_FIXTURE_FILES,
      [`bin/${binary}`]: CODEX_FIXTURE_FILES['bin/codex'] as string,
    })
    const host = ports({
      platform,
      arch,
      fetchText: vi.fn(async (url) =>
        url.endsWith(SUMS)
          ? codexChecksumFixture(archive)
          : JSON.stringify(codexReleaseFixture(archive)),
      ),
      fetch: vi.fn(async (_url, out) => {
        writeFileSync(out, archive)
      }),
    })
    const installed = await codexManagedInstall.install({ version: VERSION }, dir, host)
    expect(installed).toEqual({
      executable: `package/bin/${binary}`,
      source: `${BASE}/releases/${VERSION}/codex-package-${target}.tar.gz`,
      integrity: { kind: 'sha256', digest: createHash('sha256').update(archive).digest('hex') },
    })
    for (const [name, body] of Object.entries(CODEX_FIXTURE_FILES))
      expect(readFileSync(join(dir, 'package', name), 'utf8')).toBe(body)
    expect(statSync(join(dir, installed.executable)).mode & 0o777).toBe(0o755)
    expect(readdirSync(dir)).toEqual(['package'])
    expect(host.run).not.toHaveBeenCalled()
    expect(host.runTool).not.toHaveBeenCalled()
  })

  it.each([true, false])('uses the vendor musl package on Linux (musl %s)', async (musl) => {
    const host = ports({ isMusl: vi.fn(async () => musl) })
    await codexManagedInstall.install({ version: VERSION }, dir, host)
    expect(host.fetch).toHaveBeenCalledWith(
      `${BASE}/releases/${VERSION}/${NAME}`,
      expect.any(String),
    )
  })

  it.each([
    '',
    '0.172.0-alpha.1',
    '0.172.0-beta',
    '0.171.0+build',
    'v0.171.0',
    '../escape',
  ])('refuses unstable versions: %j', async (version) => {
    const metadata = JSON.parse(CODEX_STABLE_RESPONSE)
    metadata.tag_name = `rust-v${version}`
    const host = ports({ fetchText: vi.fn(async () => JSON.stringify(metadata)) })
    await expect(codexManagedInstall.latest(host)).rejects.toThrow('stable version')
    await expect(codexManagedInstall.install({ version }, dir, host)).rejects.toThrow(
      'stable version',
    )
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
  ] as const)('refuses unsupported %s/%s before fetching', async (platform, arch) => {
    const host = ports({ platform, arch })
    await expect(codexManagedInstall.latest(host)).rejects.toThrow('no standalone release')
    await expect(codexManagedInstall.install({ version: VERSION }, dir, host)).rejects.toThrow(
      'no standalone release',
    )
    expect(host.fetchText).not.toHaveBeenCalled()
  })

  it('falls back to published GitHub stable metadata when the primary is unreachable', async () => {
    const archive = codexTarFixture()
    const host = ports({
      fetchText: vi.fn(async (url) => {
        if (url.startsWith(BASE)) throw new Error('primary offline')
        if (url.endsWith(SUMS)) return codexChecksumFixture(archive)
        return JSON.stringify(codexReleaseFixture(archive, true))
      }),
    })
    await expect(codexManagedInstall.latest(host)).resolves.toEqual({ version: VERSION })
    const installed = await codexManagedInstall.install({ version: VERSION }, dir, host)
    expect(host.fetchText).toHaveBeenCalledWith(`${API}/latest`)
    expect(host.fetchText).toHaveBeenCalledWith(`${API}/tags/rust-v${VERSION}`)
    expect(installed.source).toBe(`${GITHUB}/${NAME}`)
  })

  it.each(['draft', 'prerelease'])('refuses GitHub %s releases', async (flag) => {
    const metadata = codexReleaseFixture(codexTarFixture(), true)
    metadata[flag] = true
    const host = ports({
      fetchText: vi.fn(async (url) => {
        if (url.startsWith(BASE)) throw new Error('primary offline')
        return JSON.stringify(metadata)
      }),
    })
    await expect(codexManagedInstall.latest(host)).rejects.toThrow('published stable release')
    await expect(codexManagedInstall.install({ version: VERSION }, dir, host)).rejects.toThrow(
      'published stable release',
    )
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it('falls back for unavailable checksum and package files and records the actual source', async () => {
    const archive = codexTarFixture()
    const host = ports({
      fetchText: vi.fn(async (url) => {
        if (url === `${BASE}/releases/${VERSION}/${SUMS}`) throw new Error('unavailable')
        return url.endsWith(SUMS)
          ? codexChecksumFixture(archive)
          : JSON.stringify(codexReleaseFixture(archive))
      }),
      fetch: vi.fn(async (url, out) => {
        if (url.startsWith(BASE)) throw new Error('unavailable')
        writeFileSync(out, archive)
      }),
    })
    const installed = await codexManagedInstall.install({ version: VERSION }, dir, host)
    expect(installed.source).toBe(`${GITHUB}/${NAME}`)
    expect(host.fetchText).toHaveBeenCalledWith(`${GITHUB}/${SUMS}`)
  })

  it('refuses a checksum mismatch before extraction and removes the download', async () => {
    const host = ports({
      fetch: vi.fn(async (_url, out) => {
        writeFileSync(out, 'corrupt package')
      }),
    })
    await expect(codexManagedInstall.install({ version: VERSION }, dir, host)).rejects.toThrow(
      'checksum verification FAILED',
    )
    expect(readdirSync(dir)).toEqual([])
    expect(host.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    'missing',
    'duplicate',
    'invalid',
    'different-digest',
  ] as const)('refuses %s checksums without weakening integrity', async (fault) => {
    const archive = codexTarFixture()
    const metadata = codexReleaseFixture(archive)
    let sums = codexChecksumFixture(archive)
    if (fault === 'missing') sums = ''
    if (fault === 'duplicate') sums += sums
    if (fault === 'invalid') sums = `not-a-sha256  ${NAME}\n`
    if (fault === 'different-digest')
      metadata.assets.find((a: { name: string }) => a.name === NAME).digest =
        `sha256:${'0'.repeat(64)}`
    const host = ports({
      fetchText: vi.fn(async (url) => (url.endsWith(SUMS) ? sums : JSON.stringify(metadata))),
    })
    await expect(codexManagedInstall.install({ version: VERSION }, dir, host)).rejects.toThrow()
    expect(host.fetch).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    'wrong-version',
    'missing-platform',
    'duplicate-asset',
    'foreign-url',
    'prerelease',
  ] as const)('refuses invalid release metadata: %s', async (fault) => {
    const metadata = codexReleaseFixture(codexTarFixture())
    if (fault === 'wrong-version') metadata.tag_name = 'rust-v0.170.0'
    if (fault === 'missing-platform') metadata.assets = []
    if (fault === 'duplicate-asset')
      metadata.assets.push(metadata.assets.find((a: { name: string }) => a.name === NAME))
    if (fault === 'foreign-url')
      metadata.assets.find((a: { name: string }) => a.name === NAME).browser_download_url =
        'https://other.invalid/package'
    if (fault === 'prerelease') metadata.prerelease = true
    const host = ports({ fetchText: vi.fn(async () => JSON.stringify(metadata)) })
    await expect(codexManagedInstall.install({ version: VERSION }, dir, host)).rejects.toThrow()
    expect(host.fetch).not.toHaveBeenCalled()
  })
})
