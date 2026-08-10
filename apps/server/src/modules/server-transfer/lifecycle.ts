import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

interface SourceRetirementDeps {
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
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PODIUM_RUN_MODE: 'detached' },
    })
    child.unref()
    child.once('error', () => {})
    schedule(() => exit(0), 50)
  }, deps.flushDelayMs ?? 250)
}
