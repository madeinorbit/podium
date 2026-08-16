/**
 * Machine inventory and verified executable snapshot for one command-environment
 * generation. Probes never throw: a missing CLI is `installed: false`, while a
 * bounded probe that expires is explicitly unknown (`installed: null`).
 */
import { execFile } from 'node:child_process'
import { homedir, platform as nodePlatform } from 'node:os'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import type { AgentInventory, Inventory, MachineId, ToolInventory } from '@podium/model'
import {
  createCommandEnvironment,
  type CommandEnvironment,
} from '@podium/runtime/command-environment'
import {
  type AgentManifest,
  declaredValue,
  type LoginCommandResult,
  type HarnessLogin,
} from '../manifest.js'
import { AGENT_MANIFESTS } from '../registry.js'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '../version-probe.js'

const log = createLogger('harness:inventory')
const execFileAsync = promisify(execFile)
const PROBE_OUTPUT_LIMIT_BYTES = 1024 * 1024

/** Runs argv with the generation environment. Injectable so tests never shell out. */
export type ProbeExec = (
  argv: readonly string[],
  timeoutMs: number,
  env?: Readonly<Record<string, string>>,
) => Promise<string>

const defaultExec: ProbeExec = async (argv, timeoutMs, env) => {
  const [cmd, ...args] = argv
  const { stdout } = await execFileAsync(cmd as string, args, {
    timeout: timeoutMs,
    maxBuffer: PROBE_OUTPUT_LIMIT_BYTES,
    ...(env ? { env } : {}),
  })
  return stdout
}

export interface ResolvedHarnessExecutable {
  readonly kind: AgentManifest['kind']
  readonly path: string
  readonly version?: string
  readonly generation: number
}

export interface ResolvedHarnessInventory {
  readonly inventory: Inventory
  readonly executables: ReadonlyMap<AgentManifest['kind'], ResolvedHarnessExecutable>
  readonly commandEnvironment: CommandEnvironment
}

function candidatePaths(
  manifest: AgentManifest,
  environment: CommandEnvironment,
  legacyInjectedExec: boolean,
): string[] {
  const declaration = manifest.inventory.executable
  const candidates = [
    ...declaration.names,
    ...(declaration.fallbackCandidates?.(environment.machineHome) ?? []),
  ]
  const resolved: string[] = []
  for (const candidate of candidates) {
    const path = environment.resolve(candidate) ?? (legacyInjectedExec ? candidate : undefined)
    if (path && !resolved.includes(path)) resolved.push(path)
  }
  return resolved
}

/** Node's execFile timeout error is not a distinct class: it reports a killed
 * child (and some injected/process wrappers report ETIMEDOUT instead). Keep the
 * classification here so an expired observation never becomes an absence fact. */
function probeTimedOut(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const details = error as Error & { code?: unknown; killed?: unknown }
  return (
    details.killed === true ||
    details.code === 'ETIMEDOUT' ||
    /(?:^|\s)ETIMEDOUT(?:\s|$)/i.test(error.message)
  )
}

async function probeAgent(
  manifest: AgentManifest,
  credentialHome: string,
  environment: CommandEnvironment,
  exec: ProbeExec,
  loginExec: LoginProbeExec,
  legacyInjectedExec: boolean,
  hostPlatform: NodeJS.Platform,
): Promise<{ inventory: AgentInventory; executable?: ResolvedHarnessExecutable }> {
  let detected: HarnessLogin
  try {
    detected = manifest.inventory.detectLogin(credentialHome)
  } catch {
    detected = { state: 'unknown' }
  }
  const identityReader = declaredValue(manifest.inventory.loginIdentity)
  let identity: ReturnType<NonNullable<typeof identityReader>> | undefined
  try {
    identity = identityReader?.(credentialHome)
  } catch {
    // Login identity is best-effort metadata.
  }
  const fallbackLogin = identity ? { ...detected, identity } : detected
  const commandProbe = declaredValue(manifest.inventory.loginCommandProbe)
  const declaration = manifest.inventory.executable
  let timedOut = false
  for (const candidate of candidatePaths(manifest, environment, legacyInjectedExec)) {
    try {
      const version = (
        await exec(
          [candidate, ...declaration.versionArgs],
          AGENT_VERSION_PROBE_TIMEOUT_MS,
          environment.env,
        )
      ).trim()
      if (declaration.identityProbe) {
        const output = await exec(
          [candidate, ...declaration.identityProbe.args],
          AGENT_VERSION_PROBE_TIMEOUT_MS,
          environment.env,
        )
        if (!declaration.identityProbe.accepts(output)) continue
      }
      const executable: ResolvedHarnessExecutable = Object.freeze({
        kind: manifest.kind,
        path: candidate,
        ...(version ? { version } : {}),
        generation: environment.generation,
      })
      let login = fallbackLogin
      if (commandProbe) {
        try {
          const decision = commandProbe.classify(
            await loginExec(
              [candidate, ...commandProbe.args],
              commandProbe.timeoutMs,
              environment.env,
            ),
          )
          login =
            decision.kind === 'determined'
              ? decision.login
              : decision.kind === 'fallback'
                ? fallbackLogin
                : { state: 'unknown' }
        } catch {
          login = { state: 'unknown' }
        }
      }
      return {
        inventory: {
          kind: manifest.kind,
          installed: true,
          ...(version ? { version } : {}),
          path: candidate,
          login,
        },
        executable,
      }
    } catch (error) {
      timedOut ||= probeTimedOut(error)
      // Missing, wrong identity, or no longer executable: try the declaration's next path.
    }
  }
  const login =
    commandProbe && hostPlatform === 'darwin' && fallbackLogin.state === 'out'
      ? { state: 'unknown' as const }
      : fallbackLogin
  if (timedOut)
    return {
      inventory: {
        kind: manifest.kind,
        installed: null,
        probeError: { reason: 'timed-out', timeoutMs: AGENT_VERSION_PROBE_TIMEOUT_MS },
        login,
      },
    }
  return { inventory: { kind: manifest.kind, installed: false, login } }
}

async function probeTool(
  name: string,
  environment: CommandEnvironment,
  exec: ProbeExec,
  legacyInjectedExec: boolean,
): Promise<ToolInventory> {
  const candidate = environment.resolve(name) ?? (legacyInjectedExec ? name : undefined)
  if (!candidate) return { name, installed: false }
  try {
    const version = (
      await exec([candidate, '--version'], AGENT_VERSION_PROBE_TIMEOUT_MS, environment.env)
    )
      .split('\n')[0]
      ?.trim()
    return { name, installed: true, ...(version ? { version } : {}), path: candidate }
  } catch (error) {
    if (probeTimedOut(error))
      return {
        name,
        installed: null,
        probeError: { reason: 'timed-out', timeoutMs: AGENT_VERSION_PROBE_TIMEOUT_MS },
      }
    return { name, installed: false }
  }
}

export interface BuildInventoryOptions {
  /** OS account home used only for executable fallbacks. */
  machineHome?: string
  /** Credential/config home used only by provider login readers. */
  credentialHome?: string
  /** @deprecated Test compatibility. Prefer explicit machineHome + credentialHome. */
  homeDir?: string
  commandEnvironment?: CommandEnvironment
  exec?: ProbeExec
  loginExec?: LoginProbeExec
  platform?: NodeJS.Platform
  generation?: number
}

export interface MachineHarnessInventory {
  readonly machineId: MachineId
  readonly inventory: Inventory
}

export interface BuildMachineInventoryOptions extends BuildInventoryOptions {
  machineId: MachineId
}

function inventoryPlatformFields(
  p: NodeJS.Platform,
): Pick<Inventory, 'os' | 'arch' | 'podiumVersion'> {
  const a = process.arch
  if (p !== 'linux' && p !== 'darwin')
    log.warn('unsupported platform, reporting linux', { platform: p })
  if (a !== 'x64' && a !== 'arm64') log.warn('unsupported arch, reporting x64', { arch: a })
  return {
    os: p === 'darwin' ? 'darwin' : 'linux',
    arch: a === 'arm64' ? 'arm64' : 'x64',
    podiumVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
  }
}

export async function buildResolvedInventory(
  opts: BuildInventoryOptions = {},
): Promise<ResolvedHarnessInventory> {
  const machineHome = opts.machineHome ?? opts.homeDir ?? homedir()
  const credentialHome = opts.credentialHome ?? opts.homeDir ?? machineHome
  const hostPlatform = opts.platform ?? nodePlatform()
  const commandEnvironment =
    opts.commandEnvironment ??
    (await createCommandEnvironment({
      machineHome,
      generation: opts.generation ?? 0,
      platform: hostPlatform,
    }))
  const exec = opts.exec ?? defaultExec
  const loginExec = opts.loginExec ?? (opts.exec ? unavailableInjectedLoginExec : defaultLoginExec)
  // Historical tests inject an argv responder rather than executable fixture files.
  const legacyInjectedExec = Boolean(opts.exec && !opts.commandEnvironment)
  const [agentResults, tools] = await Promise.all([
    Promise.all(
      Object.values(AGENT_MANIFESTS).map((manifest) =>
        probeAgent(
          manifest,
          credentialHome,
          commandEnvironment,
          exec,
          loginExec,
          legacyInjectedExec,
          hostPlatform,
        ),
      ),
    ),
    Promise.all(
      ['gh'].map((name) => probeTool(name, commandEnvironment, exec, legacyInjectedExec)),
    ),
  ])
  const executables = new Map<AgentManifest['kind'], ResolvedHarnessExecutable>()
  for (const result of agentResults) {
    if (result.executable) executables.set(result.executable.kind, result.executable)
  }
  return Object.freeze({
    inventory: {
      ...inventoryPlatformFields(hostPlatform),
      agents: agentResults.map((result) => result.inventory),
      tools,
    },
    executables,
    commandEnvironment,
  })
}

export async function buildInventory(opts: BuildInventoryOptions = {}): Promise<Inventory> {
  return (await buildResolvedInventory(opts)).inventory
}

export async function buildMachineInventory(
  opts: BuildMachineInventoryOptions,
): Promise<MachineHarnessInventory> {
  const { machineId, ...probeOpts } = opts
  return { machineId, inventory: await buildInventory(probeOpts) }
}

/** Runs an authoritative login probe without losing non-zero stdout/stderr. */
export type LoginProbeExec = (
  argv: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
) => Promise<LoginCommandResult>

const defaultLoginExec: LoginProbeExec = (argv, timeoutMs, env) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child = execFile(
      cmd as string,
      args,
      {
        encoding: 'utf8',
        env,
        maxBuffer: PROBE_OUTPUT_LIMIT_BYTES,
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer)
        const rawCode = error?.code
        const signal = error?.signal
        resolve({
          stdout,
          stderr,
          exitCode: typeof rawCode === 'number' ? rawCode : error ? null : 0,
          ...(signal ? { signal } : {}),
          timedOut,
          ...(typeof rawCode === 'string' ? { errorCode: rawCode } : {}),
        })
      },
    )
    timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    timer.unref()
  })

/** An injected version runner must not accidentally activate a real provider CLI. */
const unavailableInjectedLoginExec: LoginProbeExec = async () => ({
  stdout: '',
  stderr: '',
  exitCode: null,
  timedOut: false,
  errorCode: 'LOGIN_PROBE_NOT_INJECTED',
})
