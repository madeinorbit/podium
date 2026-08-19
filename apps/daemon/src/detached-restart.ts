import { type SpawnOptions, spawn } from 'node:child_process'

type SpawnedProcess = { unref(): void }

export interface DetachedRestartDeps {
  env?: NodeJS.ProcessEnv
  execPath?: string
  argv?: readonly string[]
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess
  exit?: (code: number) => void
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
      env: { ...env },
    })
    successor.unref()
    exit(0)
  }
}
