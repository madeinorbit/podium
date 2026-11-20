/**
 * `podium uninstall`: leave this machine (managed installs, section 12 item 14).
 *
 * In this order:
 * 1. confirm, naming the machine and the instance;
 * 2. stop the instance's services and its sessions;
 * 3. undo the edits Podium made in the person's harness folders, reporting
 *    each one as restored, changed since, or failed;
 * 4. remove Podium's service units;
 * 5. remove Podium's own files (the state folder with managed releases,
 *    Podium homes and the ledger; the installed bundle and its command) only
 *    when every edit was restored, or with `--force`.
 *
 * The person's own harness installs and folders are never touched: the only
 * writes to them are the guarded undos in step 3. On a server or all-in-one
 * instance the state folder also holds the workspace database, so it is kept
 * unless `--delete-workspace-data` is given as well.
 *
 * The machine menu's "Uninstall Podium" runs this same command on the machine
 * (`--yes`), started by the daemon outside its own service.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { everyEditRestored, type UninstallEditOutcome } from '@podium/protocol'
import {
  instanceBuildSliceName,
  instanceCommandName,
  instanceInstallDir,
  instanceServiceName,
  instanceSessionSliceName,
  instanceUpdateTimerName,
} from '@podium/runtime/instance'
import { desiredParentUnit, legacyUnitNames } from '@podium/runtime/topology-migration'
import { declareFlags, parseFlags, UnknownFlagError } from './argv'

export const UNINSTALL_FLAGS = declareFlags({
  known: [],
  booleans: ['yes', 'force', 'json', 'delete-workspace-data'],
  shorts: { y: 'yes' },
})

export interface UninstallOptions {
  /** Skip the confirmation (the machine menu, scripts). */
  yes: boolean
  /** Remove Podium's files even when an edit could not be undone. */
  force: boolean
  json: boolean
  /** On a server or all-in-one instance, also remove the workspace database. */
  deleteWorkspaceData: boolean
}

export function parseUninstallArgs(argv: string[]): UninstallOptions | { error: string } {
  try {
    const { args, positionals } = parseFlags(argv, UNINSTALL_FLAGS, {
      usage: 'podium uninstall',
      keys: 'raw',
    })
    if (positionals.length > 0)
      return { error: `podium uninstall takes no arguments (got '${positionals[0]}')` }
    return {
      yes: args.yes === true,
      force: args.force === true,
      json: args.json === true,
      deleteWorkspaceData: args['delete-workspace-data'] === true,
    }
  } catch (error) {
    if (error instanceof UnknownFlagError) return { error: error.message }
    throw error
  }
}

/** What this machine's instance is, as far as uninstalling needs to know. */
export interface UninstallTarget {
  instanceId: string
  machineName: string
  /** `server` and `all-in-one` keep the workspace database in the state folder. */
  mode: string | undefined
  stateDir: string
  /** The installed bundle, or undefined when this runs from a source checkout. */
  installDir: string | undefined
  /** The command in `~/.local/bin` the installer wrote, when it points at {@link installDir}. */
  commandPath: string | undefined
}

export interface UninstallPorts {
  confirm(question: string): Promise<boolean>
  /** Stop the services and sessions; each entry is one problem, empty when all stopped. */
  stopServices(): Promise<string[]>
  undoHomeEdits(): Promise<UninstallEditOutcome[]>
  /** Remove the service units; returns the ones removed. */
  removeServiceUnits(): Promise<string[]>
  removePath(path: string): void
  out(line: string): void
}

export interface UninstallReport {
  machine: string
  instanceId: string
  stopped: boolean
  stopProblems: string[]
  edits: UninstallEditOutcome[]
  /** Set when the undo itself could not run (the ledger did not open). */
  undoError?: string
  removedUnits: string[]
  removed: string[]
  kept: Array<{ path: string; reason: string }>
}

const SERVER_MODES = new Set(['server', 'all-in-one'])

function summarize(edits: readonly UninstallEditOutcome[]): string {
  const count = (status: UninstallEditOutcome['status']) =>
    edits.filter((edit) => edit.status === status).length
  return `${count('restored')} restored, ${count('changed')} changed since, ${count('failed')} failed`
}

/** Run the uninstall. Returns the report, or undefined when the person said no. */
export async function runUninstall(
  options: UninstallOptions,
  target: UninstallTarget,
  ports: UninstallPorts,
): Promise<UninstallReport | undefined> {
  const say = (line: string) => {
    if (!options.json) ports.out(line)
  }
  const serverData = SERVER_MODES.has(target.mode ?? '')
  if (!options.yes) {
    const lines = [
      `Uninstall Podium from ${target.machineName} (instance ${target.instanceId})?`,
      "This stops Podium's services and sessions, undoes Podium's edits in your harness folders,",
      `removes Podium's service units, and deletes ${target.stateDir}` +
        (target.installDir ? ` and ${target.installDir}.` : '.'),
      'Your own harness installs and folders are not removed.',
    ]
    if (serverData && !options.deleteWorkspaceData)
      lines.push(
        `This machine runs the server: its workspace data in ${target.stateDir} is kept`,
        'unless you pass --delete-workspace-data.',
      )
    if (!(await ports.confirm(lines.join('\n')))) {
      say('Nothing was changed.')
      return undefined
    }
  }

  const report: UninstallReport = {
    machine: target.machineName,
    instanceId: target.instanceId,
    stopped: false,
    stopProblems: [],
    edits: [],
    removedUnits: [],
    removed: [],
    kept: [],
  }

  say('Stopping Podium…')
  report.stopProblems = await ports.stopServices()
  report.stopped = report.stopProblems.length === 0
  for (const problem of report.stopProblems) say(`  ${problem}`)

  say('Undoing Podium’s edits in your harness folders…')
  try {
    report.edits = await ports.undoHomeEdits()
  } catch (error) {
    report.undoError = error instanceof Error ? error.message : String(error)
  }
  if (report.undoError) say(`  Could not read Podium’s record of its edits: ${report.undoError}`)
  else if (report.edits.length === 0) say('  Podium had no edits to undo.')
  else {
    for (const edit of report.edits)
      say(
        `  ${edit.status === 'changed' ? 'changed since' : edit.status}: ${edit.file} (${edit.harness})` +
          (edit.reason ? ` — ${edit.reason}` : ''),
      )
    say(`  ${summarize(report.edits)}.`)
  }

  report.removedUnits = await ports.removeServiceUnits()
  if (report.removedUnits.length) say(`Removed service units: ${report.removedUnits.join(', ')}`)

  const undone = !report.undoError && everyEditRestored(report.edits)
  const keepAll =
    !undone && !options.force
      ? 'an edit was not undone; rerun with --force to remove it anyway'
      : undefined
  // A service that would not stop may still hold the folder; never delete under it.
  const stillRunning =
    !report.stopped && !options.force
      ? 'a service did not stop; rerun with --force to remove it anyway'
      : undefined
  const keepState =
    keepAll ??
    stillRunning ??
    (serverData && !options.deleteWorkspaceData
      ? 'it holds the workspace data; pass --delete-workspace-data to remove it'
      : undefined)
  const remove = (path: string | undefined, reason: string | undefined) => {
    if (!path || !existsSync(path)) return
    if (reason) {
      report.kept.push({ path, reason })
      return
    }
    try {
      ports.removePath(path)
      report.removed.push(path)
    } catch (error) {
      report.kept.push({ path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  remove(target.stateDir, keepState)
  remove(target.installDir, keepAll ?? stillRunning)
  remove(target.commandPath, keepAll ?? stillRunning)
  for (const path of report.removed) say(`Removed ${path}`)
  for (const { path, reason } of report.kept) say(`Kept ${path}: ${reason}`)

  if (options.json) ports.out(JSON.stringify(report))
  else if (report.kept.length === 0) say('Podium is uninstalled from this machine.')
  return report
}

/** True when `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const c = resolve(child)
  const p = resolve(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * The command the installer put in `~/.local/bin`, only while it is still
 * Podium's: a link into the install folder (the default instance) or the
 * small launcher naming it (a named instance). Anything else there is left.
 */
export function installedCommandPath(
  instanceId: string,
  installDir: string,
  home: string = homedir(),
): string | undefined {
  const path = join(home, '.local', 'bin', instanceCommandName(instanceId))
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path)
      return within(resolve(dirname(path), link), installDir) ? path : undefined
    }
    if (stat.isFile() && stat.size < 4096) {
      const body = readFileSync(path, 'utf8')
      return body.includes(`exec "${join(installDir, 'podium')}"`) ? path : undefined
    }
  } catch {
    // absent
  }
  return undefined
}

/**
 * The installed bundle this command runs from. Undefined in a source checkout
 * (run through Bun), where there is no bundle of Podium's to remove.
 */
export function installedBundleDir(
  instanceId: string,
  compiled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!compiled) return undefined
  const dir = env.PODIUM_HOME ?? instanceInstallDir(instanceId, env)
  return existsSync(dir) ? dir : undefined
}

/** Every user unit Podium may have written for this instance. */
export function instanceUnitNames(instanceId: string): string[] {
  return [
    ...new Set([
      desiredParentUnit(instanceId),
      ...legacyUnitNames(instanceId),
      instanceServiceName('tunnel', instanceId),
      instanceServiceName('update', instanceId),
      instanceUpdateTimerName(instanceId),
    ]),
  ]
}

function hasSystemctl(): boolean {
  try {
    execFileSync('systemctl', ['--user', '--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** The real stop step: systemd units and slices when present, then every live run record. */
export async function stopInstanceServices(instanceId: string): Promise<string[]> {
  const problems: string[] = []
  if (hasSystemctl()) {
    const units = instanceUnitNames(instanceId)
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', ...units], {
        stdio: ['ignore', 'ignore', 'ignore'],
      })
    } catch {
      // Not every name exists; stop the ones that do one at a time below.
      for (const unit of units) {
        try {
          execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
        } catch {
          // absent
        }
      }
    }
    // Sessions and builds run in their own scopes, outside the services.
    for (const slice of [
      instanceSessionSliceName(instanceId),
      instanceBuildSliceName(instanceId),
    ]) {
      try {
        execFileSync('systemctl', ['--user', 'stop', slice], { stdio: 'ignore' })
      } catch {
        // absent
      }
    }
    for (const unit of [desiredParentUnit(instanceId)]) {
      try {
        execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore' })
        problems.push(`${unit} is still running.`)
      } catch {
        // inactive: stopped
      }
    }
  }
  const { listLive, RunRole, reclaim } = await import('@podium/runtime/run-registry')
  for (const role of RunRole.options) {
    try {
      await reclaim(role)
    } catch (error) {
      problems.push(`Could not stop ${role}: ${(error as Error).message}`)
    }
  }
  for (const record of listLive())
    if (record.pid !== process.pid)
      problems.push(`${record.role} (pid ${record.pid}) is still running.`)
  return problems
}

/** The real unit removal: only definitions that exist in the user unit folder. */
export async function removeInstanceUnits(instanceId: string): Promise<string[]> {
  if (!hasSystemctl()) return []
  const { removeUserUnits, userUnitDir } = await import('./cli-systemd')
  const present = instanceUnitNames(instanceId).filter((unit) =>
    existsSync(join(userUnitDir(), unit)),
  )
  await removeUserUnits(present)
  return present
}

/** `podium uninstall` with the real machine. */
export async function uninstallCommand(
  argv: string[],
  deps: {
    undoHomeEdits?: () => Promise<UninstallEditOutcome[]>
    compiled: boolean
    confirm: (question: string) => Promise<boolean>
  },
): Promise<number> {
  const parsed = parseUninstallArgs(argv)
  if ('error' in parsed) {
    console.error(parsed.error)
    return 2
  }
  const { loadConfig, resolveInstanceId, resolveSetting, stateDir } = await import(
    '@podium/runtime/config'
  )
  const instanceId = resolveInstanceId()
  const config = loadConfig()
  const installDir = installedBundleDir(instanceId, deps.compiled)
  const target: UninstallTarget = {
    instanceId,
    machineName: hostname(),
    mode: resolveSetting('mode', config).value,
    stateDir: stateDir(),
    installDir,
    commandPath: installDir ? installedCommandPath(instanceId, installDir) : undefined,
  }
  const report = await runUninstall(parsed, target, {
    confirm: deps.confirm,
    stopServices: () => stopInstanceServices(instanceId),
    undoHomeEdits:
      deps.undoHomeEdits ??
      (async () => {
        throw new Error('this build cannot read the record of home edits')
      }),
    removeServiceUnits: () => removeInstanceUnits(instanceId),
    removePath: (path) => rmSync(path, { recursive: true, force: true }),
    out: (line) => console.log(line),
  })
  if (!report) return 1
  return report.kept.length === 0 ? 0 : 1
}
