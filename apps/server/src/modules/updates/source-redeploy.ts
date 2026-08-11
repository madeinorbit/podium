import { spawn } from 'node:child_process'

const DEFAULT_RESTART_DELAY_MS = 750

export function sourceRedeployUnit(instanceId: string): string {
  return instanceId === 'default'
    ? 'podium-redeploy.service'
    : `podium-${instanceId}-redeploy.service`
}

/**
 * Return the source-host restart capability only inside a systemd service.
 *
 * Moving the checkout makes the running server behind its dynamically
 * published dev target. The authenticated Update Podium mutation calls this
 * capability after granting the fleet. A short delay lets the mutation response
 * reach the browser before systemd runs the existing install/typecheck gate and
 * restarts server, daemon, web, and janitor together.
 */
export function createSourceRedeployRequest(deps: {
  instanceId: string
  env?: NodeJS.ProcessEnv
  delayMs?: number
  startUnit?: (unit: string) => void
}): (() => void) | undefined {
  const env = deps.env ?? process.env
  if (!env.INVOCATION_ID) return undefined
  const unit = sourceRedeployUnit(deps.instanceId)
  const startUnit =
    deps.startUnit ??
    ((name: string) => {
      const child = spawn('systemctl', ['--user', '--no-block', 'start', name], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    })
  let requested = false
  return () => {
    if (requested) return
    requested = true
    const timer = setTimeout(() => startUnit(unit), deps.delayMs ?? DEFAULT_RESTART_DELAY_MS)
    timer.unref?.()
  }
}
