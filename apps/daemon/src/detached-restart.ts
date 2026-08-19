import { type SpawnOptions, spawn } from 'node:child_process'

type SpawnedProcess = { unref(): void }
export const DETACHED_RESTART_PARENT_PID = 'PODIUM_RESTART_PARENT_PID'

export interface DetachedRestartDeps {
  env?: NodeJS.ProcessEnv
  execPath?: string
  argv?: readonly string[]
  pid?: number
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess
  exit?: (code: number) => void
}

export interface DetachedRestartWaitDeps {
  env?: NodeJS.ProcessEnv
  isAlive?: (pid: number) => boolean
  wait?: (milliseconds: number) => Promise<void>
  now?: () => number
}

/** Wait until the predecessor releases its hook and relay listeners before daemon boot. */
export async function waitForDetachedRestartParent(
  deps: DetachedRestartWaitDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env
  const rawParentPid = env[DETACHED_RESTART_PARENT_PID]
  delete env[DETACHED_RESTART_PARENT_PID]
  if (!rawParentPid) return

  const parentPid = Number(rawParentPid)
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return
  const isAlive =
    deps.isAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH'
      }
    })
  const wait =
    deps.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const now = deps.now ?? Date.now
  const deadline = now() + 10_000
  while (isAlive(parentPid) && now() < deadline) await wait(25)
}

/**
 * A detached Podium component has no supervisor: setup deliberately starts it
 * with setsid + unref and the launcher exits. After an update swaps the binary,
 * hand ownership to an identical successor before this daemon exits. The
 * existing `--takeover` argument makes the run-registry transition safe whether
 * the successor observes this process just before or just after it exits.
 */
export function createDetachedRestart(deps: DetachedRestartDeps = {}): (() => void) | undefined {
  const env = deps.env ?? process.env
  if (env.PODIUM_RUN_MODE !== 'detached') return undefined

  const execPath = deps.execPath ?? process.execPath
  const argv = deps.argv ?? process.argv
  const args = argv.slice(1)
  if (args.length === 0) return undefined

  const spawnProcess = deps.spawnProcess ?? spawn
  const exit = deps.exit ?? process.exit
  let requested = false
  return () => {
    if (requested) return
    requested = true
    const successor = spawnProcess(execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...env,
        [DETACHED_RESTART_PARENT_PID]: String(deps.pid ?? process.pid),
      },
    })
    successor.unref()
    exit(0)
  }
}
