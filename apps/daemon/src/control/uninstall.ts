/**
 * THE MACHINE MENU'S "UNINSTALL PODIUM" (managed installs §12 item 14).
 *
 * The server asks with `machineUninstallRequest`. This daemon:
 * 1. refuses when it cannot leave on its own: the desktop app supervises it
 *    (the app would start it again), or this instance runs the server too;
 * 2. undoes the edits Podium made in the person's harness folders, so the
 *    answer carries each edit's outcome;
 * 3. starts `podium uninstall --yes` OUTSIDE its own service, a few seconds
 *    later, so the reply reaches the server first and stopping the services
 *    (this daemon with them) does not stop the uninstall;
 * 4. answers.
 *
 * `podium uninstall` then stops the services and sessions, runs the undo again
 * (anything a session started since is caught there; a kept edit is reported
 * the same way again), removes the service units, and removes Podium's files
 * when every edit was restored or `force` was asked for.
 */

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@podium/logger'
import {
  everyEditRestored,
  type MachineUninstallRequestMessage,
  type MachineUninstallResultMessage,
  type UninstallEditOutcome,
} from '@podium/protocol'
import type { ControlHandlers } from './context'

const log = createLogger('daemon:uninstall')

/** Seconds between the answer and the start of the removal. */
export const UNINSTALL_START_DELAY_S = 5

/** The environment a removal needs to find this instance's folders. */
const CARRIED_ENV = [
  'PODIUM_INSTANCE',
  'PODIUM_STATE_DIR',
  'PODIUM_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
] as const

export interface UninstallLaunch {
  /** The `podium` command, as argv, without the `uninstall` arguments. */
  command: string[]
  /** `PODIUM_*` and `XDG_*` values the removal must see. */
  env: Record<string, string>
}

export interface MachineUninstallDeps {
  env: NodeJS.ProcessEnv
  /** The instance's configured mode; `server` and `all-in-one` refuse. */
  mode(): string | undefined
  undoAll(): Promise<UninstallEditOutcome[]>
  /** Start the removal; throws when it could not be started. */
  launch(launch: UninstallLaunch, args: string[]): void
  /** The `podium` argv this daemon runs from. */
  command(): string[]
}

/** The `podium` this daemon runs from: the packaged binary, or the source entry through Bun. */
export function podiumCommand(
  execPath: string = process.execPath,
  moduleUrl: string = import.meta.url,
): string[] {
  if (/\/\$bunfs\/|\/(?:~|%7E)BUN\//i.test(moduleUrl)) return [execPath]
  const entry = fileURLToPath(new URL('../../../../scripts/cli.ts', moduleUrl))
  return [execPath, '--conditions=@podium/source', entry]
}

function carriedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const carried: Record<string, string> = {}
  for (const key of CARRIED_ENV) {
    const value = env[key]
    if (value) carried[key] = value
  }
  return carried
}

function hasSystemdRun(): boolean {
  return spawnSync('systemd-run', ['--user', '--version'], { stdio: 'ignore' }).status === 0
}

/**
 * Start the removal outside this daemon's service: a transient user unit
 * under systemd (its own cgroup, so stopping Podium's units leaves it
 * running), otherwise a detached process in its own session.
 */
export function launchUninstall(launch: UninstallLaunch, args: string[]): void {
  const argv = [...launch.command, 'uninstall', ...args]
  if (hasSystemdRun()) {
    const unit = `podium-uninstall-${Date.now()}`
    const result = spawnSync(
      'systemd-run',
      [
        '--user',
        '--collect',
        '--quiet',
        `--unit=${unit}`,
        `--on-active=${UNINSTALL_START_DELAY_S}`,
        ...Object.entries(launch.env).map(([key, value]) => `--setenv=${key}=${value}`),
        ...argv,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    )
    if (result.status !== 0)
      throw new Error(
        `systemd-run refused the uninstall: ${result.stderr?.trim() || result.status}`,
      )
    return
  }
  const child = spawn(
    '/bin/sh',
    ['-c', `sleep ${UNINSTALL_START_DELAY_S}; exec "$@"`, 'podium-uninstall', ...argv],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        ...launch.env,
      },
    },
  )
  child.unref()
}

export async function handleMachineUninstall(
  msg: MachineUninstallRequestMessage,
  deps: MachineUninstallDeps,
): Promise<MachineUninstallResultMessage> {
  const refuse = (error: string): MachineUninstallResultMessage => ({
    type: 'machineUninstallResult',
    requestId: msg.requestId,
    ok: false,
    error,
  })
  if (deps.env.PODIUM_DESKTOP_SUPERVISED === '1')
    return refuse('The Podium app runs Podium on this machine. Uninstall the app there instead.')
  const mode = deps.mode()
  if (mode === 'server' || mode === 'all-in-one')
    return refuse('This machine runs the server. Run podium uninstall on it instead.')
  let outcomes: UninstallEditOutcome[]
  try {
    outcomes = await deps.undoAll()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('uninstall: the record of home edits could not be read', { error: message })
    return refuse(`Podium could not read its record of edits on this machine: ${message}`)
  }
  const removesState = msg.force === true || everyEditRestored(outcomes)
  try {
    deps.launch({ command: deps.command(), env: carriedEnv(deps.env) }, [
      '--yes',
      ...(msg.force ? ['--force'] : []),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('uninstall: the removal could not be started', { error: message })
    return {
      type: 'machineUninstallResult',
      requestId: msg.requestId,
      ok: false,
      outcomes,
      error: `The edits were undone, but the removal could not start: ${message}. Run podium uninstall on the machine.`,
    }
  }
  log.info('uninstall: removal starts shortly', {
    edits: outcomes.length,
    removesState,
  })
  return {
    type: 'machineUninstallResult',
    requestId: msg.requestId,
    ok: true,
    outcomes,
    removesState,
  }
}

/** The real machine: this process's env, config, undo and launcher. */
async function realDeps(): Promise<MachineUninstallDeps> {
  const [{ loadConfig, resolveSetting }, { undoAllHomeEditRecords }] = await Promise.all([
    import('@podium/runtime/config'),
    import('../home-edit-service'),
  ])
  return {
    env: process.env,
    mode: () => resolveSetting('mode', loadConfig()).value,
    undoAll: async () =>
      (await undoAllHomeEditRecords()).map((outcome) => ({
        harness: outcome.record.harness,
        file: outcome.record.file,
        status: outcome.status,
        ...(outcome.status === 'restored' ? {} : { reason: outcome.reason }),
      })),
    launch: launchUninstall,
    command: () => podiumCommand(),
  }
}

export const uninstallHandlers: Pick<ControlHandlers, 'machineUninstallRequest'> = {
  machineUninstallRequest: (ctx, msg) => {
    void realDeps()
      .then(async (deps) => await handleMachineUninstall(msg, deps))
      .catch(
        (error: unknown): MachineUninstallResultMessage => ({
          type: 'machineUninstallResult',
          requestId: msg.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((result) => ctx.send(result))
  },
}
