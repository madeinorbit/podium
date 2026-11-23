/**
 * Codex install layout — the Inventory install section (POD-4414 §4.4).
 *
 * KNOWLEDGE, not mechanism: the vendor installer URL, the shell it runs
 * under, and the env it needs. The temp-dir lifecycle, the fetch, and the
 * `--version` verification around it are the generic mechanism
 * (`inventory/install.ts`) and stay harness-free.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { extractReleaseBundle } from '../../inventory/release-archive.js'
import type { HarnessCheckPorts, HarnessInstall, HarnessInstallScript } from '../../manifest.js'

export const codexInstall: HarnessInstallScript = {
  binary: 'codex',
  url: (env) => env.PODIUM_CODEX_INSTALL_URL ?? 'https://chatgpt.com/codex/install.sh',
  runInstaller(scriptPath, binDir, ports) {
    // Codex exits non-zero without CODEX_NON_INTERACTIVE, and installs to the
    // wrong directory without CODEX_INSTALL_DIR — getting these wrong is silent.
    ports.runTool('sh', [scriptPath], {
      ...ports.env,
      CODEX_NON_INTERACTIVE: '1',
      CODEX_INSTALL_DIR: binDir,
    })
  },
}

const RELEASES = 'https://releases.openai.com/codex'
const GITHUB_API = 'https://api.github.com/repos/openai/codex/releases'
const GITHUB_FILES = 'https://github.com/openai/codex/releases/download'
const CHECKSUMS = 'codex-package_SHA256SUMS'

interface VendorRelease {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  assets: { name: string; browser_download_url: string; digest?: string | null }[]
}

/**
 * Keep the complete published package outside Codex's standalone install tree.
 * The vendor installer edits profiles, links and prunes releases; none of it
 * runs here. Per the operator's decision (§12.12), the daemon copy and its
 * updater inside CODEX_HOME retain their default behavior.
 */
export const codexManagedInstall: HarnessInstall & { readonly updateNotice: string } = {
  updateNotice: 'Codex updates its own server; a session may move to that newer server.',
  async latest(ports) {
    const name = archiveName(ports)
    const { metadata, base } = await releaseMetadata(ports)
    const version = metadata.tag_name.slice('rust-v'.length)
    assetFor(metadata, base, version, name)
    assetFor(metadata, base, version, CHECKSUMS)
    return { version }
  },
  async install(release, dir, ports) {
    requireStableVersion(release.version)
    const name = archiveName(ports)
    const { metadata, base } = await releaseMetadata(ports, release.version)
    const asset = assetFor(metadata, base, release.version, name)
    const sums = assetFor(metadata, base, release.version, CHECKSUMS)
    const checksumText = await withGithubFallback(
      sums.browser_download_url,
      release.version,
      CHECKSUMS,
      (url) => ports.fetchText(url),
    )
    const matches = checksumText
      .split(/\r?\n/)
      .map((line) => /^([a-f0-9]{64}) [ *](\S+)$/i.exec(line))
      .filter((match) => match?.[2] === name)
    const digest = matches[0]?.[1]?.toLowerCase()
    if (matches.length !== 1 || !digest)
      throw new Error(`Codex ${CHECKSUMS} has no unique valid checksum for ${name}`)
    if (
      asset.digest !== undefined &&
      asset.digest !== null &&
      (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest) ||
        asset.digest.slice(7).toLowerCase() !== digest)
    )
      throw new Error('Codex asset digest disagrees with its published SHA-256 checksum')

    const archive = join(dir, '.codex-download')
    const executable = `package/bin/${ports.platform === 'win32' ? 'codex.exe' : 'codex'}`
    try {
      const source = await withGithubFallback(
        asset.browser_download_url,
        release.version,
        name,
        async (url) => {
          await ports.fetch(url, archive)
          return url
        },
      )
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(archive)) hash.update(chunk)
      if (hash.digest('hex') !== digest)
        throw new Error('Codex archive checksum verification FAILED')
      await extractReleaseBundle(archive, 'tar.gz', dir, 'package')
      await chmod(join(dir, executable), 0o755)
      return { executable, source, integrity: { kind: 'sha256', digest } }
    } finally {
      await rm(archive, { force: true })
    }
  },
}

function requireStableVersion(version: unknown): asserts version is string {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Codex release must be a stable version in X.Y.Z form')
}

/** The vendor ships musl packages on both glibc and musl Linux. */
function archiveName(ports: HarnessCheckPorts): string {
  const arch = ['x64', 'x86_64', 'amd64'].includes(ports.arch)
    ? 'x86_64'
    : ['arm64', 'aarch64'].includes(ports.arch)
      ? 'aarch64'
      : undefined
  const os =
    ports.platform === 'linux'
      ? 'unknown-linux-musl'
      : ports.platform === 'darwin'
        ? 'apple-darwin'
        : ports.platform === 'win32'
          ? 'pc-windows-msvc'
          : undefined
  if (!arch || !os)
    throw new Error(`Codex has no standalone release for ${ports.platform}/${ports.arch}`)
  return `codex-package-${arch}-${os}.tar.gz`
}

async function releaseMetadata(
  ports: HarnessCheckPorts,
  requested?: string,
): Promise<{ metadata: VendorRelease; base: string }> {
  let text: string
  let base: string
  try {
    text = await ports.fetchText(
      requested ? `${RELEASES}/releases/${requested}/release.json` : `${RELEASES}/channels/latest`,
    )
    base = RELEASES
  } catch {
    text = await ports.fetchText(
      requested ? `${GITHUB_API}/tags/rust-v${requested}` : `${GITHUB_API}/latest`,
    )
    base = GITHUB_FILES
  }
  // Invalid metadata is a failure, not a reason to try a different channel.
  const metadata = JSON.parse(text) as VendorRelease | null
  if (
    !metadata ||
    typeof metadata.tag_name !== 'string' ||
    !metadata.tag_name.startsWith('rust-v') ||
    (metadata.draft !== undefined && metadata.draft !== false) ||
    (metadata.prerelease !== undefined && metadata.prerelease !== false) ||
    (base === GITHUB_FILES && (metadata.draft !== false || metadata.prerelease !== false)) ||
    !Array.isArray(metadata.assets)
  )
    throw new Error('Codex metadata must describe a published stable release')
  const version = metadata.tag_name.slice('rust-v'.length)
  requireStableVersion(version)
  if (requested !== undefined && version !== requested)
    throw new Error('Codex release metadata does not match the requested version')
  return { metadata, base }
}

function assetFor(
  release: VendorRelease,
  base: string,
  version: string,
  name: string,
): VendorRelease['assets'][number] {
  const matches = release.assets.filter((asset) => asset?.name === name)
  const asset = matches[0]
  if (matches.length !== 1 || !asset) throw new Error(`Codex has no unique published ${name}`)
  const expected =
    base === RELEASES
      ? `${RELEASES}/releases/${version}/${name}`
      : `${GITHUB_FILES}/rust-v${version}/${name}`
  if (asset.browser_download_url !== expected)
    throw new Error('Codex asset has an unexpected download URL')
  return asset
}

async function withGithubFallback<T>(
  source: string,
  version: string,
  name: string,
  fetch: (url: string) => Promise<T>,
): Promise<T> {
  try {
    return await fetch(source)
  } catch (error) {
    if (!source.startsWith(`${RELEASES}/releases/`)) throw error
    return await fetch(`${GITHUB_FILES}/rust-v${version}/${name}`)
  }
}
