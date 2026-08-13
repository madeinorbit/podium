import { spawn } from 'node:child_process'

const DEFAULT_RESTART_DELAY_MS = 750

export function sourceRedeployUnit(instanceId: string): string {
  return instanceId === 'default'
    ? 'podium-redeploy.service'
    : `podium-${instanceId}-redeploy.service`
}

export function sourceWebUnit(instanceId: string): string {
  return instanceId === 'default' ? 'podium-web.service' : `podium-${instanceId}-web.service`
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
function createSourceUnitRequest(deps: {
  unit: string
  verb: 'start' | 'restart'
  env?: NodeJS.ProcessEnv
  delayMs?: number
  startUnit?: (unit: string) => void
}): (() => void) | undefined {
  const env = deps.env ?? process.env
  if (!env.INVOCATION_ID) return undefined
  const startUnit =
    deps.startUnit ??
    ((name: string) => {
      const child = spawn('systemctl', ['--user', '--no-block', deps.verb, name], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    })
  let requested = false
  return () => {
    if (requested) return
    requested = true
    const timer = setTimeout(() => startUnit(deps.unit), deps.delayMs ?? DEFAULT_RESTART_DELAY_MS)
    timer.unref?.()
  }
}

export function createSourceRedeployRequest(deps: {
  instanceId: string
  env?: NodeJS.ProcessEnv
  delayMs?: number
  startUnit?: (unit: string) => void
}): (() => void) | undefined {
  return createSourceUnitRequest({
    unit: sourceRedeployUnit(deps.instanceId),
    verb: 'start',
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.delayMs !== undefined ? { delayMs: deps.delayMs } : {}),
    ...(deps.startUnit ? { startUnit: deps.startUnit } : {}),
  })
}

/**
 * Rebuild the source-host web dist without bouncing a server that is already
 * on this HEAD. `podium-web.service` is RemainAfterExit, so this must restart.
 */
export function createSourceWebRebuildRequest(deps: {
  instanceId: string
  env?: NodeJS.ProcessEnv
  delayMs?: number
  startUnit?: (unit: string) => void
}): (() => void) | undefined {
  return createSourceUnitRequest({
    unit: sourceWebUnit(deps.instanceId),
    verb: 'restart',
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.delayMs !== undefined ? { delayMs: deps.delayMs } : {}),
    ...(deps.startUnit ? { startUnit: deps.startUnit } : {}),
  })
}
