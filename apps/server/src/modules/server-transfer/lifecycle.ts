import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { signalParentTopology } from '@podium/runtime/parent-control'
import { unsupervisedEnv } from '@podium/runtime/supervisor'

interface SourceRetirementDeps {
  signalTopology?: typeof signalParentTopology
  env?: Readonly<Record<string, string | undefined>>
  spawnProcess?: typeof spawn
  schedule?: (callback: () => void, delayMs: number) => void
  exit?: (code: number) => never | void
  flushDelayMs?: number
}

/**
 * Retire the old source host only after the committed mutation reply has had a
 * chance to flush. A desktop-supervised host exits and lets the native owner
 * launch exactly one daemon; headless hosts launch the lifecycle-aware takeover.
 */
export function retireSourceAfterTransfer(
  serverUrl: string,
  deps: SourceRetirementDeps = {},
): void {
  const spawnProcess = deps.spawnProcess ?? spawn
  const schedule = deps.schedule ?? ((callback, delayMs) => void setTimeout(callback, delayMs))
  const exit = deps.exit ?? process.exit
  schedule(() => {
    const posted = (deps.signalTopology ?? signalParentTopology)({
      children: ['daemon'],
      restartDaemon: true,
      health: 'daemon',
    })
    if (posted.ok) return

    if ((deps.env ?? process.env).PODIUM_DESKTOP_SUPERVISED === '1') {
      exit(0)
      return
    }

    const compiled = import.meta.url.includes('/$bunfs/')
    const args = compiled
      ? ['daemon', '--server', serverUrl, '--takeover']
      : [
          '--conditions=@podium/source',
          fileURLToPath(new URL('../../../../scripts/cli.ts', import.meta.url)),
          'daemon',
          '--server',
          serverUrl,
          '--takeover',
        ]
    const child: ChildProcess = spawnProcess(process.execPath, args, {
      // Detached ON PURPOSE, so `unsupervisedEnv`: the takeover daemon is meant to outlive this
      // process and must not inherit a supervisor pid to die with (POD-1228).
      detached: true,
      stdio: 'ignore',
      env: { ...unsupervisedEnv(process.env), PODIUM_RUN_MODE: 'detached' },
    })
    child.unref()
    child.once('error', () => {})
    schedule(() => exit(0), 50)
  }, deps.flushDelayMs ?? 250)
}

/** Restart after recovery changed the journal back to a writable boot posture. */
export function restartSourceAfterRecovery(
  deps: Pick<SourceRetirementDeps, 'schedule' | 'exit' | 'flushDelayMs'> = {},
): void {
  const schedule = deps.schedule ?? ((callback, delayMs) => void setTimeout(callback, delayMs))
  const exit = deps.exit ?? process.exit
  schedule(() => exit(0), deps.flushDelayMs ?? 250)
}
