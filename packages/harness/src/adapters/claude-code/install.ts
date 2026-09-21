/**
 * Claude Code install layout — the Inventory install section (POD-4414 §4.4).
 *
 * KNOWLEDGE, not mechanism: the vendor installer URL, the standalone release
 * base, and the checksum-verified fallback. The temp-dir lifecycle, the fetch,
 * and the `--version` verification around it are the generic mechanism
 * (`inventory/install.ts`) and stay harness-free.
 */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessInstall, HarnessInstallPorts } from '../../manifest.js'

export const claudeCodeInstall: HarnessInstall = {
  binary: 'claude',
  url: (env) => env.PODIUM_CLAUDE_INSTALL_URL ?? 'https://claude.ai/install.sh',
  runInstaller(scriptPath, binDir, ports) {
    try {
      ports.run('bash', [scriptPath, 'stable'], ports.env)
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
  ports: Pick<HarnessInstallPorts, 'fetch' | 'env' | 'arch' | 'isMusl'>,
): void {
  const env = ports.env
  const arch = ports.arch
  const releaseBase =
    env.PODIUM_CLAUDE_RELEASE_BASE_URL ?? 'https://downloads.claude.ai/claude-code-releases'
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
    const manifest = readFileSync(join(tmp, 'manifest.json'), 'utf8')
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

/** The vendor's manifest, read the way install.sh's sed did: 64 lowercase hex, or nothing. */
function checksumFor(manifest: string, platform: string): string | undefined {
  const escaped = platform.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = manifest
    .replace(/[\n\r\t]/g, '')
    .match(new RegExp(`"${escaped}"\\s*:\\s*\\{[^}]*"checksum"\\s*:\\s*"([0-9a-f]{64})"`))
  return m?.[1]
}
