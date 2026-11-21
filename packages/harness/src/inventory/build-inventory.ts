/**
 * Machine inventory and verified executable snapshot for one command-environment
 * generation. Probes never throw: a missing CLI is `installed: false`, while a
 * bounded probe that expires is explicitly unknown (`installed: null`).
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, platform as nodePlatform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import type {
  AgentInstallWire,
  AgentInventory,
  Inventory,
  MachineId,
  ToolInventory,
} from '@podium/model'
import {
  type CommandEnvironment,
  createCommandEnvironment,
} from '@podium/runtime/command-environment'
import {
  type AgentManifest,
  declaredValue,
  type HarnessLogin,
  type HarnessLoginCommandProbe,
  type LoginCommandResult,
} from '../manifest.js'
import {
  AGENT_MANIFESTS,
  harnessHomeVariable,
  harnessLoginReadEnv,
  unmetHideFromCommandsPrerequisites,
} from '../registry.js'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '../version-probe.js'
import { installerEnvFor, managedInstallEnv } from './managed-install.js'
import { managedInstallRefusal } from './requested-install.js'

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
  /** The release folder's number, for a managed install. */
  readonly release?: number
  readonly vendorUpdated?: boolean
}

export interface ResolvedHarnessInventory {
  readonly inventory: Inventory
  /**
   * The person's own install of each harness: the command path, then the
   * adapter's known folders. The only install a context in the person's own
   * harness folder may run (managed installs §4.2).
   */
  readonly executables: ReadonlyMap<AgentManifest['kind'], ResolvedHarnessExecutable>
  /**
   * Podium's install of each harness: the install ledger's current release, or
   * its previous one when the current fails its probe (§6.1). Runs only in a
   * home Podium made. Absent or empty: nothing managed on this machine.
   */
  readonly managed?: ReadonlyMap<AgentManifest['kind'], ResolvedHarnessExecutable>
  readonly commandEnvironment: CommandEnvironment
}

/** One managed release a probe may try: its folder number, version and executable. */
export interface ManagedReleaseCandidate {
  readonly release: number
  readonly version: string
  /** Absolute path inside the release folder. */
  readonly executable: string
  readonly vendorUpdated?: boolean
}

/**
 * What the install ledger says about one managed harness, as plain data, so the
 * inventory reads it without opening a database (the daemon composes the
 * reader, `readManagedInstalls` in ./managed-installs.ts).
 */
export interface ManagedHarnessRecord {
  readonly kind: AgentManifest['kind']
  /** The ledger's current release, when its folder holds a valid receipt. */
  readonly current?: ManagedReleaseCandidate
  /** The ledger's previous release, when its folder holds a valid receipt. */
  readonly previous?: ManagedReleaseCandidate
  /** The current release's number and version when its folder is no release. */
  readonly currentMissing?: { readonly release: number; readonly version?: string }
  readonly installing?: { readonly version?: string }
  readonly removingAt?: string
  readonly paused: boolean
  readonly vendorUpdated?: boolean
  readonly lastCheck?:
    | { readonly at: string; readonly ok: true; readonly latest: string }
    | { readonly at: string; readonly ok: false; readonly error: string }
  readonly lastInstallError?: {
    readonly at: string
    readonly version: string
    readonly error: string
  }
  readonly failingSince?: string
}

export interface ManagedInstallsRead {
  readonly harnesses: ReadonlyMap<AgentManifest['kind'], ManagedHarnessRecord>
  /** Set while the ledger reports it was rebuilt from the release folders. */
  readonly rebuilt?: { readonly at: string; readonly reason: 'missing' | 'damaged' }
}

/** Reads the install ledger. Called once per inventory wave (§7). */
export type ManagedInstallsReader = () => ManagedInstallsRead | Promise<ManagedInstallsRead>

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
    // An injected exec answers by argv, so the seam has to stay argv-only. Asking
    // the resolver first and only FALLING BACK to the name made the reported path
    // depend on what the machine running the test happened to have installed
    // (POD-2826), and no fixture can sandbox that: createCommandEnvironment always
    // appends /usr/local/bin, /usr/bin and /bin to the search entries, so scrubbing
    // PATH does not stop the host from answering.
    const path = legacyInjectedExec ? candidate : environment.resolve(candidate)
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

type ExecutableProbe =
  | { kind: 'verified'; version: string }
  | { kind: 'timed-out' }
  | { kind: 'failed' }

/**
 * THE VERSION AND IDENTITY PROBE OF ONE CANDIDATE, the same for the person's
 * install and a managed release (managed installs §6.1): `<path> <versionArgs>`
 * must answer, and a declared identity probe must accept its output. Runs with
 * the machine command environment, never an account's: the person's install
 * with its harness folder moved aside (see {@link containedProbeEnv}), a
 * managed release in a temporary home (see {@link probeManaged}).
 */
async function probeExecutable(
  manifest: AgentManifest,
  candidate: string,
  env: Readonly<Record<string, string>>,
  exec: ProbeExec,
): Promise<ExecutableProbe> {
  const declaration = manifest.inventory.executable
  let version: string
  try {
    version = (
      await exec([candidate, ...declaration.versionArgs], AGENT_VERSION_PROBE_TIMEOUT_MS, env)
    ).trim()
  } catch (error) {
    // Missing, or no longer executable: the caller tries its next path.
    return probeTimedOut(error) ? { kind: 'timed-out' } : { kind: 'failed' }
  }
  if (declaration.identityProbe) {
    try {
      const output = await exec(
        [candidate, ...declaration.identityProbe.args],
        AGENT_VERSION_PROBE_TIMEOUT_MS,
        env,
      )
      if (!declaration.identityProbe.accepts(output)) return { kind: 'failed' }
    } catch (error) {
      // A generic candidate such as `agent` can belong to another harness,
      // so a timed-out identity probe proves neither presence nor absence.
      return probeTimedOut(error) ? { kind: 'timed-out' } : { kind: 'failed' }
    }
  }
  return { kind: 'verified', version }
}

/**
 * PODIUM'S INSTALL OF ONE HARNESS (managed installs §6.1): the ledger's
 * current release, or its previous one when the current fails the probe.
 * Nothing else: an older release is never reached for, and a managed binary
 * never runs a login probe, which reads the person's own folder (M9).
 *
 * Even `--version` can write harness state (Codex creates its arg0 helper
 * links), so the probes run in a temporary home outside the release folders,
 * which stay immutable, and outside the person's harness folders: the machine
 * command environment with its foreign credentials and harness folder
 * variables removed, PATH kept. The home is removed after the probes.
 */
async function probeManaged(
  manifest: AgentManifest,
  record: ManagedHarnessRecord,
  environment: CommandEnvironment,
  exec: ProbeExec,
  hostPlatform: NodeJS.Platform,
): Promise<{ executable?: ResolvedHarnessExecutable; currentFailed?: ManagedReleaseCandidate }> {
  if (record.removingAt || (!record.current && !record.previous)) return {}
  let probeHome: string
  try {
    probeHome = await mkdtemp(join(tmpdir(), `podium-probe-${manifest.kind}-`))
  } catch (err) {
    // Without a home of its own a managed binary is not run at all: running it
    // in the person's folder is the one thing this must never do.
    log.warn('no temporary home for the managed probe; reporting no managed install', {
      kind: manifest.kind,
      err,
    })
    return {}
  }
  try {
    const env = Object.freeze(
      installerEnvFor(managedInstallEnv(environment.env), probeHome, hostPlatform),
    )
    return await probeManagedCandidates(manifest, record, environment, env, exec)
  } finally {
    await rm(probeHome, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn('the managed probe home could not be removed', { path: probeHome, err })
    })
  }
}

async function probeManagedCandidates(
  manifest: AgentManifest,
  record: ManagedHarnessRecord,
  environment: CommandEnvironment,
  env: Readonly<Record<string, string>>,
  exec: ProbeExec,
): Promise<{ executable?: ResolvedHarnessExecutable; currentFailed?: ManagedReleaseCandidate }> {
  let currentFailed: ManagedReleaseCandidate | undefined
  for (const [role, candidate] of [
    ['current', record.current],
    ['previous', record.previous],
  ] as const) {
    if (!candidate) continue
    const probed = await probeExecutable(manifest, candidate.executable, env, exec)
    if (probed.kind === 'verified') {
      const executable: ResolvedHarnessExecutable = Object.freeze({
        kind: manifest.kind,
        path: candidate.executable,
        ...(probed.version ? { version: probed.version } : {}),
        generation: environment.generation,
        release: candidate.release,
        ...(candidate.vendorUpdated ? { vendorUpdated: true } : {}),
      })
      return { executable, ...(currentFailed ? { currentFailed } : {}) }
    }
    if (role === 'current') currentFailed = candidate
  }
  return currentFailed ? { currentFailed } : {}
}

/** The `install` wire object for one managed harness (§8). */
function installWire(
  record: ManagedHarnessRecord,
  external: ResolvedHarnessExecutable | undefined,
  managed: ResolvedHarnessExecutable | undefined,
  currentFailed: ManagedReleaseCandidate | undefined,
  rebuilt: ManagedInstallsRead['rebuilt'],
): AgentInstallWire {
  const failedCurrent =
    currentFailed ??
    (record.currentMissing
      ? { release: record.currentMissing.release, version: record.currentMissing.version ?? '' }
      : undefined)
  const checkError =
    record.lastCheck && !record.lastCheck.ok
      ? { at: record.lastCheck.at, message: record.lastCheck.error }
      : undefined
  const installError = record.lastInstallError
    ? {
        at: record.lastInstallError.at,
        message: record.lastInstallError.error,
        version: record.lastInstallError.version,
      }
    : undefined
  const lastError =
    checkError && installError
      ? checkError.at > installError.at
        ? checkError
        : installError
      : (checkError ?? installError)
  return {
    ...(external
      ? {
          external: {
            path: external.path,
            ...(external.version ? { version: external.version } : {}),
          },
        }
      : {}),
    managed: {
      ...(managed && managed.release !== undefined
        ? {
            active: {
              path: managed.path,
              ...(managed.version ? { version: managed.version } : {}),
              release: managed.release,
            },
          }
        : {}),
      ...(failedCurrent?.version
        ? { currentFailed: { release: failedCurrent.release, version: failedCurrent.version } }
        : {}),
      ...(record.previous && managed?.release !== record.previous.release
        ? { previousVersion: record.previous.version }
        : {}),
      ...(record.lastCheck?.ok ? { latest: record.lastCheck.latest } : {}),
      ...(record.lastCheck ? { lastCheckAt: record.lastCheck.at } : {}),
      paused: record.paused,
      ...(record.vendorUpdated ? { vendorUpdated: true } : {}),
      ...(record.installing ? { installing: record.installing } : {}),
      ...(record.removingAt ? { removingAt: record.removingAt } : {}),
      ...(lastError ? { lastError } : {}),
      ...(record.failingSince ? { failingSince: record.failingSince } : {}),
    },
    ...(rebuilt ? { ledgerRebuilt: { at: rebuilt.at, reason: rebuilt.reason } } : {}),
  }
}

async function probeExternal(
  manifest: AgentManifest,
  credentialHome: string,
  environment: CommandEnvironment,
  exec: ProbeExec,
  loginExec: LoginProbeExec,
  legacyInjectedExec: boolean,
  hostPlatform: NodeJS.Platform,
): Promise<{ inventory: AgentInventory; executable?: ResolvedHarnessExecutable }> {
  /**
   * EVERY LOGIN READ RUNS UNDER THE CREDENTIAL HOME (POD-2692), the file detector
   * and `loginCommandProbe` alike.
   *
   * `environment.env` describes the MACHINE — its PATH, its `HOME` — and that is
   * the right environment for finding and versioning an executable. It is the
   * wrong one for asking who is signed in: on a named instance the credentials
   * live under an isolated agent-home, and `claude auth status` run with the
   * operator's `HOME` cheerfully answers about the operator. It answered `in`
   * against an agent-home holding no credential at all, and because a
   * `determined` command verdict OVERRIDES the file detector, that wrong answer
   * won and became the machine inventory the whole product reads.
   */
  const credentialEnv: Readonly<Record<string, string>> = Object.freeze(
    harnessLoginReadEnv(manifest.kind, credentialHome, environment.env),
  )
  let detected: HarnessLogin
  try {
    detected = manifest.inventory.detectLogin(credentialHome, credentialEnv)
  } catch {
    detected = { state: 'unknown' }
  }
  const identityReader = declaredValue(manifest.inventory.loginIdentity)
  let identity: ReturnType<NonNullable<typeof identityReader>> | undefined
  try {
    identity = identityReader?.(credentialHome, credentialEnv)
  } catch {
    // Login identity is best-effort metadata.
  }
  const fallbackLogin = identity ? { ...detected, identity } : detected
  const commandProbe = declaredValue(manifest.inventory.loginCommandProbe)
  const contained = await containedProbeEnv(manifest, environment.env)
  try {
    return await probeExternalCandidates(
      manifest,
      environment,
      contained.env,
      credentialEnv,
      fallbackLogin,
      commandProbe,
      exec,
      loginExec,
      legacyInjectedExec,
      hostPlatform,
    )
  } finally {
    await contained.dispose()
  }
}

/**
 * THE ENVIRONMENT THE PERSON'S OWN INSTALL IS VERSIONED IN (POD-7384): the
 * machine command environment with the harness's own state folder moved to a
 * temporary folder, removed afterwards.
 *
 * Even `--version` writes harness state: Codex replaces its arg0 helper links
 * under `CODEX_HOME/tmp`, and Pi creates `auth.json` and `models-store.json`
 * in its agent folder. A background inventory wave must leave the person's
 * folders as it found them, so the folder variable the manifest declares as
 * the harness's home (`environment.instanceHome`) points elsewhere.
 *
 * Everything else stays the machine's, HOME and the XDG folders included:
 * finding the executable depends on them. The official Pi launcher puts
 * `$HOME/.local/share/pi-node/current/bin` on PATH for its node, and a
 * version-manager shim reads its configuration under HOME, so a temporary
 * HOME would report an installed harness as missing. A harness that declares
 * no home variable runs as before. Login detection is not affected: it reads
 * the credential home through its own environment.
 */
async function containedProbeEnv(
  manifest: AgentManifest,
  machineEnv: Readonly<Record<string, string>>,
): Promise<{ env: Readonly<Record<string, string>>; dispose: () => Promise<void> }> {
  const variable = manifest.environment.instanceHome?.variable
  const unchanged = { env: machineEnv, dispose: async () => {} }
  if (!variable) return unchanged
  let probeRoot: string
  try {
    probeRoot = await mkdtemp(join(tmpdir(), `podium-probe-${manifest.kind}-`))
  } catch (err) {
    // A machine without a usable temporary folder is broken in other ways too;
    // reporting the person's install as missing would offer to replace it.
    log.warn('no temporary folder for the external version probe; probing as before', {
      kind: manifest.kind,
      err,
    })
    return unchanged
  }
  return {
    env: Object.freeze({ ...machineEnv, [variable]: probeRoot }),
    dispose: () =>
      rm(probeRoot, { recursive: true, force: true }).catch((err: unknown) => {
        log.warn('the external probe folder could not be removed', { path: probeRoot, err })
      }),
  }
}

async function probeExternalCandidates(
  manifest: AgentManifest,
  environment: CommandEnvironment,
  probeEnv: Readonly<Record<string, string>>,
  credentialEnv: Readonly<Record<string, string>>,
  fallbackLogin: HarnessLogin,
  commandProbe: HarnessLoginCommandProbe | undefined,
  exec: ProbeExec,
  loginExec: LoginProbeExec,
  legacyInjectedExec: boolean,
  hostPlatform: NodeJS.Platform,
): Promise<{ inventory: AgentInventory; executable?: ResolvedHarnessExecutable }> {
  let timedOut = false
  for (const candidate of candidatePaths(manifest, environment, legacyInjectedExec)) {
    const probed = await probeExecutable(manifest, candidate, probeEnv, exec)
    if (probed.kind === 'timed-out') timedOut = true
    if (probed.kind !== 'verified') continue
    const version = probed.version
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
          await loginExec([candidate, ...commandProbe.args], commandProbe.timeoutMs, credentialEnv),
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

/**
 * One harness's inventory: the person's install exactly as before, and, when
 * the install ledger names this harness, Podium's (managed installs §6.1).
 * Each install passes the version and identity probe on its own. The
 * top-level `installed`, `version` and `path` keep naming the person's
 * install; on a machine with only Podium's they name that one, so a server
 * that does not read `install` still sees the harness installed.
 */
async function probeAgent(
  manifest: AgentManifest,
  credentialHome: string,
  environment: CommandEnvironment,
  exec: ProbeExec,
  loginExec: LoginProbeExec,
  legacyInjectedExec: boolean,
  hostPlatform: NodeJS.Platform,
  managed: ManagedInstallsRead | undefined,
): Promise<{
  inventory: AgentInventory
  executable?: ResolvedHarnessExecutable
  managed?: ResolvedHarnessExecutable
}> {
  const record = managed?.harnesses.get(manifest.kind)
  const [external, podium] = await Promise.all([
    probeExternal(
      manifest,
      credentialHome,
      environment,
      exec,
      loginExec,
      legacyInjectedExec,
      hostPlatform,
    ),
    record
      ? probeManaged(manifest, record, environment, exec, hostPlatform)
      : Promise.resolve(undefined),
  ])
  if (!record || !podium) return external
  const install = installWire(
    record,
    external.executable,
    podium.executable,
    podium.currentFailed,
    managed?.rebuilt,
  )
  if (external.inventory.installed === true || !podium.executable) {
    return {
      ...external,
      inventory: { ...external.inventory, install },
      ...(podium.executable ? { managed: podium.executable } : {}),
    }
  }
  // Only Podium's install answered: the top level names it. The login stays the
  // person's folder's, read from its files (no managed binary runs there).
  const { probeError: _unknown, ...rest } = external.inventory
  return {
    ...external,
    inventory: {
      ...rest,
      installed: true,
      ...(podium.executable.version ? { version: podium.executable.version } : {}),
      path: podium.executable.path,
      install,
    },
    managed: podium.executable,
  }
}

async function probeTool(
  name: string,
  environment: CommandEnvironment,
  exec: ProbeExec,
  legacyInjectedExec: boolean,
): Promise<ToolInventory> {
  // Argv-only under an injected exec, for the same reason as candidatePaths (POD-2826).
  const candidate = legacyInjectedExec ? name : environment.resolve(name)
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
  env?: NodeJS.ProcessEnv
  exec?: ProbeExec
  loginExec?: LoginProbeExec
  platform?: NodeJS.Platform
  generation?: number
  /**
   * The install ledger, read once per wave (managed installs §7), so a release
   * another process published appears in the next wave. Absent: nothing
   * managed is looked for. A reader that throws counts as nothing managed.
   */
  managedInstalls?: ManagedInstallsReader
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
  if (p !== 'linux' && p !== 'darwin' && p !== 'win32')
    log.warn('unsupported platform, reporting linux', { platform: p })
  if (a !== 'x64' && a !== 'arm64') log.warn('unsupported arch, reporting x64', { arch: a })
  return {
    os: p === 'darwin' || p === 'win32' ? p : 'linux',
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
      env: opts.env,
      generation: opts.generation ?? 0,
      platform: hostPlatform,
    }))
  const exec = opts.exec ?? defaultExec
  const loginExec = opts.loginExec ?? (opts.exec ? unavailableInjectedLoginExec : defaultLoginExec)
  // Historical tests inject an argv responder rather than executable fixture files.
  const legacyInjectedExec = Boolean(opts.exec && !opts.commandEnvironment)
  const managed = await readManaged(opts.managedInstalls)
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
          managed,
        ),
      ),
    ),
    Promise.all(
      ['gh'].map((name) => probeTool(name, commandEnvironment, exec, legacyInjectedExec)),
    ),
  ])
  const executables = new Map<AgentManifest['kind'], ResolvedHarnessExecutable>()
  const managedExecutables = new Map<AgentManifest['kind'], ResolvedHarnessExecutable>()
  for (const result of agentResults) {
    if (result.executable) executables.set(result.executable.kind, result.executable)
    if (result.managed) managedExecutables.set(result.managed.kind, result.managed)
  }
  return Object.freeze({
    inventory: {
      ...inventoryPlatformFields(hostPlatform),
      agents: agentResults.map((result) => {
        const agent = result.inventory
        const manifest = AGENT_MANIFESTS[agent.kind]
        const own = result.executable ? true : agent.installed === null ? null : false
        const refusal = managedInstallRefusal(agent.kind, own)
        const section = manifest.managedInstall
        const reason = !section.supported ? section.reason : refusal
        const homeVariable = harnessHomeVariable(agent.kind)
        const updateNotice = agent.install?.managed?.vendorUpdated
          ? `${manifest.descriptor.label} updates itself. Podium installed it once and leaves updates to the vendor.`
          : declaredValue(section)?.updateNotice
        const row = {
          ...agent,
          management: {
            installable: !reason,
            ...(reason ? { reason } : {}),
            ...(homeVariable ? { homeVariable } : {}),
            ...(updateNotice ? { updateNotice } : {}),
          },
        }
        // Argv-only under an injected exec, as candidatePaths (POD-2826): the
        // test host's own PATH says nothing about the machine described.
        return legacyInjectedExec
          ? row
          : withMissingPrerequisites(row, hostPlatform, commandEnvironment)
      }),
      tools,
    },
    executables,
    managed: managedExecutables,
    commandEnvironment,
  })
}

/**
 * An installed harness's row with what its hide-from-commands switch needs
 * here and the command environment does not find (POD-7375). The switch is
 * set only for a credential Podium passes in, so that is the use named.
 */
function withMissingPrerequisites(
  row: AgentInventory,
  platform: NodeJS.Platform,
  environment: CommandEnvironment,
): AgentInventory {
  if (row.installed !== true) return row
  const unmet = unmetHideFromCommandsPrerequisites(row.kind, {
    platform,
    resolve: (command) => environment.resolve(command),
  })
  if (unmet.length === 0) return row
  return {
    ...row,
    missingPrerequisites: unmet.map((need) => ({
      executable: need.executable,
      package: need.package,
      neededFor: 'passed-in-credential' as const,
      message: need.missing,
    })),
  }
}

async function readManaged(
  reader: ManagedInstallsReader | undefined,
): Promise<ManagedInstallsRead | undefined> {
  if (!reader) return undefined
  try {
    return await reader()
  } catch (err) {
    // A ledger that cannot be read hides Podium's installs for this wave; the
    // person's are found as always.
    log.warn('the install ledger could not be read; reporting no managed installs', { err })
    return undefined
  }
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
  /** Written to the command's stdin, which is then closed (a credential pipe, POD-7378). */
  stdin?: string,
) => Promise<LoginCommandResult>

/** Run a harness status command, keeping its output on a non-zero exit. */
export const runHarnessStatusCommand: LoginProbeExec = (argv, timeoutMs, env, stdin) =>
  defaultLoginExec(argv, timeoutMs, env, stdin)

const defaultLoginExec: LoginProbeExec = (argv, timeoutMs, env, stdin) =>
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
    if (stdin !== undefined) {
      // A command that exits before reading closes the pipe; its result is
      // what counts.
      child.stdin?.once('error', () => undefined)
      child.stdin?.end(stdin)
    }
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
