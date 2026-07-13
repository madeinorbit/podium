/**
 * Machine inventory builder (#222): os/arch + per-harness install/version/login
 * for all 5 HarnessAgent kinds. Probes never throw — a missing CLI is data
 * (`installed: false`), mirroring the apps/server/src/model-probe.ts convention
 * (injectable exec, per-call timeout, every failure caught).
 */

import { execFile } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentInventory, HarnessAgent, Inventory } from '@podium/protocol'
import { cursorBinCandidates } from '../cursor/cli.js'
import { opencodeBinCandidates } from '../opencode/cli.js'
import { detectHarnessLogin } from './detect-login.js'

const execFileAsync = promisify(execFile)

/** Runs `argv` → stdout. Injectable so tests never shell out. */
export type ProbeExec = (argv: readonly string[], timeoutMs: number) => Promise<string>

const defaultExec: ProbeExec = async (argv, timeoutMs) => {
  const [cmd, ...args] = argv
  const { stdout } = await execFileAsync(cmd as string, args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

const VERSION_TIMEOUT_MS = 5000

const ALL_KINDS: HarnessAgent[] = ['claude-code', 'codex', 'grok', 'opencode', 'cursor']

/** Candidate binary locations per kind, in priority order. Known install paths
 *  before the bare PATH name — the daemon's systemd PATH often omits the
 *  per-user bin dirs that interactive shells include. */
function binCandidates(kind: HarnessAgent, home: string): string[] {
  switch (kind) {
    case 'claude-code':
      return [join(home, '.local', 'bin', 'claude'), 'claude']
    case 'codex':
      return [join(home, '.local', 'bin', 'codex'), 'codex']
    case 'grok':
      return [join(home, '.local', 'bin', 'grok'), 'grok']
    case 'opencode':
      return opencodeBinCandidates(home)
    case 'cursor':
      // The Cursor Agent CLI installs as `agent`; some setups expose it as
      // `cursor-agent` on PATH (the name model-probe.ts shells out to).
      return [...cursorBinCandidates(home), 'cursor-agent']
  }
}

async function probeAgent(
  kind: HarnessAgent,
  home: string,
  exec: ProbeExec,
): Promise<AgentInventory> {
  const login = detectHarnessLogin(kind, home)
  for (const candidate of binCandidates(kind, home)) {
    try {
      const version = (await exec([candidate, '--version'], VERSION_TIMEOUT_MS)).trim()
      return {
        kind,
        installed: true,
        ...(version ? { version } : {}),
        path: candidate,
        login,
      }
    } catch {
      // absent / not executable / timed out — try the next candidate
    }
  }
  return { kind, installed: false, login }
}

export interface BuildInventoryOptions {
  /** Home dir the detectors + bin candidates resolve against (tests use a fixture). */
  homeDir?: string
  /** Subprocess runner (tests inject a fake so nothing shells out). */
  exec?: ProbeExec
}

/** Build this machine's inventory: os/arch + all 5 harness kinds in parallel. */
export async function buildInventory(opts: BuildInventoryOptions = {}): Promise<Inventory> {
  const home = opts.homeDir ?? homedir()
  const exec = opts.exec ?? defaultExec
  const agents = await Promise.all(ALL_KINDS.map((kind) => probeAgent(kind, home, exec)))
  // The wire enums cover the platforms Podium daemons actually run on (linux/darwin,
  // x64/arm64). Anything else collapses to the nearest member DELIBERATELY — but warn,
  // so a genuinely unsupported host (win32, riscv64, ia32) surfaces rather than silently
  // reporting false facts a routing consumer would trust.
  const p = platform()
  const a = process.arch
  if (p !== 'linux' && p !== 'darwin') console.warn(`[podium] inventory: unsupported platform '${p}', reporting 'linux'`)
  if (a !== 'x64' && a !== 'arm64') console.warn(`[podium] inventory: unsupported arch '${a}', reporting 'x64'`)
  return {
    os: p === 'darwin' ? 'darwin' : 'linux',
    arch: a === 'arm64' ? 'arm64' : 'x64',
    // podiumVersion stays undefined until #221 lands `podium --version`.
    agents,
  }
}
