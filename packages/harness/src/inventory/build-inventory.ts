/**
 * Machine inventory builder (#222): os/arch + per-harness install/version/login
 * for all 5 HarnessAgent kinds. Probes never throw — a missing CLI is data
 * (`installed: false`), mirroring the ./model-probe.ts convention
 * (injectable exec, per-call timeout, every failure caught).
 */

import { execFile } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { declaredValue, type AgentManifest } from '../manifest.js'
import { AGENT_MANIFESTS } from '../registry.js'
import type { AgentInventory, Inventory, ToolInventory } from '@podium/model'

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
  manifest: AgentManifest,
  home: string,
  exec: ProbeExec,
): Promise<AgentInventory> {
  const detected = manifest.inventory.detectLogin(home)
  const identityReader = declaredValue(manifest.inventory.loginIdentity)
  let identity: ReturnType<NonNullable<typeof identityReader>> | undefined
  try {
    identity = identityReader?.(home)
  } catch {
    // Login identity is best-effort metadata; a broken reader must not hide the
    // install/version facts or turn inventory into an unavailable report.
  }
  const login = identity ? { ...detected, identity } : detected
  for (const candidate of manifest.inventory.binCandidates(home)) {
    try {
      const version = (await exec([candidate, '--version'], VERSION_TIMEOUT_MS)).trim()
      const identityProbe = manifest.inventory.identityProbe
      if (identityProbe) {
        const identity = await exec([candidate, ...identityProbe.args], VERSION_TIMEOUT_MS)
        if (!identityProbe.accepts(identity)) continue
      }
      return {
        kind: manifest.kind,
        installed: true,
        ...(version ? { version } : {}),
        path: candidate,
        login,
      }
    } catch {
      // absent / not executable / timed out — try the next candidate
    }
  }
  return { kind: manifest.kind, installed: false, login }
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

/**
 * The RESOLVED harness inventory for ONE machine — which CLIs are installed
 * there, at which versions, logged in as whom.
 *
 * KEYED BY `machineId`, deliberately and from the start. This is the other half of
 * the manifest/inventory split: an `AgentManifest` is static in-repo code that is
 * the same for everyone and carries no identity, while THIS is a per-machine FACT
 * about somebody's computer. Per ADR 1 Amendment 1 (POD-1071) D13.5, harness and
 * model inventory is a per-machine fact that INHERITS its machine's scoping and
 * carries no owner of its own: visibility class **`owned-compute`**, owner
 * `inherits Machine`, grant verbs `see` / `use` / `manage` (D13.1). It is
 * explicitly NOT tenant-visible infrastructure — readiness §3.1.1 corrects an
 * earlier draft that said it was, on the human direction that "a personal mac
 * shouldn't be accessible for everyone in the team to run agents".
 *
 * WHY THE ID LIVES ON THE VALUE rather than being stapled on by whoever sends it:
 * an inventory that does not name its machine can be cached as an instance-global
 * singleton without anything looking wrong, and once one exists, scoping it per
 * machine means re-cutting this seam. Carrying the id makes "which machine is this
 * about?" unanswerable-by-accident, so POD-1079 can attach machine grants to it
 * without touching this package. A server-side cache of these MUST be keyed by
 * `machineId` — never a single current value.
 *
 * This type carries no principal: no owner, no user id, no grant. Authorization is
 * applied at the server projection boundary (POD-1079); the daemon that produces
 * this runs as a system principal, which per readiness §3.1.6 S5 may read across
 * owners but never acts as a person and never widens anyone's visibility.
 */
export interface MachineHarnessInventory {
  /** The machine this fact is ABOUT — the scoping key, not decoration. */
  readonly machineId: string
  readonly inventory: Inventory
}

export interface BuildMachineInventoryOptions extends BuildInventoryOptions {
  /** REQUIRED: the machine being probed. There is no "current machine" default on
   *  purpose — an implicit one is how an instance-global singleton gets born. */
  machineId: string
}

/**
 * Probe this host and return the result already keyed to the machine it describes.
 * The preferred entry point: {@link buildInventory} produces the same payload but
 * unkeyed, which is only safe when the caller immediately attaches the id itself.
 */
export async function buildMachineInventory(
  opts: BuildMachineInventoryOptions,
): Promise<MachineHarnessInventory> {
  const { machineId, ...probeOpts } = opts
  return { machineId, inventory: await buildInventory(probeOpts) }
}

/**
 * Build this host's inventory payload: os/arch + every builtin harness kind in
 * parallel. UNKEYED — prefer {@link buildMachineInventory}, which returns the same
 * facts already bound to the machine they describe. Kept exported because the
 * probe itself is machine-agnostic (it probes whatever host it runs on) and the
 * tests drive it directly with a fake exec.
 */
export async function buildInventory(opts: BuildInventoryOptions = {}): Promise<Inventory> {
  const home = opts.homeDir ?? homedir()
  const exec = opts.exec ?? defaultExec
  const [agents, tools] = await Promise.all([
    Promise.all(Object.values(AGENT_MANIFESTS).map((manifest) => probeAgent(manifest, home, exec))),
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
