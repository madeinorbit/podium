import { setPassword as realSetPassword } from '../apps/server/src/auth-store'
import { loadConfig, saveConfig } from '../packages/core/src/config'
import {
  NETWORK_OPTIONS,
  networkOptionCommand,
  validatePublicUrl,
} from '../packages/core/src/setup'
import { applyJoinToken } from './cli-join'

export interface SetupIO {
  prompt(q: string): Promise<string>
  print(s: string): void
}

export interface SetupDeps {
  /** Injected for testing; defaults to the real scrypt-backed password store. */
  setPassword?: (password: string) => Promise<void>
}

/**
 * Whether `podium setup` / `--reconfigure` should launch the interactive terminal flow.
 * It's THE interactive command (nothing invokes it headless), so the only guard is a TTY:
 * without a terminal the prompts would hang, so we fall through to serving the web UI. The
 * menu lets you switch into ANY mode, so it's offered regardless of the current mode.
 */
export function shouldRunCliSetup(opts: { forceSetup: boolean; isTTY: boolean }): boolean {
  return opts.forceSetup && opts.isTTY
}

type HostMode = 'all-in-one' | 'server'

/** Reachability step: pick how to expose the relay, run the command, paste the URL; save it
 *  under the chosen host mode. Returns true once a valid URL was saved. */
async function reachabilityStep(io: SetupIO, port: number, mode: HostMode): Promise<boolean> {
  io.print('Make this instance reachable (encrypted, no domain needed):')
  NETWORK_OPTIONS.forEach((o, i) => {
    io.print(`  ${i + 1}) ${o.label} — ${o.note}`)
  })
  const choice = Number((await io.prompt('Choose 1-4: ')).trim()) || 1
  const opt = NETWORK_OPTIONS[Math.min(Math.max(choice, 1), NETWORK_OPTIONS.length) - 1]
  if (!opt) return false
  const { command, hint } = networkOptionCommand(opt.id, port)
  if (command) io.print(`\nRun this, then come back:\n\n    ${command}\n`)
  io.print(hint)
  // loop until a valid URL is pasted, but give up after a bounded number of attempts
  // (else stdin EOF/Ctrl-D makes `prompt` resolve '' forever → infinite spin).
  const MAX_ATTEMPTS = 10
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pasted = await io.prompt('\nPaste the resulting URL: ')
    const v = validatePublicUrl(pasted)
    if (v.ok) {
      saveConfig({ ...loadConfig(), mode, publicUrl: v.normalized })
      io.print(`\nSaved. This instance is reachable at ${v.normalized}. Restart podium to apply.`)
      return true
    }
    io.print(`  ${v.error}`)
  }
  io.print('\nNo valid URL after several attempts — giving up. Re-run `podium setup` when ready.')
  return false
}

/** Password step: a reachable instance should require login, so strongly encourage a
 *  password. Blank = run open only after an explicit confirmation word. */
async function passwordStep(
  io: SetupIO,
  setPassword: (password: string) => Promise<void>,
): Promise<void> {
  io.print('\nSet a password to require login (recommended for a public URL).')
  const MAX_ATTEMPTS = 5
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pw = (
      (await io.prompt('Password (recommended; blank starts no-password confirmation): ')) ?? ''
    ).trim()
    if (pw) {
      await setPassword(pw)
      io.print('Password set — devices must log in to use this instance.')
      return
    }
    io.print('No password means anyone who can reach this URL can use this instance.')
    const confirm = ((await io.prompt('Type "open" to run without a password: ')) ?? '')
      .trim()
      .toLowerCase()
    if (confirm === 'open') {
      io.print('No password set — anyone who can reach this URL can use this instance.')
      return
    }
    io.print('No-password mode was not confirmed.')
  }
  io.print('No password set. Re-run `podium setup` when ready.')
}

/** Choose a host mode → set its URL, then its password. */
async function hostStep(
  io: SetupIO,
  port: number,
  mode: HostMode,
  setPassword: (password: string) => Promise<void>,
): Promise<void> {
  if (await reachabilityStep(io, port, mode)) await passwordStep(io, setPassword)
}

/** Daemon mode: paste the one-line join code (it carries the server URL + pairing code). */
async function joinStep(io: SetupIO): Promise<void> {
  io.print('\nPaste the join code from the server (its Machines → Add machine screen).')
  const MAX_ATTEMPTS = 5
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = ((await io.prompt('Join code (blank to cancel): ')) ?? '').trim()
    if (!token) {
      io.print('Cancelled.')
      return
    }
    try {
      const { name } = applyJoinToken(token)
      io.print(`\nJoined as "${name}". Restart podium to apply.`)
      return
    } catch (e) {
      io.print(`  ${(e as Error).message}`)
    }
  }
  io.print('\nNo valid join code after several attempts — giving up.')
}

/**
 * `podium setup` — the terminal counterpart to the web setup screen. A mode-first menu:
 * host a server here (all-in-one), host the relay only (server), or join a server as a
 * worker (daemon, paste a join code). It runs the same first-run and as a reconfigure, so
 * you can switch mode after the fact; when this box already hosts a server it also offers
 * quick edits (change the URL / change the password) without re-walking the whole flow.
 * (`client` mode isn't here — it's a desktop-app convenience; on a server box you just
 * open the URL in a browser.)
 */
export async function runCliSetup(io: SetupIO, port: number, deps: SetupDeps = {}): Promise<void> {
  const setPassword = deps.setPassword ?? realSetPassword
  const mode = loadConfig().mode
  const hostsServer = mode === 'all-in-one' || mode === 'server'

  io.print('What should this machine do?')
  io.print('  1) Host a server here (all-in-one)')
  io.print('  2) Host the relay only (server)')
  io.print('  3) Join a server as a worker (daemon) — paste a join code')
  if (hostsServer) {
    io.print('  4) Change the reachable URL')
    io.print('  5) Change or disable the login password')
  }
  const choice = ((await io.prompt('Choose (blank to cancel): ')) ?? '').trim()

  if (choice === '1') {
    await hostStep(io, port, 'all-in-one', setPassword)
  } else if (choice === '2') {
    await hostStep(io, port, 'server', setPassword)
  } else if (choice === '3') {
    await joinStep(io)
  } else if (choice === '4' && hostsServer) {
    await reachabilityStep(io, port, mode === 'server' ? 'server' : 'all-in-one')
  } else if (choice === '5' && hostsServer) {
    await passwordStep(io, setPassword)
  } else {
    io.print('Nothing changed.')
  }
}
