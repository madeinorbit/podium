import { spawnSync } from 'node:child_process'
import {
  timeReleaseBuildSync,
  type ReleaseBuildTimingLabels,
} from '@podium/runtime/release-build-timing'

export * from '@podium/runtime/release-build-timing'

class TimedCommandFailure extends Error {
  constructor(
    readonly status: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(signal ? `timed command exited on ${signal}` : `timed command exited with ${status}`)
  }
}

function cliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new TimedCommandFailure(result.status, result.signal)
}

/**
 * Opt-in wrapper for build commands that already form a useful task boundary.
 * The development publisher sets the flag for its detached approved checkout;
 * ordinary local packaging and release CI remain command-equivalent.
 */
function runCli(): void {
  if (process.argv[2] !== 'run') {
    throw new Error(
      'usage: release-build-timing.ts run --phase <phase> [--task <task>] -- <command>',
    )
  }
  const separator = process.argv.indexOf('--')
  const command = separator >= 0 ? process.argv[separator + 1] : undefined
  if (!command) throw new Error('release timing run needs a command after --')
  const phase = cliArg('--phase')
  if (!phase) throw new Error('release timing run needs --phase')
  const task = cliArg('--task')
  const target = cliArg('--target')
  const context = { ...(target ? { target } : {}) }
  const runTask = () =>
    task
      ? timeReleaseBuildSync({ granularity: 'task', phase, task, ...context }, () =>
          runCommand(command, process.argv.slice(separator + 2)),
        )
      : runCommand(command, process.argv.slice(separator + 2))

  try {
    timeReleaseBuildSync(
      { granularity: 'phase', phase, ...context } satisfies ReleaseBuildTimingLabels,
      runTask,
    )
  } catch (error) {
    if (error instanceof TimedCommandFailure) {
      if (error.signal) {
        process.kill(process.pid, error.signal)
        return
      }
      process.exitCode = error.status ?? 1
      return
    }
    throw error
  }
}

if (import.meta.main) runCli()
