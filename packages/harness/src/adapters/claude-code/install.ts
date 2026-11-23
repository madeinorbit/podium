/**
 * Claude Code install layout — the Inventory install section (POD-4414 §4.4).
 *
 * The legacy script and its standalone fallback stay available until callers
 * move to managed installs. Managed releases use that same published binary
 * and manifest directly, without running the vendor's self-installer.
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { chmod, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessCheckPorts,
  HarnessInstall,
  HarnessInstallScript,
  HarnessInstallScriptPorts,
} from '../../manifest.js'

const RELEASE_BASE = 'https://downloads.claude.ai/claude-code-releases'

interface ClaudeReleaseManifest {
  version?: string
  buildDate?: string
  platforms?: Record<string, { binary?: string; checksum?: string }>
}

/** Stable, checksum-verified standalone releases (POD-7267, design §5.3). */
export const claudeCodeManagedInstall: HarnessInstall = {
  async latest(ports) {
    await releasePlatform(ports)
    const version = (await ports.fetchText(`${RELEASE_BASE}/stable`)).trim()
    requireStableVersion(version)
    return { version }
  },
  async install(release, dir, ports) {
    requireStableVersion(release.version)
    const platform = await releasePlatform(ports)
    const base = `${RELEASE_BASE}/${release.version}`
    const manifest = JSON.parse(
      await ports.fetchText(`${base}/manifest.json`),
    ) as ClaudeReleaseManifest | null
    if (manifest?.version !== release.version)
      throw new Error('Claude release manifest does not match the requested version')
    const checksum = checksumFor(manifest, platform)
    if (!checksum) throw new Error(`Claude manifest has no valid checksum for ${platform}`)
    if (typeof manifest.buildDate !== 'string' || !Number.isFinite(Date.parse(manifest.buildDate)))
      throw new Error('Claude manifest has no valid build date for its checksum')

    const executable = ports.platform === 'win32' ? 'claude.exe' : 'claude'
    if (manifest.platforms?.[platform]?.binary !== executable)
      throw new Error(`Claude manifest has no published ${executable} for ${platform}`)
    const source = `${base}/${platform}/${executable}`
    const staged = join(dir, '.claude-download')
    try {
      await ports.fetch(source, staged)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(staged)) hash.update(chunk)
      const digest = hash.digest('hex')
      if (digest !== checksum) throw new Error('Claude standalone checksum verification FAILED')
      await chmod(staged, 0o755)
      await rename(staged, join(dir, executable))
      return {
        executable,
        source,
        integrity: { kind: 'sha256', digest, publishedAt: manifest.buildDate },
      }
    } finally {
      await rm(staged, { force: true })
    }
  },
}

function requireStableVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Claude release must be a stable version in X.Y.Z form')
}

/** Platform keys from the vendor's manifest, including measured Windows names. */
async function releasePlatform(ports: HarnessCheckPorts): Promise<string> {
  const arch =
    ports.arch === 'x64' || ports.arch === 'x86_64'
      ? 'x64'
      : ports.arch === 'arm64' || ports.arch === 'aarch64'
        ? 'arm64'
        : undefined
  if (!['linux', 'darwin', 'win32'].includes(ports.platform) || !arch)
    throw new Error(`Claude has no standalone release for ${ports.platform}/${ports.arch}`)
  const musl = ports.platform === 'linux' && (await ports.isMusl()) ? '-musl' : ''
  return `${ports.platform}-${arch}${musl}`
}

export const claudeCodeInstall: HarnessInstallScript = {
  binary: 'claude',
  url: (env) => env.PODIUM_CLAUDE_INSTALL_URL ?? 'https://claude.ai/install.sh',
  runInstaller(scriptPath, binDir, ports) {
    try {
      ports.runTool('bash', [scriptPath, 'stable'], ports.env)
    } catch {
      // Not a failure the operator has to act on yet — say what we are doing instead.
      ports.note?.(
        "Claude's self-installer could not stage the binary; using the checksum-verified standalone fallback…",
      )
      installClaudeStandalone(binDir, ports)
    }
  },
}

/**
 * Claude's official installer downloads and checksum-verifies a standalone binary, then asks
 * that binary to self-stage. Some minimal/container runtimes expose the emulator or launcher
 * as /proc/self/exe, so that final self-stage can fail even though the official binary is
 * valid. This reproduces the vendor's manifest verification and installs that same
 * architecture-specific binary directly — a resilient fallback, never a weaker one.
 */
export function installClaudeStandalone(
  binDir: string,
  ports: Pick<HarnessInstallScriptPorts, 'fetch' | 'env' | 'arch' | 'isMusl'>,
): void {
  const env = ports.env
  const arch = ports.arch
  const releaseBase = env.PODIUM_CLAUDE_RELEASE_BASE_URL ?? RELEASE_BASE
  const claudeArch = arch === 'x64' || arch === 'x86_64' ? 'x64' : 'arm64'
  const platform = ports.isMusl() ? `linux-${claudeArch}-musl` : `linux-${claudeArch}`

  const tmp = mkdtempSync(join(tmpdir(), 'podium-claude-'))
  try {
    ports.fetch(`${releaseBase}/latest`, join(tmp, 'latest'))
    const version = readFileSync(join(tmp, 'latest'), 'utf8').trim()
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error('Claude release endpoint returned an invalid version')
    }
    if (/[^0-9A-Za-z.+-]/.test(version)) {
      throw new Error('Claude release endpoint returned an unsafe version')
    }

    ports.fetch(`${releaseBase}/${version}/manifest.json`, join(tmp, 'manifest.json'))
    const manifest = JSON.parse(
      readFileSync(join(tmp, 'manifest.json'), 'utf8'),
    ) as ClaudeReleaseManifest | null
    const checksum = checksumFor(manifest, platform)
    if (!checksum) throw new Error(`Claude manifest has no valid checksum for ${platform}`)

    const binary = join(tmp, 'claude')
    ports.fetch(`${releaseBase}/${version}/${platform}/claude`, binary)
    const actual = createHash('sha256').update(readFileSync(binary)).digest('hex')
    if (actual !== checksum) throw new Error('Claude standalone checksum verification FAILED')

    // Stage beside the target, then rename: a half-written binary must never be reachable
    // under the real name.
    const staged = join(binDir, `.claude.podium-${process.pid}`)
    copyFileSync(binary, staged)
    chmodSync(staged, 0o755)
    renameSync(staged, join(binDir, 'claude'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** The vendor's manifest: 64 lowercase hex for exactly this platform, or nothing. */
function checksumFor(manifest: ClaudeReleaseManifest | null, platform: string): string | undefined {
  const checksum = manifest?.platforms?.[platform]?.checksum
  return typeof checksum === 'string' && /^[0-9a-f]{64}$/.test(checksum) ? checksum : undefined
}
