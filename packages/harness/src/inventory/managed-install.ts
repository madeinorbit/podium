/**
 * MANAGED INSTALLS: ONE HARNESS RELEASE INTO A FOLDER PODIUM PICKS (POD-7269).
 *
 * docs/design/harness-managed-installs.md §5.3 to §5.6. The same steps for
 * every harness, naming none: the adapter's `managedInstall` section knows the
 * vendor, and this module knows the folders, the checks and the ledger.
 *
 *   1. take the install lock (the ledger's lease row);
 *   2. make `<state>/harnesses/<kind>/.staging-<random>/`;
 *   3. call the adapter's `install(release, staging, ports)`;
 *   4. check the result from outside the adapter: the executable is inside the
 *      staging folder, `--version` runs in the machine command environment and
 *      prints the release asked for, the version is not below the harness's
 *      minimum, and the identity probe accepts it where one is declared;
 *   5. flush the folder, write `receipt.json`, rename to `<number>-<version>/`;
 *   6. publish in the ledger: the new folder is current, the old one previous;
 *   7. sweep leftovers, release the lock, and ask the inventory to look again.
 *
 * Failures (§5.6): a check or install that fails for a reason outside the
 * release (vendor unreachable, broken download, checksum, installer error, a
 * write error, a lost lock) records the error and keeps the current release;
 * the next check tries again. A binary that does not run (exec error, non-zero
 * exit, `--version` timeout), prints another version, is below the minimum or
 * answers its identity probe as another program goes on the rejected list as
 * well, so it is not fetched again. An identity probe that does not run, times
 * out or exits with an error proves nothing about the release: transient. A crash at any step leaves a staging folder or a numbered
 * folder the ledger does not name; housekeeping deletes both.
 *
 * Nothing here reads the daemon's own `process.env` for an adapter: the ports
 * carry the machine command environment with every foreign credential removed.
 */
import { execFile as nodeExecFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { type BuiltinHarnessKind, isBuiltinHarnessKind } from '@podium/model'
import { createCommandEnvironment } from '@podium/runtime/command-environment'
import { fsyncPath } from '@podium/runtime/fsync'
import { hostTools } from '../host-tools.js'
import {
  declaredValue,
  type HarnessCheckPorts,
  type HarnessExecutableDeclaration,
  type HarnessInstall,
  type HarnessInstallPorts,
  type HarnessRelease,
  type InstalledRelease,
} from '../manifest.js'
import { AGENT_MANIFESTS, harnessHomeVariable, manifestFor } from '../registry.js'
import {
  gateHarnessVersion,
  type HarnessVersionPolicy,
  harnessVersionPolicyFor,
} from '../version-policy.js'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '../version-probe.js'
import {
  InstallLedger,
  type InstallLock,
  type InstallLockHolder,
  InstallLockLostError,
} from './install-ledger.js'
import {
  parseReleaseFolderName,
  RECEIPT_FORMAT,
  releaseFolderName,
  writeInstallReceipt,
} from './install-receipt.js'

// ---------------------------------------------------------------------------
// Targets: the registry's managed-install sections

/** Everything the mechanism needs from one harness: its section and how to check its binary. */
export interface ManagedInstallTarget {
  readonly kind: BuiltinHarnessKind
  readonly install: HarnessInstall
  /** The arguments that print the version (the inventory's `versionArgs`). */
  readonly versionArgs: readonly string[]
  readonly identityProbe?: HarnessExecutableDeclaration['identityProbe']
  /** The minimum-version policy, when the harness has one. */
  readonly versionPolicy?: HarnessVersionPolicy
}

/** The managed-install target of one harness, when its adapter declares the section. */
export function managedInstallTargetFor(kind: string): ManagedInstallTarget | undefined {
  const manifest = manifestFor(kind)
  if (!manifest || !isBuiltinHarnessKind(manifest.kind)) return undefined
  const install = declaredValue(manifest.managedInstall)
  if (!install) return undefined
  const executable = manifest.inventory.executable
  const versionPolicy = harnessVersionPolicyFor(manifest.kind)
  return {
    kind: manifest.kind,
    install,
    versionArgs: executable.versionArgs,
    ...(executable.identityProbe ? { identityProbe: executable.identityProbe } : {}),
    ...(versionPolicy ? { versionPolicy } : {}),
  }
}

/** Every harness whose adapter declares a supported managed-install section. */
export function managedInstallTargets(): ManagedInstallTarget[] {
  const targets: ManagedInstallTarget[] = []
  for (const kind of Object.keys(AGENT_MANIFESTS)) {
    const target = managedInstallTargetFor(kind)
    if (target) targets.push(target)
  }
  return targets
}

// ---------------------------------------------------------------------------
// Environments

/** Every variable any manifest names as a foreign credential. */
function foreignCredentialVariables(): Set<string> {
  const names = new Set<string>()
  for (const manifest of Object.values(AGENT_MANIFESTS))
    for (const name of manifest.inventory.foreignCredentialEnv) names.add(name)
  return names
}

/**
 * The environment an adapter gets: the machine command environment with every
 * variable named in any manifest's `foreignCredentialEnv` removed, and no
 * undefined values.
 */
export function managedInstallEnv(
  commandEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const strip = foreignCredentialVariables()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(commandEnv))
    if (value !== undefined && !strip.has(key)) env[key] = value
  return env
}

const XDG_FOLDER_VARIABLES = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_BIN_HOME',
  'ZDOTDIR',
]

/** Every variable that moves some harness's folders away from `HOME`. */
function harnessFolderVariables(): Set<string> {
  const names = new Set<string>(XDG_FOLDER_VARIABLES)
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    const { environment } = manifest
    if (environment.instanceHome) names.add(environment.instanceHome.variable)
    for (const name of environment.operatorSelectors ?? []) names.add(name)
    const homeVariable = harnessHomeVariable(manifest.kind)
    if (homeVariable) names.add(homeVariable)
    const credentials = declaredValue(manifest.credentials)
    for (const file of credentials?.files ?? []) if (file.homeEnvVar) names.add(file.homeEnvVar)
  }
  return names
}

/**
 * The environment a vendor installer runs with: `env` with `HOME` set to
 * `home` and every folder variable removed, so all of them derive from it.
 */
export function installerEnvFor(
  env: Readonly<Record<string, string>>,
  home: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const strip = harnessFolderVariables()
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (!strip.has(key)) out[key] = value
  out.HOME = home
  if (platform === 'win32') {
    delete out.HOMEDRIVE
    delete out.HOMEPATH
    out.USERPROFILE = home
    out.APPDATA = join(home, 'AppData', 'Roaming')
    out.LOCALAPPDATA = join(home, 'AppData', 'Local')
  }
  return out
}

// ---------------------------------------------------------------------------
// Vendor origins: how tests and the acceptance run move a vendor host

/**
 * The daemon/CLI variable that moves vendor hosts: a JSON object from a vendor
 * URL prefix to its replacement, e.g.
 * `{"https://downloads.claude.ai":"http://127.0.0.1:8080/claude"}`. Read from
 * Podium's own process environment by the caller, never from the command
 * environment an adapter sees.
 */
export const VENDOR_ORIGINS_ENV = 'PODIUM_HARNESS_VENDOR_ORIGINS'

/** Vendor URL prefix → replacement. */
export type VendorOrigins = Readonly<Record<string, string>>

/** Parse {@link VENDOR_ORIGINS_ENV}. Absent ⇒ no redirect; malformed ⇒ throws, never silently the real host. */
export function vendorOriginsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): VendorOrigins {
  const raw = env[VENDOR_ORIGINS_ENV]?.trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${VENDOR_ORIGINS_ENV} is not JSON: ${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${VENDOR_ORIGINS_ENV} must be a JSON object of URL prefix to replacement`)
  const origins: Record<string, string> = {}
  for (const [from, to] of Object.entries(parsed)) {
    if (typeof to !== 'string' || !URL.canParse(from) || !URL.canParse(to))
      throw new Error(`${VENDOR_ORIGINS_ENV}: ${from} → ${String(to)} is not a pair of URLs`)
    origins[from.replace(/\/+$/, '')] = to.replace(/\/+$/, '')
  }
  return origins
}

/** `url` with the longest matching vendor prefix replaced. A prefix matches only up to a path boundary. */
export function applyVendorOrigins(url: string, origins: VendorOrigins): string {
  let best: string | undefined
  for (const prefix of Object.keys(origins)) {
    const key = prefix.replace(/\/+$/, '')
    if (!url.startsWith(key)) continue
    const next = url.charAt(key.length)
    if (next !== '' && next !== '/' && next !== '?' && next !== '#') continue
    if (!best || key.length > best.length) best = key
  }
  if (best === undefined) return url
  const replacement = (origins[best] ?? origins[`${best}/`] ?? '').replace(/\/+$/, '')
  return `${replacement}${url.slice(best.length)}`
}

// ---------------------------------------------------------------------------
// Ports

export interface ManagedInstallHostOptions {
  /**
   * The machine command environment. Default: a fresh
   * `createCommandEnvironment()`, the login-shell environment the inventory
   * also uses. Foreign credentials are removed before an adapter sees it.
   */
  commandEnv?: Readonly<Record<string, string | undefined>>
  /** Vendor hosts moved for this run. Default: {@link VENDOR_ORIGINS_ENV} from Podium's own environment. */
  vendorOrigins?: VendorOrigins
  /** The HTTP client. Default: the global `fetch`. */
  fetchImpl?: typeof fetch
  platform?: NodeJS.Platform
  arch?: string
  isMusl?: () => Promise<boolean>
  /** Longest a download or vendor request may take. Default 30 minutes. */
  downloadTimeoutMs?: number
  note?: (message: string) => void
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000
const TEXT_LIMIT_BYTES = 1024 * 1024
const RUN_TIMEOUT_MS = 10 * 60_000
const RUN_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function runAbsolute(
  cmd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  // Only an absolute path: a bare name would be looked up on the daemon's PATH.
  if (!isAbsolute(cmd)) return Promise.reject(new Error(`refusing to run ${cmd} by name`))
  return new Promise((resolve, reject) => {
    nodeExecFile(
      cmd,
      [...args],
      {
        env: { ...env },
        encoding: 'utf8',
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: RUN_OUTPUT_LIMIT_BYTES,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`${cmd} failed: ${errorText(error)}\n${stdout}${stderr}`.trim()))
        else resolve(stdout)
      },
    )
  })
}

/** The ports `latest()` gets. */
export function managedCheckPorts(
  env: Readonly<Record<string, string>>,
  options: ManagedInstallHostOptions = {},
): HarnessCheckPorts {
  const origins = options.vendorOrigins ?? vendorOriginsFromEnv(process.env)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  const platform = options.platform ?? process.platform
  const tools = hostTools(env, platform)
  const vendorUrl = (url: string) => applyVendorOrigins(url, origins)
  const get = async (url: string): Promise<Response> => {
    const target = vendorUrl(url)
    const response = await fetchImpl(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`GET ${target}: HTTP ${response.status}`)
    }
    return response
  }
  return {
    vendorUrl,
    async fetch(url, out) {
      const response = await get(url)
      if (!response.body) throw new Error(`GET ${vendorUrl(url)}: empty body`)
      await pipeline(
        // Through `unknown`: the DOM and node:stream/web declare the same stream differently.
        Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
        createWriteStream(out, { mode: 0o644 }),
      )
    },
    async fetchText(url) {
      const response = await get(url)
      const text = await response.text()
      if (Buffer.byteLength(text) > TEXT_LIMIT_BYTES)
        throw new Error(`GET ${vendorUrl(url)}: more than ${TEXT_LIMIT_BYTES} bytes`)
      return text
    },
    run: runAbsolute,
    runTool: (tool, args, toolEnv) =>
      new Promise((resolve, reject) => {
        hostTools(toolEnv, platform).execFile(
          tool,
          args,
          { env: toolEnv, timeout: RUN_TIMEOUT_MS, maxBuffer: RUN_OUTPUT_LIMIT_BYTES },
          (error, stdout, stderr) => {
            if (error)
              reject(new Error(`${tool} failed: ${errorText(error)}\n${stdout}${stderr}`.trim()))
            else resolve(stdout)
          },
        )
      }),
    platform,
    arch: options.arch ?? process.arch,
    isMusl:
      options.isMusl ??
      (() =>
        new Promise((resolve) => {
          tools.execFile('ldd', ['/bin/ls'], { timeout: 10_000 }, (error, stdout, stderr) =>
            resolve(!error && `${stdout}${stderr}`.includes('musl')),
          )
        })),
    env,
    ...(options.note ? { note: options.note } : {}),
  }
}

/** The ports `install()` gets: the check ports plus the release's own home. */
export function managedInstallPorts(check: HarnessCheckPorts, home: string): HarnessInstallPorts {
  return {
    ...check,
    home,
    installerEnv: Object.freeze(installerEnvFor(check.env, home, check.platform)),
  }
}

// ---------------------------------------------------------------------------
// Outside checks (step 4)

export type VersionProbeResult =
  | { ok: true; output: string }
  | { ok: false; reason: 'exec-error' | 'exit' | 'timeout'; detail: string }

const PROBE_OUTPUT_LIMIT_BYTES = 1024 * 1024

/**
 * Run `<executable> <args>` and classify the outcome. On a timeout the process
 * is killed and the probe answers at once, without waiting for any child it
 * left holding the pipes.
 */
export function probeExecutable(
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<VersionProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    const done = (result: VersionProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let output = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, [...args], {
        env: { ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, reason: 'exec-error', detail: errorText(error) })
      return
    }
    const collect = (chunk: Buffer) => {
      if (output.length < PROBE_OUTPUT_LIMIT_BYTES) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ ok: false, reason: 'timeout', detail: `no answer within ${timeoutMs} ms` })
    }, timeoutMs)
    child.on('error', (error) =>
      done({ ok: false, reason: 'exec-error', detail: errorText(error) }),
    )
    child.on('close', (code, signal) => {
      if (code === 0) done({ ok: true, output: output.trim() })
      else
        done({
          ok: false,
          reason: 'exit',
          detail: `exited ${code ?? signal}${output.trim() ? `: ${output.trim()}` : ''}`,
        })
    })
  })
}

/** Whether `output` names `version` as a whole token (`2.1.3`, `v2.1.3`, `(2.1.3)`). */
export function printsVersion(output: string, version: string): boolean {
  for (const raw of output.split(/[\s,;()[\]"']+/u)) {
    const token = raw.replace(/^v(?=\d)/u, '')
    if (token === version) return true
  }
  return false
}

/** The executable `installed` names, when it is a file inside `dir` (links resolved). */
function executableInside(dir: string, executable: string): { path: string } | { error: string } {
  if (!executable || isAbsolute(executable) || /^[A-Za-z]:/.test(executable))
    return {
      error: `executable ${executable || '(empty)'} is not a path inside the release folder`,
    }
  const normal = normalize(executable)
  if (normal === '..' || normal.startsWith(`..${sep}`) || normal.startsWith('../'))
    return { error: `executable ${executable} is not a path inside the release folder` }
  const path = join(dir, normal)
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return { error: `executable ${executable} does not exist in the release folder` }
  }
  const root = realpathSync(dir)
  const inside = relative(root, real)
  if (!inside || inside.startsWith('..') || isAbsolute(inside))
    return { error: `executable ${executable} resolves outside the release folder` }
  if (!statSync(real).isFile()) return { error: `executable ${executable} is not a file` }
  return { path }
}

/** fsync every file and folder under `dir`, deepest first. Links are not followed. */
function fsyncTree(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) fsyncTree(path)
    else if (entry.isFile()) fsyncPath(path)
  }
  fsyncPath(dir)
}

// ---------------------------------------------------------------------------
// Housekeeping (§5.5)

/**
 * Delete everything under `harnesses/<kind>/` that is not the current release,
 * the previous release, or a release a session row names. Must hold the lock:
 * an install in progress owns its staging folder.
 */
export function sweepReleaseFolders(
  ledger: InstallLedger,
  kind: BuiltinHarnessKind,
  lock: InstallLock,
): string[] {
  if (!lock.held()) throw new InstallLockLostError()
  const row = ledger.get(kind)
  const keep = new Set<number>()
  if (!row?.removingAt && row?.current != null) keep.add(row.current)
  if (!row?.removingAt && row?.previous != null) keep.add(row.previous)
  for (const session of ledger.sessionInstalls(kind))
    if (session.release != null) keep.add(session.release)
  const kindDir = join(ledger.harnessesDir, kind)
  let names: string[]
  try {
    names = readdirSync(kindDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const removed: string[] = []
  for (const name of names.sort()) {
    const path = join(kindDir, name)
    const parsed = parseReleaseFolderName(name)
    if (parsed && keep.has(parsed.number) && lstatSync(path).isDirectory()) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

export interface HousekeepOptions {
  harnessesDir?: string
  ledger?: InstallLedger
  lockLabel?: string
}

export type HousekeepResult =
  | { outcome: 'swept'; removed: string[] }
  | { outcome: 'busy'; holder: InstallLockHolder }

/** Run housekeeping for one harness on its own, under the install lock. */
export function housekeepReleases(
  kind: BuiltinHarnessKind,
  options: HousekeepOptions = {},
): HousekeepResult {
  const ledger =
    options.ledger ??
    InstallLedger.open(options.harnessesDir ? { harnessesDir: options.harnessesDir } : {})
  try {
    const acquired = ledger.acquireInstallLock({ label: options.lockLabel ?? 'housekeeping' })
    if (!acquired.acquired) return { outcome: 'busy', holder: acquired.holder }
    try {
      return { outcome: 'swept', removed: sweepReleaseFolders(ledger, kind, acquired.lock) }
    } finally {
      acquired.lock.release()
    }
  } finally {
    if (!options.ledger) ledger.close()
  }
}

// ---------------------------------------------------------------------------
// Installing one release (§5.4)

/** The steps a failure is reported against; also the test seam's step names. */
export type InstallStep = 'install' | 'verify' | 'receipt' | 'rename' | 'publish'

export interface InstallReleaseOptions extends ManagedInstallHostOptions {
  /** `<state>/harnesses`. Default: the instance's own. */
  harnessesDir?: string
  /** An open ledger to use. Default: open one at `harnessesDir` and close it after. */
  ledger?: InstallLedger
  /** Install exactly this release (a repair, or the updater's pick). Default: ask the adapter's `latest()`. */
  release?: HarnessRelease
  /** Who asked, when this is the harness's first managed install. Default `person`. */
  requestedBy?: 'machine-setup' | 'person'
  /** The install lock's holder label. Default `install <kind>`. */
  lockLabel?: string
  /** Ask the inventory to look again; called once after a successful publish. */
  reprobe?: () => unknown
  /** Bound on each `--version` and identity probe. Default the inventory's probe budget. */
  probeTimeoutMs?: number
  /** @internal The target to install instead of the registry's; tests use a fake adapter. */
  target?: ManagedInstallTarget
  /** @internal Test seam: runs before each step; throwing there is a failure of that step. */
  beforeStep?: (step: InstallStep, at: { staging: string; kindDir: string }) => unknown
}

export type InstallReleaseResult =
  | {
      outcome: 'installed'
      kind: BuiltinHarnessKind
      number: number
      version: string
      dir: string
      /** Absolute path of the executable. */
      executable: string
      previous: number | null
      /** Leftovers housekeeping deleted after the publish. */
      swept: string[]
    }
  | { outcome: 'busy'; kind: BuiltinHarnessKind; holder: InstallLockHolder }
  | { outcome: 'check-failed'; kind: BuiltinHarnessKind; error: string; swept: string[] }
  | {
      outcome: 'failed'
      kind: BuiltinHarnessKind
      version: string
      step: InstallStep
      error: string
      /** The version went on the rejected list: the binary does not run, is another version or another program, or is too old. */
      rejected: boolean
      swept: string[]
    }

type LockedOutcome =
  | Extract<InstallReleaseResult, { outcome: 'installed' }>
  | Omit<Extract<InstallReleaseResult, { outcome: 'check-failed' }>, 'swept'>
  | Omit<Extract<InstallReleaseResult, { outcome: 'failed' }>, 'swept'>

/**
 * Install one release of `kind` as a new managed release folder and publish it
 * as current. Never throws for a vendor, release or disk failure: the outcome
 * says what happened and the ledger records it. Throws only when `kind`
 * declares no managed install or the ledger cannot be opened.
 */
export async function installRelease(
  kind: BuiltinHarnessKind,
  options: InstallReleaseOptions = {},
): Promise<InstallReleaseResult> {
  const target = options.target ?? managedInstallTargetFor(kind)
  if (!target || target.kind !== kind)
    throw new Error(`podium install: ${kind} declares no managed install`)
  const commandEnv = options.commandEnv ?? (await createCommandEnvironment()).env
  const env = Object.freeze(managedInstallEnv(commandEnv))
  const check = managedCheckPorts(env, options)

  const ledger =
    options.ledger ??
    InstallLedger.open(options.harnessesDir ? { harnessesDir: options.harnessesDir } : {})
  try {
    if (ledger.get(kind)?.removingAt)
      throw new Error(`${kind} is still being removed; wait for its running sessions to exit.`)
    if (!ledger.get(kind)) ledger.requestInstall(kind, options.requestedBy ?? 'person')
    const acquired = ledger.acquireInstallLock({ label: options.lockLabel ?? `install ${kind}` })
    if (!acquired.acquired) return { outcome: 'busy', kind, holder: acquired.holder }
    const { lock } = acquired
    let outcome: LockedOutcome
    let swept: string[] = []
    try {
      outcome = await installLocked(ledger, lock, target, env, check, options)
    } finally {
      try {
        swept = sweepReleaseFolders(ledger, kind, lock)
      } catch (error) {
        options.note?.(`Could not clear old ${kind} install folders: ${errorText(error)}`)
      }
      lock.release()
    }
    if (outcome.outcome !== 'installed') return { ...outcome, swept }
    try {
      await options.reprobe?.()
    } catch (error) {
      options.note?.(
        `Installed ${kind} ${outcome.version}; the inventory refresh failed: ${errorText(error)}`,
      )
    }
    return { ...outcome, swept }
  } finally {
    if (!options.ledger) ledger.close()
  }
}

async function installLocked(
  ledger: InstallLedger,
  lock: InstallLock,
  target: ManagedInstallTarget,
  env: Readonly<Record<string, string>>,
  check: HarnessCheckPorts,
  options: InstallReleaseOptions,
): Promise<LockedOutcome> {
  const { kind } = target
  const kindDir = join(ledger.harnessesDir, kind)
  mkdirSync(kindDir, { recursive: true })

  let release = options.release
  if (!release) {
    try {
      release = await target.install.latest(check)
      releaseFolderName(1, release.version)
    } catch (error) {
      const message = errorText(error)
      ledger.recordCheck(kind, { ok: false, error: message })
      return { outcome: 'check-failed', kind, error: message }
    }
    ledger.recordCheck(kind, { ok: true, latest: release.version, nothingToInstall: false })
  }
  const { version } = release

  const staging = join(kindDir, `.staging-${randomBytes(6).toString('hex')}`)
  const at = { staging, kindDir }
  const fail = (step: InstallStep, error: string, rejected: boolean): LockedOutcome => {
    rmSync(staging, { recursive: true, force: true })
    try {
      if (rejected) ledger.rejectRelease(kind, version, error)
      ledger.recordInstallFailure(kind, { version, error })
    } catch (recordError) {
      options.note?.(`Could not record the ${kind} install failure: ${errorText(recordError)}`)
    }
    return { outcome: 'failed', kind, version, step, error, rejected }
  }

  // Steps 2 and 3: an empty staging folder with an empty home inside, then the adapter.
  let installed: InstalledRelease
  try {
    releaseFolderName(1, version)
    mkdirSync(staging)
    const home = join(staging, 'home')
    mkdirSync(home)
    await options.beforeStep?.('install', at)
    installed = await target.install.install(release, staging, managedInstallPorts(check, home))
  } catch (error) {
    return fail('install', errorText(error), false)
  }

  // Step 4: checks from outside the adapter.
  let executable: string
  try {
    await options.beforeStep?.('verify', at)
    const found = executableInside(staging, installed.executable)
    if ('error' in found) return fail('verify', found.error, false)
    executable = found.path
  } catch (error) {
    return fail('verify', errorText(error), false)
  }
  const timeoutMs = options.probeTimeoutMs ?? AGENT_VERSION_PROBE_TIMEOUT_MS
  const probe = await probeExecutable(executable, target.versionArgs, env, timeoutMs)
  if (!probe.ok)
    return fail(
      'verify',
      `${kind} ${version} does not run (${probe.reason}): ${probe.detail}`,
      true,
    )
  if (!printsVersion(probe.output, version))
    return fail(
      'verify',
      `${kind} ${version} reports another version: ${probe.output || '(no output)'}`,
      true,
    )
  if (target.versionPolicy && gateHarnessVersion(target.versionPolicy, probe.output) === 'too-old')
    return fail('verify', `${kind} ${version} is below the minimum Podium supports`, true)
  if (target.identityProbe) {
    const identity = await probeExecutable(executable, target.identityProbe.args, env, timeoutMs)
    if (!identity.ok)
      return fail(
        'verify',
        `${kind} ${version} identity probe failed (${identity.reason}): ${identity.detail}`,
        false,
      )
    if (!target.identityProbe.accepts(identity.output))
      return fail(
        'verify',
        `${kind} ${version} is not ${kind}: the identity probe refused it`,
        true,
      )
  }

  // Step 5: flush, receipt, rename. Nothing reads the folder until step 6.
  let number: number
  let dir: string
  try {
    await options.beforeStep?.('receipt', at)
    fsyncTree(staging)
    writeInstallReceipt(staging, {
      format: RECEIPT_FORMAT,
      harness: kind,
      version,
      executable: normalize(installed.executable),
      integrity: installed.integrity,
      source: installed.source,
      installedAt: new Date().toISOString(),
    })
    number = ledger.allocateReleaseNumber(kind, lock)
    dir = join(kindDir, releaseFolderName(number, version))
    await options.beforeStep?.('rename', at)
    renameSync(staging, dir)
    fsyncPath(kindDir)
  } catch (error) {
    return fail('receipt', errorText(error), false)
  }

  // Step 6: publish. A failure here leaves a numbered folder nobody names; the sweep removes it.
  let previous: number | null
  try {
    await options.beforeStep?.('publish', at)
    previous = ledger.publishRelease(kind, number, lock).previous
  } catch (error) {
    return fail('publish', errorText(error), false)
  }
  return {
    outcome: 'installed',
    kind,
    number,
    version,
    dir,
    executable: join(dir, normalize(installed.executable)),
    previous,
    swept: [],
  }
}
