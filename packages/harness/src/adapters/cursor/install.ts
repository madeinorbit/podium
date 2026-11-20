/** Cursor's standalone package, including its launcher, Node and assets (POD-7267). */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { extractReleaseDirectory } from '../../inventory/release-archive.js'
import { type HarnessCheckPorts, type HarnessInstall, unsupported } from '../../manifest.js'

export const cursorInstall = unsupported(
  "cursor-agent is distributed through Cursor's own installer (curl https://cursor.com/install | bash)",
)

const INSTALLER = 'https://cursor.com/install'
const DOWNLOADS = 'https://downloads.cursor.com/lab'
const GUARD_PROBE = '--podium-updater-guard-probe'
const GUARD_PROOF = `error: unknown option '${GUARD_PROBE}'`

export const cursorManagedInstall: HarnessInstall = {
  async latest(ports) {
    await releasePlatform(ports)
    // The public installer pins the production build, also returned by the
    // vendor's prod RPC. Read its one download assignment; never execute it.
    const installer = await ports.fetchText(INSTALLER)
    const matches = [
      ...installer.matchAll(
        /^DOWNLOAD_URL="https:\/\/downloads\.cursor\.com\/lab\/([^/\r\n]+)\/\$\{OS\}\/\$\{ARCH\}\/agent-cli-package\.tar\.gz"[ \t]*\r?$/gm,
      ),
    ]
    const version = matches[0]?.[1]
    if (matches.length !== 1)
      throw new Error('Cursor installer does not name exactly one production release')
    requireStableVersion(version)
    return { version }
  },
  async install(release, dir, ports) {
    requireStableVersion(release.version)
    const platform = await releasePlatform(ports)
    const source = `${DOWNLOADS}/${release.version}/${platform}/agent-cli-package.tar.gz`
    const checksumUrl = `${source}.sha256`
    // A checksum is published for the measured package. Missing or invalid
    // checksum responses fail the install rather than silently lowering proof.
    const checksum = (await ports.fetchText(checksumUrl)).trim()
    const digest = /^([a-f0-9]{64}) [ *]agent-cli-package\.tar\.gz$/i
      .exec(checksum)?.[1]
      ?.toLowerCase()
    if (!digest) throw new Error('Cursor archive has no valid published SHA-256 checksum')
    const archive = join(dir, '.cursor-download')
    const executable = 'dist-package/cursor-agent'
    try {
      await ports.fetch(source, archive)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(archive)) hash.update(chunk)
      if (hash.digest('hex') !== digest)
        throw new Error('Cursor archive checksum verification FAILED')
      await extractReleaseDirectory(archive, 'tar.gz', 'dist-package', dir)
      await chmod(join(dir, executable), 0o755)
      // --help/--version bypass unknown-option checks, and command actions
      // initialize vendor services. Instead, a recognized guard must reach the
      // second (deliberately invalid) option's error before any action starts.
      let diagnostic = 'the CLI did not reject the deliberately invalid parser probe'
      try {
        await ports.run(join(dir, executable), ['--disable-auto-update', GUARD_PROBE], {
          ...ports.installerEnv,
          CURSOR_CONFIG_DIR: join(ports.home, '.cursor'),
          CURSOR_DATA_DIR: join(ports.home, '.cursor-data'),
          NODE_COMPILE_CACHE: join(ports.home, '.cache'),
        })
      } catch (error) {
        diagnostic = (error as Error).message
      }
      if (!diagnostic.split(/\r?\n/).includes(GUARD_PROOF)) {
        throw new Error(
          `Cursor ${release.version} cannot be managed: its --disable-auto-update startup guard could not be verified: ${diagnostic}`,
        )
      }
      return {
        executable,
        source,
        // The checksum response supplies no publication time.
        integrity: { kind: 'sha256', digest },
      }
    } finally {
      await rm(archive, { force: true })
    }
  },
}

function requireStableVersion(version: unknown): asserts version is string {
  if (typeof version !== 'string' || !/^\d{4}\.\d{2}\.\d{2}-[a-f0-9]{7,40}$/.test(version))
    throw new Error('Cursor release must be a stable date-and-build version')
}

async function releasePlatform(ports: HarnessCheckPorts): Promise<string> {
  const arch = ['x64', 'x86_64', 'amd64'].includes(ports.arch)
    ? 'x64'
    : ['arm64', 'aarch64'].includes(ports.arch)
      ? 'arm64'
      : undefined
  if (
    !['linux', 'darwin'].includes(ports.platform) ||
    !arch ||
    (ports.platform === 'linux' && (await ports.isMusl()))
  )
    throw new Error(`Cursor has no standalone release for ${ports.platform}/${ports.arch} and libc`)
  return `${ports.platform}/${arch}`
}
