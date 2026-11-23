/**
 * OpenCode's published standalone archive (POD-7267). The legacy script path
 * stays declined until the requests task moves it onto the managed mechanism.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { extractReleaseFile } from '../../inventory/release-archive.js'
import {
  type HarnessCheckPorts,
  type HarnessInstall,
  type ReleaseIntegrityProof,
  unsupported,
} from '../../manifest.js'

export const opencodeInstall = unsupported(
  'OpenCode is distributed through npm, brew, and its own standalone installer — no single vendor install script to run',
)

const RELEASE_API = 'https://api.github.com/repos/anomalyco/opencode/releases'
const RELEASE_FILES = 'https://github.com/anomalyco/opencode/releases/download'

interface VendorRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string
  assets: { name: string; browser_download_url: string; digest?: string | null }[]
}

/** Stable OpenCode only. The separately resolved opencode2 preview is external. */
export const opencodeManagedInstall: HarnessInstall = {
  async latest(ports) {
    const name = await archiveName(ports)
    const release = parseRelease(await ports.fetchText(`${RELEASE_API}/latest`))
    assetFor(release, name)
    return { version: release.tag_name.slice(1) }
  },
  async install(release, dir, ports) {
    requireStableVersion(release.version)
    const name = await archiveName(ports)
    const metadata = parseRelease(await ports.fetchText(`${RELEASE_API}/tags/v${release.version}`))
    if (metadata.tag_name !== `v${release.version}`)
      throw new Error('OpenCode release metadata does not match the requested version')
    const asset = assetFor(metadata, name)
    const integrity = integrityFor(asset.digest, metadata.published_at, name)
    const archive = join(dir, '.opencode-download')
    const executable = ports.platform === 'win32' ? 'opencode.exe' : 'opencode'
    try {
      await ports.fetch(asset.browser_download_url, archive)
      if (integrity.kind === 'sha256') {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(archive)) hash.update(chunk)
        if (hash.digest('hex') !== integrity.digest)
          throw new Error('OpenCode archive checksum verification FAILED')
      }
      // Read just the named regular file. Archive paths and links never become
      // filesystem paths, and neither a vendor script nor an OS tool runs.
      const path = join(dir, executable)
      await extractReleaseFile(
        archive,
        name.endsWith('.tar.gz') ? 'tar.gz' : 'zip',
        executable,
        dir,
        executable,
      )
      await chmod(path, 0o755)
      return { executable, integrity, source: asset.browser_download_url }
    } finally {
      await rm(archive, { force: true })
    }
  },
}

function requireStableVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('OpenCode release must be a stable version in X.Y.Z form')
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
    throw new Error('OpenCode metadata must describe a published stable release')
  requireStableVersion(release.tag_name.slice(1))
  return release
}

/** Asset names published in the stable GitHub release, including musl builds. */
async function archiveName(ports: HarnessCheckPorts): Promise<string> {
  const os = ports.platform === 'win32' ? 'windows' : ports.platform
  const arch =
    ports.arch === 'x64' || ports.arch === 'x86_64'
      ? 'x64'
      : ports.arch === 'arm64' || ports.arch === 'aarch64'
        ? 'arm64'
        : undefined
  if (!['linux', 'darwin', 'windows'].includes(os) || !arch)
    throw new Error(`OpenCode has no standalone release for ${ports.platform}/${ports.arch}`)
  const musl = os === 'linux' && (await ports.isMusl()) ? '-musl' : ''
  return `opencode-${os}-${arch}${musl}.${os === 'linux' ? 'tar.gz' : 'zip'}`
}

function assetFor(release: VendorRelease, name: string): VendorRelease['assets'][number] {
  const asset = release.assets.find((candidate) => candidate?.name === name)
  if (!asset) throw new Error(`OpenCode ${release.tag_name} has no published ${name}`)
  if (asset.browser_download_url !== `${RELEASE_FILES}/${release.tag_name}/${name}`)
    throw new Error('OpenCode asset has an unexpected download URL')
  return asset
}

function integrityFor(
  digest: string | null | undefined,
  publishedAt: string,
  name: string,
): ReleaseIntegrityProof {
  if (digest === null || digest === undefined || digest === '')
    return {
      kind: 'none',
      reason: `The OpenCode GitHub release publishes no asset digest for ${name}.`,
    }
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(digest))
    throw new Error('OpenCode asset has an invalid SHA-256 digest')
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt)))
    throw new Error('OpenCode release has no valid publication time for its checksum')
  return { kind: 'sha256', digest: digest.slice(7).toLowerCase(), publishedAt }
}
