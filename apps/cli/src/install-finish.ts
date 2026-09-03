/**
 * `podium install-finish` — everything the installer does AFTER the signature-verified
 * binary is on disk (POD-3274).
 *
 * install.sh is a bootstrap: args, platform, the tools needed to download and verify, the
 * download, the Ed25519 check, the extraction. Then it `exec`s this. The verified binary is
 * both the trust boundary and the UI boundary, so from here on the install runs from signed
 * code and is drawn with clack — including the boxes around anything the operator has to copy.
 *
 * Every step is IDEMPOTENT. If this dies partway the operator has a binary on disk and a
 * documented way forward: run it again.
 *
 * Not in `podium help`: install.sh is the only caller.
 */
import { applyChannel as realApplyChannel } from './cli-channel'
import {
  runCliSetup as realRunCliSetup,
  runJoinSetup as realRunJoinSetup,
  runVpsSetup as realRunVpsSetup,
  type StartBackendResult,
} from './cli-setup'
import { installAgents as realInstallAgents } from './install-agents'
import { pathHint as realPathHint, persistPath as realPersistPath } from './install-path'
import {
  probeSupervision as realProbeSupervision,
  type SupervisionProbe,
} from './install-supervision'
import type { SetupIO } from './setup-ui'

const CHANNELS = ['stable', 'edge'] as const
export type InstallChannel = (typeof CHANNELS)[number]

export interface InstallFinishOptions {
  channel: InstallChannel
  instance: string
  /** Where the payload landed. */
  dest: string
  /** The directory holding the launcher. */
  bin: string
  /** The launcher's name: `podium`, or `podium-<instance>`. */
  command: string
  agents: string[]
  vps: boolean
  modifyPath: boolean
  interactive: boolean
  /** From `PODIUM_JOIN_TOKEN`, never argv — see `parseInstallFinishArgs`. */
  joinToken?: string
}

export interface InstallFinishDeps {
  applyChannel?: (channel: string) => void
  persistPath?: (bin: string, home?: string) => { written: string[]; persisted: boolean }
  probeSupervision?: () => SupervisionProbe
  installAgents?: (io: SetupIO, ids: string[], bin: string) => Promise<unknown>
  runJoinSetup?: (
    token: string,
    persistence: 'systemd' | 'detached',
    port: number,
  ) => Promise<{ name: string; warning?: string; result: StartBackendResult }>
  runCliSetup?: (io: SetupIO, port: number) => Promise<void>
  runVpsSetup?: (io: SetupIO, port: number) => Promise<void>
  isTTY?: () => boolean
  home?: string
  port?: number
  /** The PATH to test the bin dir against; injected so a test need not mutate process.env. */
  pathOf?: () => string
}

const DEFAULT_PORT = 18787

/**
 * Parse what install.sh passes. Kept strict — an unknown flag is a bug in the handoff, and
 * silently ignoring it would install a differently-configured box than the operator asked for.
 */
export function parseInstallFinishArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): InstallFinishOptions | { error: string } {
  const o: Partial<InstallFinishOptions> = {
    channel: 'stable',
    instance: 'default',
    agents: [],
    vps: false,
    modifyPath: true,
    interactive: true,
  }
  const need = (i: number, flag: string): string | undefined => {
    const v = argv[i + 1]
    return v === undefined || v.startsWith('--') ? undefined : v
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--channel': {
        const v = need(i, arg)
        if (v === undefined) return { error: 'install-finish: --channel requires a value' }
        if (!CHANNELS.includes(v as InstallChannel))
          return { error: `install-finish: unknown channel '${v}' (use: stable | edge)` }
        o.channel = v as InstallChannel
        i++
        break
      }
      case '--instance': {
        const v = need(i, arg)
        if (v === undefined) return { error: 'install-finish: --instance requires an ID' }
        o.instance = v
        i++
        break
      }
      case '--dest':
      case '--bin':
      case '--command': {
        const v = need(i, arg)
        if (v === undefined) return { error: `install-finish: ${arg} requires a value` }
        o[arg.slice(2) as 'dest' | 'bin' | 'command'] = v
        i++
        break
      }
      case '--agents': {
        const v = need(i, arg)
        if (v === undefined) return { error: 'install-finish: --agents requires a value' }
        o.agents = v.split(',').filter(Boolean)
        i++
        break
      }
      case '--vps':
        o.vps = true
        break
      case '--no-modify-path':
        o.modifyPath = false
        break
      case '--no-interactive':
        o.interactive = false
        break
      // Accepted and INERT. install.sh has always taken these and nothing has ever read the
      // value; whether they should mean something is POD-3309's call, not this flow's.
      case '--managed':
      case '--shared':
        break
      case '--join':
        return {
          error:
            'install-finish: --join is not a flag — pass the token as PODIUM_JOIN_TOKEN so it ' +
            'stays out of /proc/*/cmdline',
        }
      default:
        return { error: `install-finish: unknown arg '${arg}'` }
    }
  }
  for (const required of ['dest', 'bin', 'command'] as const) {
    if (!o[required]) return { error: `install-finish: --${required} is required` }
  }
  const token = env.PODIUM_JOIN_TOKEN?.trim()
  return { ...(o as InstallFinishOptions), ...(token ? { joinToken: token } : {}) }
}

export async function runInstallFinish(
  io: SetupIO,
  opts: InstallFinishOptions,
  deps: InstallFinishDeps = {},
): Promise<void> {
  const applyChannel = deps.applyChannel ?? ((c: string) => void realApplyChannel(c))
  const persistPath = deps.persistPath ?? realPersistPath
  const probeSupervision = deps.probeSupervision ?? realProbeSupervision
  const runJoinSetup = deps.runJoinSetup ?? realRunJoinSetup
  const runCliSetup = deps.runCliSetup ?? ((i: SetupIO, p: number) => realRunCliSetup(i, p))
  const runVpsSetup = deps.runVpsSetup ?? ((i: SetupIO, p: number) => realRunVpsSetup(i, p))
  const isTTY = deps.isTTY ?? (() => process.stdin.isTTY === true)
  const port = deps.port ?? DEFAULT_PORT

  // FIRST, always (R4): every later step — and every future `podium update` — reads it, and
  // a box that installed from edge but records stable will silently drift onto stable.
  applyChannel(opts.channel)

  let persisted = false
  if (opts.modifyPath) {
    const res = persistPath(opts.bin, deps.home)
    persisted = res.persisted
    if (res.written.length > 0) io.success(`Added ${opts.bin} to your PATH for new shells`)
  }

  const supervision = probeSupervision()
  if (!supervision.systemd) {
    io.warn(
      `No systemd service — ${supervision.why}.\n` +
        'Podium will run detached instead: working now, but not restarted after a reboot.',
    )
    if (supervision.fix) io.step(supervision.fix)
  }

  const persistence = supervision.systemd ? 'systemd' : 'detached'
  let joined: string | undefined
  if (opts.joinToken) {
    // Non-interactive by construction: the hub already decided this machine's role, so there
    // is nothing to ask. A failure here must PROPAGATE — install.sh exits non-zero on it,
    // because a machine that did not join is not a machine the operator can use.
    const spin = io.spinner()
    spin.start('Joining your Podium')
    try {
      const { name, warning, result } = await runJoinSetup(opts.joinToken, persistence, port)
      spin.stop(`Joined as "${name}".`)
      if (warning) io.warn(warning)
      if (result.message) io.step(result.message)
      joined = name
    } catch (e) {
      spin.error((e as Error).message)
      throw e
    }
  } else if (opts.interactive && isTTY()) {
    // The `< /dev/tty` handoff is what makes this reachable from `curl … | sh`: one paste
    // gets a configured Podium instead of an install followed by a second command.
    if (opts.vps) await runVpsSetup(io, port)
    else await runCliSetup(io, port)
  }

  // AFTER pairing, deliberately (install.sh:430-441). A one-use join code is short-lived, and
  // downloading three vendor CLIs onto a bare machine is slow enough to expire one. Pairing
  // first also lets the daemon copy credentials and publish inventory while these install.
  if (opts.agents.length > 0) {
    await (deps.installAgents ?? realInstallAgents)(io, opts.agents, opts.bin)
  }

  report(io, opts, { joined, persisted, supervision, pathOf: deps.pathOf })
}

/** The closing report. Everything an operator has to COPY goes through `command()` (R9). */
function report(
  io: SetupIO,
  opts: InstallFinishOptions,
  state: {
    joined: string | undefined
    persisted: boolean
    supervision: SupervisionProbe
    pathOf?: () => string
  },
): void {
  const hint = realPathHint(opts.bin, state.persisted, opts.command, state.pathOf?.())
  if (state.joined) {
    io.success('This machine has joined your Podium.')
    io.step(
      state.supervision.systemd
        ? 'The daemon runs as a systemd user service, so it survives reboots.'
        : 'The daemon is running detached.',
    )
    io.command(
      `${opts.command} status\n${opts.command} stop`,
      'What is running here, and how to stop it:',
    )
  } else {
    io.success('Podium is installed.')
    io.command(opts.command, 'Run this to configure this machine and open the web UI:')
  }
  // Last, because it is the one thing left for the operator to do in THIS shell.
  if (hint) {
    const exportIdx = hint.indexOf('export PATH=')
    if (exportIdx >= 0) io.command(hint.slice(exportIdx), hint.slice(0, exportIdx).trim())
    else io.warn(hint)
  }
  io.outro(state.joined ? 'Ready.' : 'Installed.')
}
