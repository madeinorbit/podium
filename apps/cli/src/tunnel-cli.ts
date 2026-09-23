/**
 * `podium tunnel` — the OPT-IN supervised Cloudflare quick tunnel (POD-4640).
 *
 *   podium tunnel run       the wrapper service itself, in the foreground
 *   podium tunnel enable    install + start it as a systemd user unit
 *   podium tunnel disable   stop it and remove the unit
 *
 * `run` owns cloudflared: it starts it, records every new trycloudflare URL as
 * this server's public URL, restarts it with backoff when it dies, and takes it
 * down on SIGTERM/SIGINT. See packages/runtime/src/quick-tunnel.ts for why it
 * is its own service rather than a child of the server or the parent.
 *
 * Nothing runs this for you. Setup prints the cloudflared command as it always
 * has; this is the second, explicit step for an operator who chose the quick
 * tunnel and wants its URL kept current.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, resolvePort } from '@podium/runtime/config'
import { instanceServiceName, resolveInstanceId } from '@podium/runtime/instance'
import { CHILD_REFUSAL_EXIT_CODE } from '@podium/runtime/parent-supervisor'
import {
  acquireTunnelLock,
  QuickTunnelSupervisor,
  quickTunnelArgs,
  quickTunnelPreflight,
  type QuickTunnelLog,
  recordQuickTunnelUrl,
  spawnCloudflared,
  TunnelAlreadyRunningError,
} from '@podium/runtime/quick-tunnel'
import {
  disableSystemdUnits,
  enableSystemdUnits,
  hasSystemctl,
  hasUserSystemd,
  reloadUserSystemd,
  renderTunnelUnit,
  startSystemdUnits,
  userUnitDir,
  writeUserUnit,
} from './cli-systemd'

export const TUNNEL_USAGE = [
  'usage: podium tunnel <command>',
  '',
  'Commands:',
  '  run       Run the supervised Cloudflare quick tunnel in the foreground',
  '  enable    Install and start it as a systemd user service',
  '  disable   Stop the service and remove it',
  '',
  'A quick tunnel gets a new https://<random>.trycloudflare.com URL every time',
  'cloudflared restarts. This keeps cloudflared running and records each new URL',
  'as the public URL, so Podium Connect can hand it to your joined machines.',
  'Opt-in: choose "Cloudflare quick tunnel" in `podium setup` first.',
].join('\n')

export interface TunnelCliIo {
  out(line: string): void
  err(line: string): void
}

export interface TunnelCliDeps {
  io?: TunnelCliIo
  env?: NodeJS.ProcessEnv
  /** `run` only: resolves when the process is asked to stop (SIGTERM/SIGINT). */
  shutdownSignal?: () => Promise<string>
  hasSystemctl?: () => boolean
  hasUserSystemd?: () => boolean
  writeUnit?: (unit: string, body: string) => void
  enableAndStart?: (unit: string) => void
  disableAndRemove?: (unit: string) => void
}

const consoleIo: TunnelCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}

function waitForShutdownSignal(): Promise<string> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      resolve(signal)
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
  })
}

/** One line per event, to stdout/stderr — which is the journal under systemd. */
function lineLog(io: TunnelCliIo): QuickTunnelLog {
  const render = (message: string, fields?: Record<string, unknown>): string =>
    fields && Object.keys(fields).length > 0 ? `${message} ${JSON.stringify(fields)}` : message
  return {
    info: (message, fields) => io.out(render(message, fields)),
    warn: (message, fields) => io.err(render(message, fields)),
  }
}

export async function tunnelCliMain(args: string[], deps: TunnelCliDeps = {}): Promise<number> {
  const io = deps.io ?? consoleIo
  const env = deps.env ?? process.env
  const [command, ...rest] = args
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.out(TUNNEL_USAGE)
    return command === undefined ? 2 : 0
  }
  if (rest.length > 0) {
    io.err(`podium tunnel ${command}: unexpected argument ${rest[0]}\n\n${TUNNEL_USAGE}`)
    return 2
  }
  switch (command) {
    case 'run':
      return run(io, env, deps)
    case 'enable':
      return enable(io, env, deps)
    case 'disable':
      return disable(io, deps)
    default:
      io.err(`podium tunnel: unknown command ${command}\n\n${TUNNEL_USAGE}`)
      return 2
  }
}

async function run(io: TunnelCliIo, env: NodeJS.ProcessEnv, deps: TunnelCliDeps): Promise<number> {
  const preflight = quickTunnelPreflight({ env })
  if (!preflight.ok) {
    io.err(`podium tunnel: ${preflight.reason}`)
    // The refusal exit the tunnel unit will not restart on: re-running a
    // refused precondition every few seconds would only fill the journal.
    return CHILD_REFUSAL_EXIT_CODE
  }
  const log = lineLog(io)
  let lock: ReturnType<typeof acquireTunnelLock>
  try {
    lock = acquireTunnelLock()
  } catch (error) {
    if (error instanceof TunnelAlreadyRunningError) {
      io.err(`podium tunnel: ${error.message}`)
      return CHILD_REFUSAL_EXIT_CODE
    }
    throw error
  }
  if (lock.reapedOrphan !== undefined) {
    log.warn('tunnel: stopped a cloudflared left behind by a previous wrapper', {
      pid: lock.reapedOrphan,
    })
  }
  const supervisor = new QuickTunnelSupervisor({
    spawn: () =>
      spawnCloudflared({
        args: quickTunnelArgs(preflight.origin),
        env,
        echo: (chunk) => process.stderr.write(chunk),
      }),
    recordUrl: (url) => {
      recordQuickTunnelUrl(url)
    },
    recordedUrl: loadConfig().publicUrl,
    onChild: (pid) => lock.setChild(pid),
    log,
  })
  log.info('tunnel: starting cloudflared', { origin: preflight.origin })
  supervisor.start()
  const signal = await (deps.shutdownSignal ?? waitForShutdownSignal)()
  log.info('tunnel: stopping', { signal })
  try {
    await supervisor.stop()
  } finally {
    lock.release()
  }
  return 0
}

function enable(io: TunnelCliIo, env: NodeJS.ProcessEnv, deps: TunnelCliDeps): number {
  const preflight = quickTunnelPreflight({ env })
  if (!preflight.ok) {
    io.err(`podium tunnel: ${preflight.reason}`)
    return 1
  }
  if (!(deps.hasSystemctl ?? hasSystemctl)() || !(deps.hasUserSystemd ?? hasUserSystemd)()) {
    io.err(
      'podium tunnel: this host has no systemd user session to run the tunnel as a service. ' +
        'Run `podium tunnel run` under a supervisor of your choice (tmux, screen, an @reboot entry) instead.',
    )
    return 1
  }
  const instanceId = resolveInstanceId()
  const unit = instanceServiceName('tunnel', instanceId)
  const body = renderTunnelUnit({ instanceId, port: resolvePort(loadConfig(), env) })
  try {
    ;(deps.writeUnit ?? ((name, text) => void writeUserUnit(name, text)))(unit, body)
    ;(deps.enableAndStart ??
      ((name) => {
        enableSystemdUnits([name])
        startSystemdUnits([name])
      }))(unit)
  } catch (error) {
    io.err(`podium tunnel: could not enable ${unit}: ${(error as Error).message}`)
    return 1
  }
  io.out(`Quick tunnel enabled as ${unit}.`)
  io.out('Every new trycloudflare URL it gets is recorded as this server’s public URL.')
  io.out(`Watch it with: journalctl --user -u ${unit} -f`)
  return 0
}

function disable(io: TunnelCliIo, deps: TunnelCliDeps): number {
  const unit = instanceServiceName('tunnel', resolveInstanceId())
  try {
    ;(deps.disableAndRemove ??
      ((name) => {
        try {
          disableSystemdUnits([name])
        } catch {
          // Not enabled, or never installed — still remove the file.
        }
        rmSync(join(userUnitDir(), name), { force: true })
        reloadUserSystemd()
      }))(unit)
  } catch (error) {
    io.err(`podium tunnel: could not disable ${unit}: ${(error as Error).message}`)
    return 1
  }
  io.out(`Quick tunnel ${unit} stopped and removed. The last URL stays recorded until you change it.`)
  return 0
}
