/**
 * THE TAILSCALE STEP OF `podium setup` (POD-3274).
 *
 * The flow used to print `tailscale funnel 18787` and ask for the URL it showed. That
 * command runs in the FOREGROUND — Podium went dark the moment the terminal closed — and it
 * answers "Logged out." on a box that is installed but not signed in. So this step reads
 * where Tailscale actually is on this machine and acts on that:
 *
 *  - not installed / not running / not signed in: box exactly the commands that are left,
 *    in order, and check again when the operator says so;
 *  - ready: turn on Funnel (public) or Serve (tailnet only) with `--bg`, which Tailscale
 *    keeps across reboots, and read the address from `tailscale status` — nothing to paste.
 *
 * WHO MAY CHANGE TAILSCALE'S CONFIG. tailscaled grants write access to root and to its one
 * configured OPERATOR (ipn/ipnserver `actor.Permissions`); anyone else gets "serve config
 * denied". Setting the operator REPLACES whoever it was, so this never does that over
 * someone else: it reads the current operator first and
 *  - runs the command itself when it is root or the operator;
 *  - offers `sudo tailscale set --operator=<user>` only when there is no operator at all;
 *  - otherwise leaves it alone and boxes the one `sudo` command for the operator to run.
 *
 * `tailscale set`, never `tailscale up --operator`: `up` resets every preference not
 * restated on its command line.
 */
import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { commandExists } from '@podium/runtime/setup'
import { isCancel, type SetupIO } from './setup-ui'

export type TailscaleExposure = 'funnel' | 'serve'

export type TailscaleState =
  | { kind: 'missing' }
  /** Installed, but tailscaled is not running. */
  | { kind: 'stopped' }
  /** tailscaled runs, but this machine is not signed in (or was taken down). */
  | { kind: 'signed-out' }
  | {
      kind: 'ready'
      /** This machine's MagicDNS name, without the trailing dot. */
      dnsName: string
      /** tailscaled's operator user; undefined when none is set or it cannot be read. */
      operator: string | undefined
    }

export interface TailscaleDeps {
  probe: () => TailscaleState
  /** Run a command with the terminal attached (sudo may ask for a password, and
   *  Tailscale may print a link to approve Funnel and wait). True on exit 0. */
  run: (command: string, args: string[]) => boolean
  /** Whether Tailscale's serve config now forwards to `port`. */
  forwards: (exposure: TailscaleExposure, port: number) => boolean
  user: () => string
  isRoot: () => boolean
}

export const TAILSCALE_INSTALL = 'curl -fsSL https://tailscale.com/install.sh | sh'
/** The official installer enables tailscaled but, measured on the lab, did not start it. */
export const TAILSCALE_START = 'sudo systemctl enable --now tailscaled'
export const TAILSCALE_SIGN_IN = 'sudo tailscale up'

function spawnText(command: string, args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 })
  return { ok: res.status === 0, stdout: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** Where Tailscale is on this machine, read from its own CLI. */
export function probeTailscale(): TailscaleState {
  if (!commandExists('tailscale')) return { kind: 'missing' }
  const status = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 10_000 })
  let parsed: { BackendState?: string; Self?: { DNSName?: string } }
  try {
    parsed = JSON.parse(status.stdout ?? '')
  } catch {
    // No JSON at all: the CLI could not reach tailscaled.
    return { kind: 'stopped' }
  }
  const dnsName = parsed.Self?.DNSName?.replace(/\.$/, '')
  if (parsed.BackendState !== 'Running' || !dnsName) return { kind: 'signed-out' }
  return { kind: 'ready', dnsName, operator: readOperator() }
}

/** `tailscale debug prefs` is readable without root and names the operator, when set. */
function readOperator(): string | undefined {
  const prefs = spawnText('tailscale', ['debug', 'prefs'])
  if (!prefs.ok) return undefined
  try {
    const operator = (JSON.parse(prefs.stdout) as { OperatorUser?: unknown }).OperatorUser
    return typeof operator === 'string' && operator !== '' ? operator : undefined
  } catch {
    return undefined
  }
}

export const realTailscaleDeps: TailscaleDeps = {
  probe: probeTailscale,
  run: (command, args) => spawnSync(command, args, { stdio: 'inherit' }).status === 0,
  forwards: (exposure, port) => {
    const status = spawnText('tailscale', [exposure, 'status', '--json'])
    return status.ok && status.stdout.includes(`:${port}`)
  },
  user: () => userInfo().username,
  isRoot: () => process.getuid?.() === 0,
}

/** The commands still to run before Tailscale is ready, in order. */
function remainingSteps(state: TailscaleState): string[] {
  switch (state.kind) {
    case 'missing':
      return [TAILSCALE_INSTALL, TAILSCALE_START, TAILSCALE_SIGN_IN]
    case 'stopped':
      return [TAILSCALE_START, TAILSCALE_SIGN_IN]
    case 'signed-out':
      return [TAILSCALE_SIGN_IN]
    case 'ready':
      return []
  }
}

const STATE_SENTENCE: Record<Exclude<TailscaleState['kind'], 'ready'>, string> = {
  missing: 'Tailscale is not installed on this machine.',
  stopped: 'Tailscale is installed, but its service (tailscaled) is not running.',
  'signed-out': 'Tailscale is running, but this machine is not signed in to a tailnet.',
}

/**
 * Bring Tailscale to ready, then expose `port` through it. Returns the https address, or
 * undefined when the operator gave up (nothing is saved by this step either way).
 */
export async function tailscaleStep(
  io: SetupIO,
  exposure: TailscaleExposure,
  port: number,
  deps: TailscaleDeps = realTailscaleDeps,
): Promise<string | undefined> {
  let state = deps.probe()
  while (state.kind !== 'ready') {
    io.warn(STATE_SENTENCE[state.kind])
    io.command(remainingSteps(state).join('\n'), 'Run these, then come back:')
    io.step('`sudo tailscale up` prints a link: open it to sign this machine in to your tailnet.')
    const again = await io.confirm({ message: 'Done — check again?', initialValue: true })
    if (isCancel(again) || !again) return undefined
    state = deps.probe()
  }

  const command = [exposure, '--bg', String(port)]
  const user = deps.user()
  const mayRunIt = deps.isRoot() || state.operator === user
  let done = false
  if (exposure === 'funnel') {
    io.step(
      'The first time, Tailscale asks you to approve Funnel for your tailnet: open the link it prints.',
    )
  }
  if (mayRunIt) {
    done = deps.run('tailscale', command)
  } else if (state.operator === undefined) {
    const allow = await io.confirm({
      message: `Let ${user} manage Tailscale's Serve and Funnel? (runs: sudo tailscale set --operator=${user})`,
      initialValue: true,
    })
    if (!isCancel(allow) && allow && deps.run('sudo', ['tailscale', 'set', `--operator=${user}`])) {
      done = deps.run('tailscale', command)
    }
  } else {
    io.step(`Tailscale's operator is ${state.operator}; setup leaves that as it is.`)
  }

  while (!done) {
    io.command(`sudo tailscale ${command.join(' ')}`, 'Run this, then come back:')
    const again = await io.confirm({ message: 'Done — check again?', initialValue: true })
    if (isCancel(again) || !again) return undefined
    done = deps.forwards(exposure, port)
    if (!done) io.warn(`Tailscale does not show ${exposure} forwarding to port ${port} yet.`)
  }

  const url = `https://${state.dnsName}`
  io.success(
    exposure === 'funnel'
      ? `Tailscale Funnel is on: ${url} (kept across reboots).`
      : `Tailscale Serve is on: ${url}, for devices on your tailnet (kept across reboots).`,
  )
  return url
}
