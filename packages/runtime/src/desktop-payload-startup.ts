/** Lower-priority, offline bundled source for one cold desktop-shell startup. */
import { execFile } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { compareVersions, isProvablyNewer } from '@podium/protocol'
import { z } from 'zod'
import { PodiumConfig, resolveUpdateChannel } from './config'
import { fsyncPath } from './fsync'
import {
  acquireLegacyExecutableFence,
  canonicalInstallationPath,
  type InstallationLease,
  installationStateRoots,
  registerInstallationStateRoot,
} from './installation-lease'
import { holderIsLive } from './instance-guard'
import { readMachineState } from './local-machine'
import { readMachineCredential } from './machine-credential'
import { readMachineUpdateJournal } from './machine-update'
import { installedArtifactDigest, installedPayloadVersion } from './machine-update-headless'
import { instanceDatabasePath, readAppliedMigrations } from './migration-ledger'
import { activatePreparedBundle, oldBundlePath } from './update-install'
import { createSchemaGate } from './update-schema'

export const DESKTOP_PAYLOAD_STARTUP_ARG = '--desktop-payload-startup'
export const DESKTOP_PAYLOAD_STARTUP_ENV = 'PODIUM_DESKTOP_PAYLOAD_STARTUP'

/** Supplied by the immutable shell while it holds this installation's OS lease. */
export const DesktopPayloadStartupRequest = z.object({
  seed: z.string().min(1),
  installDir: z.string().min(1),
  stateDir: z.string().min(1),
  channel: z.enum(['stable', 'edge', 'dev']),
  releaseBuild: z.boolean(),
  exclusive: z.boolean(),
  appManaged: z.boolean(),
})
export type DesktopPayloadStartupRequest = z.infer<typeof DesktopPayloadStartupRequest>

export type DesktopPayloadStartupResult =
  | { outcome: 'seed' }
  | { outcome: 'replaced'; from: string; version: string }
  | { outcome: 'preserved' | 'deferred' | 'failed'; reason: string }

const inside = (parent: string, child: string) => {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function executableVersion(dir: string): Promise<string> {
  const binary = join(dir, process.platform === 'win32' ? 'podium-cli.exe' : 'podium-cli')
  const env = { ...process.env }
  delete env[DESKTOP_PAYLOAD_STARTUP_ENV]
  // --version exits before instance/config/identity bootstrap, including on old releases.
  const { stdout } = await promisify(execFile)(binary, ['--version'], {
    env,
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
  })
  const match = /^podium ([^\s]+)\s*$/.exec(stdout)
  if (!match?.[1]) throw new Error('payload executable did not report a release version')
  return match[1]
}

/** A VERSION file alone must never turn a corrupt or source payload into an old release. */
export async function validateDesktopPayload(dir: string, expected: string): Promise<void> {
  const windows = process.platform === 'win32'
  for (const path of [
    windows ? 'podium.cmd' : 'podium',
    windows ? 'podium-cli.exe' : 'podium-cli',
    windows ? 'podium-host.exe' : 'podium-host',
    'web/index.html',
    'mobile/index.html',
    'VERSION',
  ]) {
    if (!lstatSync(join(dir, path)).isFile()) throw new Error(`payload layout is missing ${path}`)
  }
  if (installedPayloadVersion(dir) !== expected || (await executableVersion(dir)) !== expected)
    throw new Error('payload executable and VERSION disagree')
  const web = JSON.parse(readFileSync(join(dir, 'web/podium-build.json'), 'utf8'))
  const mobile = JSON.parse(readFileSync(join(dir, 'mobile/podium-build.json'), 'utf8'))
  if (
    web.appVersion !== expected ||
    mobile.appVersion !== expected ||
    web.sourceSha !== mobile.sourceSha
  )
    throw new Error('payload client build metadata does not match its runtime')
}

/** Flush the complete copied bundle before publishing any replacement directory. */
function syncPayloadTree(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) syncPayloadTree(child)
    else if (entry.isFile()) fsyncPath(child)
    else throw new Error('bundled payload contains an unsupported filesystem entry')
  }
  fsyncPath(path)
}

/** Existing 0.2/0.3 processes predate leases. Detect their actual loaded executable too. */
export async function legacyInstallationInUse(installDir: string): Promise<boolean> {
  const executableInInstall = (path: string) =>
    inside(installDir, path.replace(/ \(deleted\)$/, ''))
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
      try {
        // Ownership is scoped to the installing OS account. Protected processes
        // belonging to another account cannot become an unknown same-user owner.
        if (
          typeof process.getuid === 'function' &&
          statSync(`/proc/${name}`).uid !== process.getuid()
        )
          continue
        if (!holderIsLive({ pid: Number(name) })) continue
        if (
          executableInInstall(readlinkSync(`/proc/${name}/exe`)) &&
          holderIsLive({ pid: Number(name) })
        )
          return true
        // Covers the brief launcher-before-exec window as well as a source wrapper.
        const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0')
        if (
          args.some((arg) => arg.startsWith(`${installDir}${sep}`)) &&
          holderIsLive({ pid: Number(name) })
        )
          return true
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    return false
  }
  if (process.platform === 'darwin') {
    // lsof observes open executable vnodes, including an old CLI whose argv was changed.
    try {
      const { stdout, stderr } = await promisify(execFile)(
        '/usr/sbin/lsof',
        ['-a', '-u', String(process.getuid?.()), '-Fpn', '-d', 'txt', '+d', installDir],
        {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        },
      )
      if (stderr.trim()) throw new Error('legacy ownership scan was incomplete')
      return stdout
        .split('\n')
        .some((line) => line.startsWith('n') && executableInInstall(line.slice(1)))
    } catch (error) {
      if (
        (error as { code?: number; stdout?: string }).code === 1 &&
        !(error as { stdout?: string }).stdout &&
        !(error as { stderr?: string }).stderr?.trim()
      )
        return false
      throw new Error('cannot establish legacy installation ownership')
    }
  }
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress',
      ],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    )
    const values = JSON.parse(stdout)
    return (Array.isArray(values) ? values : [values]).some(
      (entry) =>
        entry.ProcessId !== process.pid &&
        typeof entry.ExecutablePath === 'string' &&
        executableInInstall(entry.ExecutablePath),
    )
  }
  throw new Error('cannot establish legacy installation ownership on this platform')
}

function readLocalConfig(root: string): PodiumConfig {
  const path = join(root, 'config.json')
  return existsSync(path) ? PodiumConfig.parse(JSON.parse(readFileSync(path, 'utf8'))) : {}
}

function localConstraint(
  root: string,
  candidate: string,
  installed: string,
  channel: DesktopPayloadStartupRequest['channel'],
): string | undefined {
  const config = readLocalConfig(root)
  if (
    installed &&
    resolveUpdateChannel({
      ...config,
      updateChannel: config.updateChannel ?? channel,
    }) !== channel
  )
    return 'configured channel has priority over bundled runtime'
  if (installed && (process.env.PODIUM_UPDATE_FEED || config.updateFeed))
    return 'explicit update feed has priority over bundled runtime'
  // Read-only. Corrupt canonical identity is a repair case, never an age signal.
  readMachineState(root)
  readMachineCredential(root)
  const runtime = join(root, 'runtime')
  const journal = readMachineUpdateJournal(runtime)
  if (journal) {
    if (!['current', 'rejected', 'canceled'].includes(journal.phase) || journal.activationHeld)
      return 'existing update or recovery has priority'
    if (!journal.grant.target.native) {
      const target = journal.grant.target.version
      const direction = compareVersions(target, journal.previousVersion)
      // A normal historical forward success is not a permanent pin. An intentional
      // downgrade, unordered target or unresolved delivered selection is different.
      if (
        journal.phase !== 'canceled' &&
        target !== candidate &&
        (direction === null ||
          direction < 0 ||
          (journal.phase === 'current' && isProvablyNewer(target, installed)) ||
          (journal.phase !== 'current' && target !== installed))
      )
        return 'delivered exact target has priority over bundled runtime'
    }
  }
  if (
    existsSync(join(runtime, 'pending-update.json')) ||
    existsSync(join(runtime, 'pending-update.json.tmp'))
  )
    return 'legacy update recovery has priority'
  const transfer = join(root, '.server-transfer')
  if (existsSync(join(root, 'supervisor-transfer-pending.json')))
    return 'server transfer assignment has priority'
  if (existsSync(transfer)) {
    for (const stage of readdirSync(transfer).filter((name) => /^[0-9a-f-]{36}$/i.test(name))) {
      const path = join(transfer, stage, 'state.json')
      if (!existsSync(path)) return 'server transfer staging is unresolved'
      const marker = JSON.parse(readFileSync(path, 'utf8'))
      if (
        marker.state !== 'aborted' &&
        !(marker.state === 'promoted' && marker.acknowledged === true)
      )
        return 'server transfer target recovery has priority'
    }
  }
  if (existsSync(join(transfer, 'journal.json'))) {
    const marker = JSON.parse(readFileSync(join(transfer, 'journal.json'), 'utf8'))
    if (
      (marker.formatVersion ?? marker.version) !== 1 ||
      !['committed', 'aborted'].includes(marker.state)
    )
      return 'server transfer recovery has priority'
    if (marker.state === 'aborted' && marker.cleanup?.result !== 'cleaned')
      return 'server transfer cleanup has priority'
  }
  if (existsSync(join(transfer, 'source.lock'))) {
    const owner = JSON.parse(readFileSync(join(transfer, 'source.lock'), 'utf8'))
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || holderIsLive({ pid: owner.pid }))
      return 'server transfer ownership has priority'
  }
  // Fenced predecessor recovery must not be inferred away merely because no child lives.
  for (const role of ['parent', 'server', 'daemon', 'all-in-one']) {
    const path = join(root, 'run', `${role}.pid`)
    if (!existsSync(path)) continue
    const record = JSON.parse(readFileSync(path, 'utf8'))
    if (!Number.isInteger(record.pid) || record.pid <= 0)
      throw new Error('invalid runtime owner record')
    if (holderIsLive({ pid: record.pid, bootId: record.bootId, startTime: record.procStartTime }))
      return 'live runtime owner has priority'
  }
  return undefined
}

function completedPredecessor(roots: string[], installDir: string, installed: string): boolean {
  return roots.some((root) => {
    const journal = readMachineUpdateJournal(join(root, 'runtime'))
    return (
      journal?.phase === 'current' &&
      !journal.grant.target.native &&
      journal.grant.target.version === installed &&
      installedPayloadVersion(oldBundlePath(installDir)) === journal.previousVersion &&
      !!journal.prepared?.digest &&
      journal.prepared?.digest === installedArtifactDigest(installDir)
    )
  })
}

/**
 * The native caller holds the lease until it has switched to shared usage and
 * started its parent. Callers outside Tauri must supply an actually held lease.
 * No fleet journal, artifact receipt, identity, config, consent or data is written.
 */
export async function prepareDesktopPayloadStartup(
  request: DesktopPayloadStartupRequest,
  lease: Pick<InstallationLease, 'installDir' | 'metadataDir' | 'exclusive'>,
  deps: {
    inUse?: (installDir: string) => Promise<boolean>
    validate?: (dir: string, version: string) => Promise<void>
    activate?: typeof activatePreparedBundle
    fence?: typeof acquireLegacyExecutableFence
    platform?: NodeJS.Platform
  } = {},
): Promise<DesktopPayloadStartupResult> {
  const installDir = canonicalInstallationPath(request.installDir)
  if (lease.installDir !== installDir || lease.exclusive !== request.exclusive)
    throw new Error('startup installation lease does not match the request')
  registerInstallationStateRoot(lease, request.stateDir)
  if (!request.exclusive)
    return { outcome: 'deferred', reason: 'live installation owner has priority' }
  const deferred = (reason: string): DesktopPayloadStartupResult => ({
    outcome: 'deferred',
    reason,
  })
  const staged = `${installDir}.prepared`
  const platform = deps.platform ?? process.platform
  const inspectOwner = async (): Promise<string | undefined> => {
    try {
      if (await (deps.inUse ?? legacyInstallationInUse)(installDir))
        return 'live legacy installation owner has priority'
    } catch {
      return 'legacy installation ownership scan is incomplete'
    }
    return undefined
  }
  // Never consume or discard another source's preparation, even without a readable journal.
  if (existsSync(staged)) return deferred('existing payload preparation has priority')
  const installed = installedPayloadVersion(installDir)
  const version = installedPayloadVersion(request.seed)
  let phase = 'local state inspection'
  if (existsSync(installDir) && (!installed || !version))
    return {
      outcome: 'preserved',
      reason: 'payload release metadata is unreadable; explicit repair remains available',
    }
  try {
    const roots = installationStateRoots(lease)
    for (const root of roots) {
      if (inside(installDir, root))
        return deferred('instance data is inside the payload installation')
      const reason = localConstraint(root, version ?? '', installed ?? '', request.channel)
      if (reason) return deferred(reason)
    }
    if (!existsSync(installDir)) {
      if (existsSync(oldBundlePath(installDir)))
        return deferred('interrupted activation retains a predecessor; explicit recovery required')
      return { outcome: 'seed' }
    }
    const owner = await inspectOwner()
    if (owner) return deferred(owner)
    if (!installed || !version) throw new Error('payload metadata is unreadable')
    if (!request.releaseBuild)
      return { outcome: 'preserved', reason: 'debug shell does not replace an installed runtime' }
    // A new native frame serializes normal app-owned cold starts on every OS.
    // Darwin/Windows cannot claim Linux's kernel exclusion for an unmodified
    // legacy headless launcher; do not extend app ownership to custom installs.
    if (platform !== 'linux' && !request.appManaged)
      return deferred('custom payload ownership is not established for bundled replacement')
    if (/debug/i.test(installed) || /debug/i.test(version) || !isProvablyNewer(version, installed))
      return { outcome: 'preserved', reason: 'bundled runtime is equal, older or unordered' }
    for (const root of roots) {
      if (
        createSchemaGate({
          readApplied: () => readAppliedMigrations(instanceDatabasePath(root)),
          currentVersion: installed,
        })({ version })
      )
        return deferred('local schema safety could not be established')
    }
    if (
      existsSync(oldBundlePath(installDir)) &&
      !completedPredecessor(roots, installDir, installed)
    )
      return deferred('predecessor recovery is unresolved')
    const seed = canonicalInstallationPath(request.seed)
    if (inside(seed, installDir) || inside(installDir, seed))
      throw new Error('bundle source overlaps installed payload')
    const validate = deps.validate ?? validateDesktopPayload
    phase = 'installed payload validation'
    await validate(installDir, installed)
    phase = 'bundled payload validation'
    await validate(seed, version)
    let releaseFence: () => void
    try {
      phase = 'payload staging'
      releaseFence = (
        deps.fence ?? (platform === 'linux' ? acquireLegacyExecutableFence : () => () => {})
      )(installDir)
    } catch {
      return deferred('legacy installation execution cannot be excluded')
    }
    try {
      mkdirSync(staged, { mode: 0o700 })
      const replacement = join(staged, 'headless')
      cpSync(seed, replacement, { recursive: true, dereference: false })
      if (process.platform === 'darwin') {
        await promisify(execFile)('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', replacement], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        })
      }
      // A signed seed is not the exact headless archive authorized by a fleet grant.
      rmSync(join(replacement, 'ARTIFACT.sha256'), { force: true })
      await validate(replacement, version)
      syncPayloadTree(replacement)
      fsyncPath(staged)
      const owner = await inspectOwner()
      if (owner) return deferred(owner)
      phase = 'payload activation'
      ;(deps.activate ?? activatePreparedBundle)(replacement, installDir)
    } finally {
      // Only this invocation's new preparation. Never touch a pre-existing one.
      try {
        rmSync(staged, { recursive: true, force: true })
      } finally {
        releaseFence()
      }
    }
    return { outcome: 'replaced', from: installed, version }
  } catch {
    // Public diagnostic is deliberately bounded; private config/identity never escapes.
    return {
      outcome: 'failed',
      reason: `bundled runtime ${phase} failed; payload recovery data retained`,
    }
  }
}
