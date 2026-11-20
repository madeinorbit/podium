/**
 * Pi's complete standalone bundle (POD-7267). Its installer can install Node
 * and edit profiles; managed installs download the published archive instead.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { extractReleaseDirectory } from '../../inventory/release-archive.js'
import {
  type HarnessCheckPorts,
  type HarnessInstall,
  type ReleaseIntegrityProof,
  unsupported,
} from '../../manifest.js'

export const piInstall = unsupported(
  'Pi is distributed through npm, its standalone installer, and GitHub releases — no single vendor install script to run',
)

const INSTALLER_API = 'https://pi.dev/api/installer/releases'
const RELEASE_API = 'https://api.github.com/repos/earendil-works/pi/releases'
const RELEASE_FILES = 'https://github.com/earendil-works/pi/releases/download'

interface VendorRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string
  assets: { name: string; browser_download_url: string; digest?: string | null }[]
}

export const piManagedInstall: HarnessInstall = {
  async latest(ports) {
    await archiveName(ports)
    const metadata = JSON.parse(await ports.fetchText(`${INSTALLER_API}/latest`))
    if (metadata?.schemaVersion !== 1)
      throw new Error('Pi stable channel has an unsupported release schema')
    requireStableVersion(metadata.version)
    return { version: metadata.version }
  },
  async install(release, dir, ports) {
    requireStableVersion(release.version)
    const name = await archiveName(ports)
    const metadata = parseRelease(await ports.fetchText(`${RELEASE_API}/tags/v${release.version}`))
    if (metadata.tag_name !== `v${release.version}`)
      throw new Error('Pi release metadata does not match the requested version')
    const asset = assetFor(metadata, name)
    const integrity = await integrityFor(metadata, asset, ports)
    const archive = join(dir, '.pi-download')
    const executable = ports.platform === 'win32' ? 'pi/pi.exe' : 'pi/pi'
    try {
      await ports.fetch(asset.browser_download_url, archive)
      if (integrity.kind === 'sha256') {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(archive)) hash.update(chunk)
        if (hash.digest('hex') !== integrity.digest)
          throw new Error('Pi archive checksum verification FAILED')
      }
      await extractReleaseDirectory(archive, name.endsWith('.zip') ? 'zip' : 'tar.gz', 'pi', dir)
      await chmod(join(dir, executable), 0o755)
      return { executable, integrity, source: asset.browser_download_url }
    } finally {
      await rm(archive, { force: true })
    }
  },
}

function requireStableVersion(version: unknown): asserts version is string {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Pi release must be a stable version in X.Y.Z form')
}

function parseRelease(text: string): VendorRelease {
  const release = JSON.parse(text) as VendorRelease | null
  if (
    !release ||
    typeof release.tag_name !== 'string' ||
    !release.tag_name.startsWith('v') ||
    release.draft !== false ||
    release.prerelease !== false ||
    !Array.isArray(release.assets)
  )
    throw new Error('Pi metadata must describe a published stable release')
  requireStableVersion(release.tag_name.slice(1))
  return release
}

/** The six published standalone platforms. Linux has no musl release. */
async function archiveName(ports: HarnessCheckPorts): Promise<string> {
  const os = ports.platform === 'win32' ? 'windows' : ports.platform
  const arch =
    ports.arch === 'x64' || ports.arch === 'x86_64'
      ? 'x64'
      : ports.arch === 'arm64' || ports.arch === 'aarch64'
        ? 'arm64'
        : undefined
  if (
    !['linux', 'darwin', 'windows'].includes(os) ||
    !arch ||
    (os === 'linux' && (await ports.isMusl()))
  )
    throw new Error(`Pi has no standalone release for ${ports.platform}/${ports.arch} and libc`)
  return `pi-${os}-${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`
}

function assetFor(release: VendorRelease, name: string): VendorRelease['assets'][number] {
  const matches = release.assets.filter((candidate) => candidate?.name === name)
  const asset = matches[0]
  if (matches.length !== 1 || !asset)
    throw new Error(`Pi ${release.tag_name} has no unique ${name}`)
  if (asset.browser_download_url !== `${RELEASE_FILES}/${release.tag_name}/${name}`)
    throw new Error('Pi asset has an unexpected download URL')
  return asset
}

async function integrityFor(
  release: VendorRelease,
  asset: VendorRelease['assets'][number],
  ports: HarnessCheckPorts,
): Promise<ReleaseIntegrityProof> {
  let digest: string | undefined
  if (asset.digest !== null && asset.digest !== undefined && asset.digest !== '') {
    if (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest))
      throw new Error('Pi asset has an invalid SHA-256 digest')
    digest = asset.digest.slice(7).toLowerCase()
  }
  if (release.assets.some((candidate) => candidate?.name === 'SHA256SUMS')) {
    const sums = assetFor(release, 'SHA256SUMS')
    const text = await ports.fetchText(sums.browser_download_url)
    const matches = text
      .split(/\r?\n/)
      .map((line) => /^([a-f0-9]{64}) [ *](\S+)$/.exec(line))
      .filter((match) => match?.[2] === asset.name)
    const published = matches[0]?.[1]?.toLowerCase()
    if (matches.length !== 1 || !published || (digest && digest !== published))
      throw new Error('Pi SHA256SUMS has a missing, duplicate or inconsistent checksum')
    digest = published
  }
  if (!digest)
    return {
      kind: 'none',
      reason: `The Pi release publishes neither SHA256SUMS nor an asset digest for ${asset.name}.`,
    }
  if (
    typeof release.published_at !== 'string' ||
    !Number.isFinite(Date.parse(release.published_at))
  )
    throw new Error('Pi release has no valid publication time for its checksum')
  return { kind: 'sha256', digest, publishedAt: release.published_at }
}
