import { type SpawnOptions, spawn } from 'node:child_process'
import { instanceServiceName } from '@podium/runtime/instance'

const DEFAULT_RESTART_DELAY_MS = 750
type SpawnedProcess = { unref(): void }

export interface InstalledRestartDeps {
  instanceId: string
  port: () => number
  env?: NodeJS.ProcessEnv
  execPath?: string
  delayMs?: number
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess
  schedule?: (callback: () => void, delayMs: number) => { unref?: () => void }
}

/**
 * Restart an installed coordinator after its local daemon has atomically
 * replaced the shared headless bundle. systemd is already a supervisor; the
 * detached setup path has none, so it starts replacement janitor and server
 * processes itself, with the server last because its takeover ends this PID.
 */
export function createInstalledCoordinatorRestart(
  deps: InstalledRestartDeps,
): (() => void) | undefined {
  const env = deps.env ?? process.env
  const systemd = Boolean(env.INVOCATION_ID)
  const detached = env.PODIUM_RUN_MODE === 'detached'
  if (!systemd && !detached) return undefined

  const spawnProcess = deps.spawnProcess ?? spawn
  const schedule = deps.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  let requested = false
  return () => {
    if (requested) return
    requested = true
    const timer = schedule(() => {
      if (systemd) {
        const child = spawnProcess(
          'systemctl',
          [
            '--user',
            '--no-block',
            'restart',
            instanceServiceName('janitor', deps.instanceId),
            instanceServiceName('server', deps.instanceId),
          ],
          { detached: true, stdio: 'ignore' },
        )
        child.unref()
        return
      }

      const nextEnv = { ...env, PODIUM_PORT: String(deps.port()) }
      const executable = deps.execPath ?? process.execPath
      const commands = [
        ['janitor', '--server', `http://127.0.0.1:${deps.port()}`, '--takeover'],
        ['server', '--takeover'],
      ] as const
      for (const args of commands) {
        const child = spawnProcess(executable, args, {
          detached: true,
          stdio: 'ignore',
          env: nextEnv,
        })
        child.unref()
      }
    }, deps.delayMs ?? DEFAULT_RESTART_DELAY_MS)
    timer.unref?.()
  }
}
