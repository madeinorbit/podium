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
import type { AgentInventory, Inventory, ToolInventory } from '@podium/protocol'
import type { HarnessAdapter } from '../harness/adapter.js'
import { HARNESS_ADAPTERS } from '../harness/registry.js'

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

async function probeAgent(
  adapter: HarnessAdapter,
  home: string,
  exec: ProbeExec,
): Promise<AgentInventory> {
  const login = adapter.inventory.detectLogin(home)
  for (const candidate of adapter.inventory.binCandidates(home)) {
    try {
      const version = (await exec([candidate, '--version'], VERSION_TIMEOUT_MS)).trim()
      return {
        kind: adapter.kind,
        installed: true,
        ...(version ? { version } : {}),
        path: candidate,
        login,
      }
    } catch {
      // absent / not executable / timed out — try the next candidate
    }
  }
  return { kind: adapter.kind, installed: false, login }
}

/** Non-harness CLIs to probe. Just `gh` today — #214's credential-propagation
 *  form needs to know whether a machine can receive a gh credential. */
const ALL_TOOLS = ['gh'] as const

function toolCandidates(name: string, home: string): string[] {
  return [join(home, '.local', 'bin', name), name]
}

async function probeTool(name: string, home: string, exec: ProbeExec): Promise<ToolInventory> {
  for (const candidate of toolCandidates(name, home)) {
    try {
      // `gh --version` is multi-line ("gh version X (date)\nhttps://…"); keep the
      // first line — the useful part — and let a consumer parse further if needed.
      const version = (await exec([candidate, '--version'], VERSION_TIMEOUT_MS))
        .split('\n')[0]
        ?.trim()
      return { name, installed: true, ...(version ? { version } : {}), path: candidate }
    } catch {
      // absent / not executable / timed out — try the next candidate
    }
  }
  return { name, installed: false }
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
  const [agents, tools] = await Promise.all([
    Promise.all(Object.values(HARNESS_ADAPTERS).map((adapter) => probeAgent(adapter, home, exec))),
    Promise.all(ALL_TOOLS.map((name) => probeTool(name, home, exec))),
  ])
  // The wire enums cover the platforms Podium daemons actually run on (linux/darwin,
  // x64/arm64). Anything else collapses to the nearest member DELIBERATELY — but warn,
  // so a genuinely unsupported host (win32, riscv64, ia32) surfaces rather than silently
  // reporting false facts a routing consumer would trust.
  const p = platform()
  const a = process.arch
  if (p !== 'linux' && p !== 'darwin')
    console.warn(`[podium] inventory: unsupported platform '${p}', reporting 'linux'`)
  if (a !== 'x64' && a !== 'arm64')
    console.warn(`[podium] inventory: unsupported arch '${a}', reporting 'x64'`)
  return {
    os: p === 'darwin' ? 'darwin' : 'linux',
    arch: a === 'arm64' ? 'arm64' : 'x64',
    // Must stay the literal `process.env.PODIUM_APP_VERSION` read: build-bun --define
    // inlines it at build time; 'dev' when running from source. [POD-838]
    podiumVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
    agents,
    tools,
  }
}
