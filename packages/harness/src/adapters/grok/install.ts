/**
 * Grok install layout — the Inventory install section (POD-4414 §4.4).
 *
 * KNOWLEDGE, not mechanism: the vendor installer URL, the shell it runs
 * under, and the env it needs. The temp-dir lifecycle, the fetch, and the
 * `--version` verification around it are the generic mechanism
 * (`inventory/install.ts`) and stay harness-free.
 */
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessCheckPorts, HarnessInstall, HarnessInstallScript } from '../../manifest.js'

export const grokInstall: HarnessInstallScript = {
  binary: 'grok',
  url: (env) => env.PODIUM_GROK_INSTALL_URL ?? 'https://x.ai/cli/install.sh',
  runInstaller(scriptPath, binDir, ports) {
    // Without GROK_BIN_DIR the vendor script installs to the wrong directory.
    ports.runTool('bash', [scriptPath], { ...ports.env, GROK_BIN_DIR: binDir })
  },
}

const RELEASE_BASE = 'https://x.ai/cli'

/**
 * Published standalone releases (POD-7267): no installer, links or profile
 * edits. The vendor publishes no checksum; the mechanism checks --version.
 */
export const grokManagedInstall: HarnessInstall = {
  async latest(ports) {
    releasePlatform(ports)
    const version = (await ports.fetchText(`${RELEASE_BASE}/stable`)).trim()
    requireStableVersion(version)
    return { version }
  },
  async install(release, dir, ports) {
    requireStableVersion(release.version)
    const platform = releasePlatform(ports)
    const extension = ports.platform === 'win32' ? '.exe' : ''
    const executable = `grok${extension}`
    const source = `${RELEASE_BASE}/grok-${release.version}-${platform}${extension}`
    const binary = join(dir, executable)
    await ports.fetch(source, binary)
    chmodSync(binary, 0o755)
    return {
      executable,
      source,
      integrity: {
        kind: 'none',
        reason:
          'Grok publishes no checksum for its standalone binary; the vendor installer only checks that it runs (POD-7267).',
      },
    }
  },
}

function requireStableVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Grok release must be a stable version in X.Y.Z form')
}

/** Platform names used by the vendor's install.sh, not Node's names. */
function releasePlatform(ports: Pick<HarnessCheckPorts, 'platform' | 'arch'>): string {
  const os =
    ports.platform === 'linux'
      ? 'linux'
      : ports.platform === 'darwin'
        ? 'macos'
        : ports.platform === 'win32'
          ? 'windows'
          : undefined
  const arch =
    ports.arch === 'x64' || ports.arch === 'x86_64'
      ? 'x86_64'
      : ports.arch === 'arm64' || ports.arch === 'aarch64'
        ? 'aarch64'
        : undefined
  if (!os || !arch)
    throw new Error(`Grok has no standalone release for ${ports.platform}/${ports.arch}`)
  return `${os}-${arch}`
}
