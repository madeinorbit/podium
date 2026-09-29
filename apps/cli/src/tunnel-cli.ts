/**
 * `podium tunnel enable|disable` — the OPT-IN supervised Cloudflare quick tunnel
 * (POD-4640).
 *
 * `enable` installs a systemd user unit that runs podium-tunnel (native/podium-tunnel,
 * a small Rust program shipped beside the podium binary). podium-tunnel owns
 * cloudflared: it starts it, reads each new trycloudflare URL, and posts it to the
 * server's control socket, which records it and publishes it to Podium Connect.
 * `disable` stops the unit and removes it.
 *
 * NOTHING RUNS THIS FOR YOU. The design rule is "never auto-run a tunnel"
 * (docs/internal/superpowers/specs/2026-06-30-distribution-onboarding-design.md):
 * setup prints the cloudflared command as it always has, and this is the second,
 * explicit step — refused unless the operator already chose the quick tunnel.
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  type EnvSource,
  LAYERED_ENV,
  loadConfig,
  type PodiumConfig,
  resolveInstallDir,
  resolveLocalServerHost,
  resolveSetting,
} from '@podium/runtime/config'
import { instanceServiceName, instanceStateDir, resolveInstanceId } from '@podium/runtime/instance'
import { commandExists, networkOptionTool } from '@podium/runtime/setup'
import { serverControlSocketPath } from '@podium/runtime/user-socket'
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
  'usage: podium tunnel <enable|disable>',
  '',
  '  enable    Keep a Cloudflare quick tunnel running as a systemd user service,',
  '            and record each new https://<random>.trycloudflare.com URL as this',
  "            server's public URL, so Podium Connect can hand it to joined machines.",
  '  disable   Stop that service and remove it.',
  '',
  'Opt-in: choose "Cloudflare quick tunnel" in `podium setup` first.',
].join('\n')

/** The tunnel binary's file name in the headless bundle. */
export const TUNNEL_BINARY = 'podium-tunnel'

export type TunnelPreflight =
  | { ok: true; origin: string; binary: string }
  | { ok: false; reason: string }

/**
 * The local origin cloudflared forwards to. IPv4 loopback rather than `localhost`,
 * matching the command setup prints (networkOptionCommand): a `localhost` that
 * resolves to ::1 first reaches nothing when the server bound 127.0.0.1. A server
 * bound to one specific interface is reachable only there.
 */
export function tunnelOrigin(port: number, env: EnvSource = process.env): string {
  const host = resolveLocalServerHost(env)
  return `http://${host === 'localhost' ? '127.0.0.1' : host}:${port}`
}

/**
 * Where podium-tunnel is: PODIUM_TUNNEL_BIN, else beside the podium binary in the
 * installed bundle. A source checkout builds it with cargo and points
 * PODIUM_TUNNEL_BIN at the result.
 */
export function resolveTunnelBinary(env: EnvSource = process.env): string {
  return env.PODIUM_TUNNEL_BIN ?? join(resolveInstallDir(env), TUNNEL_BINARY)
}

/**
 * May this box enable the tunnel? Every refusal is a sentence the operator can act
 * on. The environment owning the URL comes first: no amount of re-running setup
 * fixes that one.
 */
export function tunnelPreflight(input: {
  config: PodiumConfig
  env: EnvSource
  hasBinary?: (binary: string) => boolean
  fileExists?: (path: string) => boolean
}): TunnelPreflight {
  const { config, env } = input
  if (resolveSetting('publicUrl', {}, env).source === 'env') {
    return {
      ok: false,
      reason:
        `${LAYERED_ENV.publicUrl} is set in this deployment's environment; the deployment ` +
        'owns the public URL, so a quick tunnel cannot record its rotating URL here.',
    }
  }
  const mode = resolveSetting('mode', config, env).value
  if (mode !== 'all-in-one' && mode !== 'server') {
    return {
      ok: false,
      reason: `a quick tunnel exposes this box's server, and this box is ${
        mode ? `mode=${mode}` : 'not configured'
      }. Run it on the box that hosts the server.`,
    }
  }
  // THE OPT-IN: the operator chose this option in setup; this command is the
  // second, explicit step. Neither happens by default.
  if (config.networkOption !== 'cloudflare-tunnel') {
    return {
      ok: false,
      reason:
        'this box is not set up for a Cloudflare quick tunnel. Choose "Cloudflare quick tunnel" ' +
        'in `podium setup` first.',
    }
  }
  const tool = networkOptionTool('cloudflare-tunnel')
  const hasBinary = input.hasBinary ?? ((binary: string) => commandExists(binary, env))
  if (tool && !hasBinary(tool.binary)) {
    return {
      ok: false,
      reason:
        `${tool.binary} is not installed (not on PATH).` +
        (tool.install ? ` Install it with:\n${tool.install}` : '') +
        `\nOther ways to install it: ${tool.docs}`,
    }
  }
  const binary = resolveTunnelBinary(env)
  if (!(input.fileExists ?? existsSync)(binary)) {
    return {
      ok: false,
      reason:
        `${TUNNEL_BINARY} is not at ${binary}. From a source checkout, build it with ` +
        '`cargo build --release --manifest-path native/podium-tunnel/Cargo.toml` and set ' +
        'PODIUM_TUNNEL_BIN to native/podium-tunnel/target/release/podium-tunnel.',
    }
  }
  const port = resolveSetting('port', config, env).value
  return { ok: true, origin: tunnelOrigin(port, env), binary }
}

export interface TunnelCliIo {
  out(line: string): void
  err(line: string): void
}

export interface TunnelCliDeps {
  io?: TunnelCliIo
  env?: EnvSource
  config?: PodiumConfig
  hasBinary?: (binary: string) => boolean
  fileExists?: (path: string) => boolean
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

export function tunnelCliMain(args: string[], deps: TunnelCliDeps = {}): number {
  const io = deps.io ?? consoleIo
  const [command, ...rest] = args
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.out(TUNNEL_USAGE)
    return command === undefined ? 2 : 0
  }
  if (rest.length > 0) {
    io.err(`podium tunnel ${command}: unexpected argument ${rest[0]}\n\n${TUNNEL_USAGE}`)
    return 2
  }
  if (command === 'enable') return enable(io, deps)
  if (command === 'disable') return disable(io, deps)
  io.err(`podium tunnel: unknown command ${command}\n\n${TUNNEL_USAGE}`)
  return 2
}

function enable(io: TunnelCliIo, deps: TunnelCliDeps): number {
  const env = deps.env ?? process.env
  const preflight = tunnelPreflight({
    config: deps.config ?? loadConfig(),
    env,
    ...(deps.hasBinary ? { hasBinary: deps.hasBinary } : {}),
    ...(deps.fileExists ? { fileExists: deps.fileExists } : {}),
  })
  if (!preflight.ok) {
    io.err(`podium tunnel: ${preflight.reason}`)
    return 1
  }
  const instanceId = resolveInstanceId(env)
  // The same derivation the server uses for its own socket, so neither is told.
  const socket = serverControlSocketPath({ instanceId, root: instanceStateDir(instanceId, env) })
  if (!(deps.hasSystemctl ?? hasSystemctl)() || !(deps.hasUserSystemd ?? hasUserSystemd)()) {
    io.err(
      'podium tunnel: this host has no systemd user session to run the tunnel as a service. ' +
        `Run it under a supervisor of your choice instead:\n  ${preflight.binary} --origin ` +
        `${preflight.origin} --socket ${socket}`,
    )
    return 1
  }
  const unit = instanceServiceName('tunnel', instanceId)
  const body = renderTunnelUnit({
    instanceId,
    binary: preflight.binary,
    origin: preflight.origin,
    socket,
  })
  try {
    ;(deps.writeUnit ?? ((name, text) => void writeUserUnit(name, text)))(unit, body)
    ;(
      deps.enableAndStart ??
      ((name) => {
        enableSystemdUnits([name])
        startSystemdUnits([name])
      })
    )(unit)
  } catch (error) {
    io.err(`podium tunnel: could not enable ${unit}: ${(error as Error).message}`)
    return 1
  }
  io.out(`Quick tunnel enabled as ${unit}.`)
  io.out("Each new trycloudflare URL is recorded as this server's public URL.")
  io.out(`Watch it with: journalctl --user -u ${unit} -f`)
  return 0
}

function disable(io: TunnelCliIo, deps: TunnelCliDeps): number {
  const unit = instanceServiceName('tunnel', resolveInstanceId(deps.env ?? process.env))
  try {
    ;(
      deps.disableAndRemove ??
      ((name) => {
        try {
          disableSystemdUnits([name])
        } catch {
          // Not enabled, or never installed — still remove the file.
        }
        rmSync(join(userUnitDir(), name), { force: true })
        reloadUserSystemd()
      })
    )(unit)
  } catch (error) {
    io.err(`podium tunnel: could not disable ${unit}: ${(error as Error).message}`)
    return 1
  }
  io.out(
    `Quick tunnel ${unit} stopped and removed. The last URL stays recorded until you change it.`,
  )
  return 0
}
