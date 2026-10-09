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
 * NOTHING RUNS THIS UNASKED. The design rule is "never auto-run a tunnel"
 * (docs/internal/superpowers/specs/2026-06-30-distribution-onboarding-design.md).
 * `podium setup` offers it as one of the reachability choices and runs it only when
 * the operator picks that choice (POD-3274); this command is the same step for a box
 * set up before that, and is refused unless the operator chose the quick tunnel.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type EnvSource,
  forgetConfig,
  LAYERED_ENV,
  loadConfig,
  type PodiumConfig,
  resolveInstallDir,
  resolveLocalServerHost,
  resolveSetting,
} from '@podium/runtime/config'
import { instanceServiceName, instanceStateDir, resolveInstanceId } from '@podium/runtime/instance'
import { cloudflaredDownloadUrl, findCommand, networkOptionTool } from '@podium/runtime/setup'
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

/** cloudflared's file name, on PATH or as the copy setup downloads beside podium. */
export const CLOUDFLARED_BINARY = 'cloudflared'

export type TunnelPreflight =
  | {
      ok: true
      origin: string
      binary: string
      /** cloudflared's absolute path. The unit runs with a fixed PATH of its own, so it is
       *  always told where cloudflared is rather than left to find it. */
      cloudflared: string
    }
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

/** The cloudflared `podium setup` downloads: beside podium, so a user-level install needs
 *  no sudo and nothing outside Podium's own directory. */
export function bundledCloudflaredPath(env: EnvSource = process.env): string {
  return join(resolveInstallDir(env), CLOUDFLARED_BINARY)
}

/**
 * Which cloudflared podium-tunnel should run, or undefined when there is none. PATH
 * first — an operator's own install wins — as an ABSOLUTE path, because the unit runs
 * with a fixed PATH of its own that need not contain the operator's; then the copy
 * setup downloaded.
 */
export function resolveCloudflared(
  env: EnvSource = process.env,
  find: (binary: string) => string | undefined = (binary) => findCommand(binary, env),
  fileExists: (path: string) => boolean = existsSync,
): string | undefined {
  const onPath = find(CLOUDFLARED_BINARY)
  if (onPath) return onPath
  const bundled = bundledCloudflaredPath(env)
  return fileExists(bundled) ? bundled : undefined
}

/**
 * May this box enable the tunnel? Every refusal is a sentence the operator can act
 * on. The environment owning the URL comes first: no amount of re-running setup
 * fixes that one.
 */
export function tunnelPreflight(input: {
  config: PodiumConfig
  env: EnvSource
  /** Injected for tests: where `binary` is on PATH, or undefined. */
  findBinary?: (binary: string) => string | undefined
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
  const fileExists = input.fileExists ?? existsSync
  const cloudflared = resolveCloudflared(
    env,
    input.findBinary ?? ((binary) => findCommand(binary, env)),
    fileExists,
  )
  if (cloudflared === undefined) {
    const tool = networkOptionTool('cloudflare-tunnel')
    return {
      ok: false,
      reason:
        `${CLOUDFLARED_BINARY} is not installed (not on PATH, and not at ` +
        `${bundledCloudflaredPath(env)}). \`podium setup\` can download it for you.` +
        (tool?.install ? ` Or install it yourself with:\n${tool.install}` : '') +
        (tool ? `\nOther ways to install it: ${tool.docs}` : ''),
    }
  }
  const binary = resolveTunnelBinary(env)
  if (!fileExists(binary)) {
    return {
      ok: false,
      reason:
        `${TUNNEL_BINARY} is not at ${binary}. From a source checkout, build it with ` +
        '`cargo build --release --manifest-path native/podium-tunnel/Cargo.toml` and set ' +
        'PODIUM_TUNNEL_BIN to native/podium-tunnel/target/release/podium-tunnel.',
    }
  }
  const port = resolveSetting('port', config, env).value
  return { ok: true, origin: tunnelOrigin(port, env), binary, cloudflared }
}

export interface TunnelCliIo {
  out(line: string): void
  err(line: string): void
}

export interface TunnelCliDeps {
  io?: TunnelCliIo
  env?: EnvSource
  config?: PodiumConfig
  findBinary?: (binary: string) => string | undefined
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

export type EnableTunnelResult = { ok: true; unit: string } | { ok: false; reason: string }

/**
 * Install and start the tunnel unit. The step both `podium tunnel enable` and
 * `podium setup` take; every refusal is a sentence for the operator.
 */
export function enableTunnel(deps: Omit<TunnelCliDeps, 'io'> = {}): EnableTunnelResult {
  const env = deps.env ?? process.env
  const preflight = tunnelPreflight({
    config: deps.config ?? loadConfig(),
    env,
    ...(deps.findBinary ? { findBinary: deps.findBinary } : {}),
    ...(deps.fileExists ? { fileExists: deps.fileExists } : {}),
  })
  if (!preflight.ok) return preflight
  const instanceId = resolveInstanceId(env)
  // The same derivation the server uses for its own socket, so neither is told.
  const socket = serverControlSocketPath({ instanceId, root: instanceStateDir(instanceId, env) })
  if (!(deps.hasSystemctl ?? hasSystemctl)() || !(deps.hasUserSystemd ?? hasUserSystemd)()) {
    return {
      ok: false,
      reason:
        'this host has no systemd user session to run the tunnel as a service. ' +
        `Run it under a supervisor of your choice instead:\n  ${preflight.binary} --origin ` +
        `${preflight.origin} --socket ${socket} --cloudflared ${preflight.cloudflared}`,
    }
  }
  const unit = instanceServiceName('tunnel', instanceId)
  const body = renderTunnelUnit({
    instanceId,
    binary: preflight.binary,
    origin: preflight.origin,
    socket,
    cloudflared: preflight.cloudflared,
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
    return { ok: false, reason: `could not enable ${unit}: ${(error as Error).message}` }
  }
  return { ok: true, unit }
}

function enable(io: TunnelCliIo, deps: TunnelCliDeps): number {
  const result = enableTunnel(deps)
  if (!result.ok) {
    io.err(`podium tunnel: ${result.reason}`)
    return 1
  }
  io.out(`Quick tunnel enabled as ${result.unit}.`)
  io.out("Each new trycloudflare URL is recorded as this server's public URL.")
  io.out(`Watch it with: journalctl --user -u ${result.unit} -f`)
  return 0
}

/**
 * Download Cloudflare's own cloudflared build beside podium and prove it runs. Written
 * to a temporary name and renamed into place, so an interrupted download never leaves a
 * half-written file where {@link resolveCloudflared} would find it. Returns the path.
 */
export async function downloadCloudflared(
  env: EnvSource = process.env,
  arch: string = process.arch,
): Promise<string> {
  const url = cloudflaredDownloadUrl(arch)
  if (!url) throw new Error(`Cloudflare publishes no cloudflared build for ${arch}`)
  const dest = bundledCloudflaredPath(env)
  const partial = `${dest}.download`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`)
  mkdirSync(resolveInstallDir(env), { recursive: true })
  try {
    writeFileSync(partial, new Uint8Array(await res.arrayBuffer()))
    chmodSync(partial, 0o755)
    const probe = spawnSync(partial, ['--version'], { encoding: 'utf8', timeout: 15_000 })
    if (probe.status !== 0) {
      throw new Error(`the downloaded cloudflared does not run: ${probe.stderr || probe.error}`)
    }
    renameSync(partial, dest)
  } finally {
    rmSync(partial, { force: true })
  }
  return dest
}

/**
 * Wait for the server to record the tunnel's address. podium-tunnel hands each URL
 * to the server, which writes it to config — so the config file is where it shows up.
 * Re-read from disk every poll: another process wrote it. Undefined on timeout.
 */
export async function waitForTunnelUrl(
  opts: { timeoutMs?: number; pollMs?: number; previous?: string } = {},
): Promise<string | undefined> {
  // Generous on purpose: cloudflared's own retries, then podium-tunnel holding the URL up
  // to 45 s until Cloudflare's nameservers serve it. Running out only costs the check —
  // the tunnel records the address whenever it comes.
  const deadline = Date.now() + (opts.timeoutMs ?? 150_000)
  for (;;) {
    forgetConfig()
    const url = loadConfig().publicUrl
    if (url && url !== opts.previous && /\.trycloudflare\.com\/?$/.test(url)) return url
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 500))
  }
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
