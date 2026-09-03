/**
 * The vendor agent CLIs the "Add machine" command asks for — ported from install.sh:197-252
 * and :442-481 (POD-3274).
 *
 * These are third-party installers we download and run unattended. Behind the handoff they
 * each get a spinner and their output is CAPTURED, surfaced only when one fails: on a healthy
 * install three vendors' progress bars scrolling past told the operator nothing, and on a
 * broken one the failure was buried in them.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SetupIO } from './setup-ui'

export const AGENT_IDS = ['codex', 'claude-code', 'grok'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export interface AgentInstallResult {
  id: AgentId
  ok: boolean
  detail?: string
}

export interface InstallAgentsDeps {
  /** Download a URL to a path. Never forwards a GitHub auth token — these are vendor hosts. */
  fetch?: (url: string, out: string) => void
  /** Run a command, returning its combined output; throws with that output on failure. */
  run?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => string
  env?: NodeJS.ProcessEnv
  arch?: string
  /** Whether this box's libc is musl — Claude ships a separate build for it. */
  isMusl?: () => boolean
}

export function isAgentId(v: string): v is AgentId {
  return (AGENT_IDS as readonly string[]).includes(v)
}

function defaultRun(cmd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function defaultFetch(url: string, out: string): void {
  // curl or wget, whichever this box has — the same fallback install.sh made.
  try {
    execFileSync('curl', ['-fsSL', url, '-o', out], { stdio: 'ignore' })
  } catch {
    execFileSync('wget', ['-qO', out, url], { stdio: 'ignore' })
  }
}

/**
 * Claude's official installer downloads and checksum-verifies a standalone binary, then asks
 * that binary to self-stage. Some minimal/container runtimes expose the emulator or launcher
 * as /proc/self/exe, so that final self-stage can fail even though the official binary is
 * valid. This reproduces the vendor's manifest verification and installs that same
 * architecture-specific binary directly — a resilient fallback, never a weaker one.
 */
export function installClaudeStandalone(binDir: string, deps: InstallAgentsDeps = {}): void {
  const env = deps.env ?? process.env
  const fetch = deps.fetch ?? defaultFetch
  const arch = deps.arch ?? process.arch
  const releaseBase =
    env.PODIUM_CLAUDE_RELEASE_BASE_URL ?? 'https://downloads.claude.ai/claude-code-releases'
  const claudeArch = arch === 'x64' || arch === 'x86_64' ? 'x64' : 'arm64'
  const platform = (deps.isMusl ?? isMusl)() ? `linux-${claudeArch}-musl` : `linux-${claudeArch}`

  const tmp = mkdtempSync(join(tmpdir(), 'podium-claude-'))
  try {
    fetch(`${releaseBase}/latest`, join(tmp, 'latest'))
    const version = readFileSync(join(tmp, 'latest'), 'utf8').trim()
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error('Claude release endpoint returned an invalid version')
    }
    if (/[^0-9A-Za-z.+-]/.test(version)) {
      throw new Error('Claude release endpoint returned an unsafe version')
    }

    fetch(`${releaseBase}/${version}/manifest.json`, join(tmp, 'manifest.json'))
    const manifest = readFileSync(join(tmp, 'manifest.json'), 'utf8')
    const checksum = checksumFor(manifest, platform)
    if (!checksum) throw new Error(`Claude manifest has no valid checksum for ${platform}`)

    const binary = join(tmp, 'claude')
    fetch(`${releaseBase}/${version}/${platform}/claude`, binary)
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

function isMusl(): boolean {
  try {
    return execFileSync('ldd', ['/bin/ls'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).includes('musl')
  } catch {
    return false
  }
}

export async function installAgents(
  io: SetupIO,
  ids: string[],
  binDir: string,
  deps: InstallAgentsDeps = {},
): Promise<AgentInstallResult[]> {
  const env = deps.env ?? process.env
  const fetch = deps.fetch ?? defaultFetch
  const run = deps.run ?? defaultRun
  const results: AgentInstallResult[] = []

  for (const raw of ids) {
    if (!isAgentId(raw)) throw new Error(`podium install: unsupported agent '${raw}'`)
    const id: AgentId = raw
    const spin = io.spinner()
    spin.start(`Installing ${LABELS[id]}`)
    const tmp = mkdtempSync(join(tmpdir(), `podium-${id}-`))
    const script = join(tmp, 'install.sh')
    try {
      fetch(urlFor(id, env), script)
      switch (id) {
        case 'codex':
          run('sh', [script], { ...env, CODEX_NON_INTERACTIVE: '1', CODEX_INSTALL_DIR: binDir })
          break
        case 'claude-code':
          try {
            run('bash', [script, 'stable'], env)
          } catch {
            // Not a failure the operator has to act on yet — say what we are doing instead.
            spin.stop(
              "Claude's self-installer could not stage the binary; using the checksum-verified standalone fallback…",
            )
            spin.start('Installing Claude Code (standalone)')
            installClaudeStandalone(binDir, deps)
          }
          break
        case 'grok':
          run('bash', [script], { ...env, GROK_BIN_DIR: binDir })
          break
      }
      run(join(binDir, BINARIES[id]), ['--version'], env)
      spin.stop(`${LABELS[id]} installed`)
      results.push({ id, ok: true })
    } catch (e) {
      // The vendor's own output is the useful part, and it is only useful on a failure.
      const detail = (e as Error).message
      spin.error(`${LABELS[id]} failed to install`)
      io.error(detail)
      results.push({ id, ok: false, detail })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  return results
}

const LABELS: Record<AgentId, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  grok: 'Grok',
}
const BINARIES: Record<AgentId, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  grok: 'grok',
}

function urlFor(id: AgentId, env: NodeJS.ProcessEnv): string {
  switch (id) {
    case 'codex':
      return env.PODIUM_CODEX_INSTALL_URL ?? 'https://chatgpt.com/codex/install.sh'
    case 'claude-code':
      return env.PODIUM_CLAUDE_INSTALL_URL ?? 'https://claude.ai/install.sh'
    case 'grok':
      return env.PODIUM_GROK_INSTALL_URL ?? 'https://x.ai/cli/install.sh'
  }
}
