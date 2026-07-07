import { renameSync } from 'node:fs'
import { setPassword as realSetPassword } from '../apps/server/src/auth-store'
import { configPath, inspectConfig, loadConfig, saveConfig } from '../packages/core/src/config'
import {
  ephemeralTunnelWarning,
  NETWORK_OPTIONS,
  networkOptionCommand,
  validatePublicUrl,
} from '../packages/core/src/setup'
import { applyJoinToken } from './cli-join'

export interface SetupIO {
  prompt(q: string): Promise<string>
  print(s: string): void
}

export interface StartBackendOpts {
  persistence: 'systemd' | 'detached'
  /** 'daemon' = a joined worker (start just the daemon); host modes start the split. */
  mode: HostMode | 'daemon'
  port: number
}
export interface StartBackendResult {
  /** What actually got set up (systemd install can fall back to detached). */
  effectivePersistence: 'systemd' | 'detached'
  message: string
}

export interface SetupDeps {
  /** Injected for testing; defaults to the real scrypt-backed password store. */
  setPassword?: (password: string) => Promise<void>
  /** Injected for testing; defaults to real systemd-install / detached-spawn. */
  startBackend?: (opts: StartBackendOpts) => Promise<StartBackendResult>
}

/** Default backend starter: systemd install (with detached fallback) or a detached spawn. Works
 *  for host modes (start the server + daemon split) AND a joined worker (start just the daemon).
 *  Exported as THE one start-backend engine (issue #20) — interactive setup, the
 *  non-interactive `podium setup --join`, and the pending-persistence reconcile all share it. */
export async function startBackendEngine(opts: StartBackendOpts): Promise<StartBackendResult> {
  const { persistence, mode, port } = opts
  const { startDetachedStack } = await import('./cli-spawn')
  // Tear down any previously-running backend first, so switching modes (or reconfiguring) never
  // leaves the old server/daemon running alongside the new one. No-op on a fresh box.
  const { stopBackend } = await import('./cli-lifecycle')
  await stopBackend()
  const what = mode === 'daemon' ? 'daemon' : 'server + daemon'
  if (persistence === 'systemd') {
    const { installSystemd } = await import('./cli-systemd')
    const res = installSystemd(mode, port)
    if (res.ok)
      return {
        effectivePersistence: 'systemd',
        message: `Installed + started the ${what} as a systemd service — survives reboot.`,
      }
    const { serverUp } = await startDetachedStack(mode, port)
    return {
      effectivePersistence: 'detached',
      message: `systemd unavailable (${res.reason}); started the ${what} detached — runs until reboot.${
        serverUp ? '' : ' (did not come up — check ~/.podium/logs/)'
      }`,
    }
  }
  const { serverUp } = await startDetachedStack(mode, port)
  return {
    effectivePersistence: 'detached',
    message: serverUp
      ? `Started the ${what} (detached) — runs until reboot. Use \`podium status\` / \`podium stop\` to manage.`
      : 'Did not come up — check ~/.podium/logs/.',
  }
}

/**
 * Whether `podium setup` / `--reconfigure` should launch the interactive terminal flow.
 * It's THE interactive command (nothing invokes it headless), so the only guard is a TTY:
 * without a terminal the prompts would hang, so we fall through to serving the web UI. The
 * menu lets you switch into ANY mode, so it's offered regardless of the current mode.
 */
export function shouldRunCliSetup(opts: {
  forceSetup: boolean
  firstRunNeedsSetup: boolean
  isTTY: boolean
}): boolean {
  // Interactive only (a TTY): headless/systemd/piped runs must never block on a prompt —
  // they fall through to serving the web setup URL. On a TTY we enter the terminal flow both
  // when explicitly asked (`podium setup` / --reconfigure) AND on a bare `podium` against an
  // unconfigured box (firstRunNeedsSetup), so a fresh install walks straight into setup rather
  // than silently starting all-in-one.
  return (opts.forceSetup || opts.firstRunNeedsSetup) && opts.isTTY
}

type HostMode = 'all-in-one' | 'server'

/**
 * Reachability step: pick how to expose the relay, run the command, paste the URL. Returns
 * the validated URL, or undefined when the operator gave up. With `save` (the standalone
 * "change the URL" menu edit on an already-configured box) it persists immediately; the
 * full host flow passes save:false and writes config ONCE at the end — so a Ctrl-C midway
 * can't leave a configured-looking-but-passwordless box (issue #21).
 */
async function reachabilityStep(
  io: SetupIO,
  port: number,
  mode: HostMode,
  opts: { save: boolean } = { save: true },
): Promise<string | undefined> {
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
      if (opts.save) {
        saveConfig({ ...loadConfig(), mode, publicUrl: v.normalized })
        io.print(`\nSaved. This instance is reachable at ${v.normalized}. Restart podium to apply.`)
      } else {
        io.print(`\nThis instance will be reachable at ${v.normalized}.`)
      }
      const warning = ephemeralTunnelWarning(v.normalized)
      if (warning) io.print(`\nWarning: ${warning}`)
      return v.normalized
    }
    io.print(`  ${v.error}`)
  }
  io.print('\nNo valid URL after several attempts — giving up. Re-run `podium setup` when ready.')
  return undefined
}

/**
 * Password step: a reachable instance should require login, so strongly encourage a
 * password. Blank = run open only after an explicit confirmation word — the CLI's
 * equivalent of the web flow's `acknowledgeNoPassword`. Returns false when neither a
 * password nor the explicit no-password ack was given, so the host flow ABORTS instead
 * of quietly configuring an open box (issue #21).
 */
async function passwordStep(
  io: SetupIO,
  setPassword: (password: string) => Promise<void>,
): Promise<boolean> {
  io.print('\nSet a password to require login (recommended for a public URL).')
  const MAX_ATTEMPTS = 5
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pw = (
      (await io.prompt('Password (recommended; blank starts no-password confirmation): ')) ?? ''
    ).trim()
    if (pw) {
      await setPassword(pw)
      io.print('Password set — devices must log in to use this instance.')
      return true
    }
    io.print('No password means anyone who can reach this URL can use this instance.')
    const confirm = ((await io.prompt('Type "open" to run without a password: ')) ?? '')
      .trim()
      .toLowerCase()
    if (confirm === 'open') {
      io.print('No password set — anyone who can reach this URL can use this instance.')
      return true
    }
    io.print('No-password mode was not confirmed.')
  }
  io.print('No password chosen and no-password mode not confirmed.')
  return false
}

/**
 * Persistence step: after the host is configured, ask whether to survive reboot (systemd) or
 * run detached, then actually start the backend (server + daemon as two processes) and record
 * the effective persistence in config.
 */
async function persistenceStep(
  io: SetupIO,
  port: number,
  mode: HostMode | 'daemon',
  startBackend: (opts: StartBackendOpts) => Promise<StartBackendResult>,
): Promise<void> {
  const ans = (
    (await io.prompt('\nKeep Podium running as a systemd service (survives reboot)? [Y/n]: ')) ?? ''
  )
    .trim()
    .toLowerCase()
  const wantSystemd = ans === '' || ans === 'y' || ans === 'yes'
  const res = await startBackend({ persistence: wantSystemd ? 'systemd' : 'detached', mode, port })
  savePersistence(res.effectivePersistence)
  io.print(res.message)
}

/** Record the EFFECTIVE persistence and clear any recorded intent — it's fulfilled now. */
function savePersistence(persistence: 'systemd' | 'detached'): void {
  const { pendingPersistence: _fulfilled, ...rest } = loadConfig()
  saveConfig({ ...rest, persistence })
}

/**
 * Non-interactive join (issue #20): `podium setup --join <token> --persist systemd|detached`.
 * Applies the join token (PATCHING config — updateChannel etc. survive) and starts/persists
 * the daemon through the SAME engine the interactive flow uses. `install.sh --join` delegates
 * here instead of hand-writing a drifting unit file.
 */
export async function runJoinSetup(
  token: string,
  persistence: 'systemd' | 'detached',
  port: number,
  deps: SetupDeps = {},
): Promise<{ name: string; warning?: string; result: StartBackendResult }> {
  const startBackend = deps.startBackend ?? startBackendEngine
  const { name, warning } = applyJoinToken(token)
  const result = await startBackend({ persistence, mode: 'daemon', port })
  savePersistence(result.effectivePersistence)
  return { name, ...(warning ? { warning } : {}), result }
}

/**
 * Reconcile a recorded-but-unfulfilled persistence intent (issue #20): the web setup
 * (`setup.complete` / `setup.join`) cannot start or persist the backend from inside the
 * serving process, so it records `pendingPersistence`; the next `podium` invocation lands
 * here, starts the backend under that persistence (non-interactive — safe headless), and
 * records the effective result. Returns undefined when there is nothing to reconcile.
 */
export async function reconcilePendingPersistence(
  port: number,
  deps: SetupDeps = {},
): Promise<StartBackendResult | undefined> {
  const config = loadConfig()
  const pending = config.pendingPersistence
  if (!pending || config.persistence) return undefined
  const mode = config.mode
  if (mode !== 'all-in-one' && mode !== 'server' && mode !== 'daemon') return undefined
  const startBackend = deps.startBackend ?? startBackendEngine
  const result = await startBackend({ persistence: pending, mode, port })
  savePersistence(result.effectivePersistence)
  return result
}

/**
 * Choose a host mode → collect its URL, then its password, and only THEN write config —
 * atomically at the end of the decision flow (issue #21). A Ctrl-C/EOF before the password
 * choice leaves the box exactly as unconfigured as before, instead of a saved mode+URL
 * with no password (which looked configured AND was open to anyone who could reach it).
 */
async function hostStep(
  io: SetupIO,
  port: number,
  mode: HostMode,
  setPassword: (password: string) => Promise<void>,
  startBackend: (opts: StartBackendOpts) => Promise<StartBackendResult>,
): Promise<void> {
  const publicUrl = await reachabilityStep(io, port, mode, { save: false })
  if (!publicUrl) return
  if (!(await passwordStep(io, setPassword))) {
    io.print('Nothing saved — re-run `podium setup` to start over.')
    return
  }
  saveConfig({ ...loadConfig(), mode, publicUrl })
  io.print(`\nSaved. This instance is reachable at ${publicUrl}.`)
  await persistenceStep(io, port, mode, startBackend)
}

/** Daemon mode: paste the one-line join code (it carries the server URL + pairing code), then
 *  start the daemon (persistence choice) — same as the host path, so the user never has to
 *  manually restart. */
async function joinStep(
  io: SetupIO,
  port: number,
  startBackend: (opts: StartBackendOpts) => Promise<StartBackendResult>,
): Promise<void> {
  io.print('\nPaste the join code from the server (its Machines → Add machine screen).')
  const MAX_ATTEMPTS = 5
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = ((await io.prompt('Join code (blank to cancel): ')) ?? '').trim()
    if (!token) {
      io.print('Cancelled.')
      return
    }
    try {
      const { name, warning } = applyJoinToken(token)
      io.print(`\nJoined as "${name}".`)
      if (warning) io.print(`\nWarning: ${warning}`)
      await persistenceStep(io, port, 'daemon', startBackend)
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
/**
 * `podium setup --repair` (issue #21): an existing-but-invalid config.json is backed up
 * (never deleted) so setup can start fresh without silently destroying operator state.
 * Valid or missing configs are left untouched.
 */
export function repairConfig(): {
  state: 'ok' | 'missing' | 'repaired'
  backupPath?: string
  error?: string
} {
  const res = inspectConfig()
  if (res.state === 'ok') return { state: 'ok' }
  if (res.state === 'missing') return { state: 'missing' }
  const backupPath = `${configPath()}.invalid-${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSync(configPath(), backupPath)
  return { state: 'repaired', backupPath, ...(res.error ? { error: res.error } : {}) }
}

export async function runCliSetup(io: SetupIO, port: number, deps: SetupDeps = {}): Promise<void> {
  // A corrupt config would make every apply step throw mid-flow (they refuse destructive
  // writes over an existing-but-invalid file, #21) — surface the repair path up front.
  const inspection = inspectConfig()
  if (inspection.state === 'corrupt') {
    io.print(`Your config file (${configPath()}) exists but is invalid: ${inspection.error}`)
    io.print('Refusing to set up over it. Fix the file, or run `podium setup --repair` to')
    io.print('back it up and start fresh.')
    return
  }
  const setPassword = deps.setPassword ?? realSetPassword
  const startBackend = deps.startBackend ?? startBackendEngine
  const mode = loadConfig().mode
  const hostsServer = mode === 'all-in-one' || mode === 'server'

  io.print('What do you want this machine to do?')
  io.print('')
  io.print('  1) Run Podium on this machine')
  io.print('       The app AND your agents run right here. Best if this is your only computer.')
  io.print('  2) Set up a hub for your other machines')
  io.print('       This box hosts the app; your agents run on the machines that connect to it,')
  io.print('       not here. Best for an always-on server or VPS.')
  io.print('  3) Add this machine to a Podium you already run')
  io.print('       It runs agents here and connects to your existing server. Paste its join code.')
  if (hostsServer) {
    io.print('  4) Change how this machine is reached (its URL)')
    io.print('  5) Change or remove the login password')
  }
  const choice = ((await io.prompt('Choose (blank to cancel): ')) ?? '').trim()

  if (choice === '1') {
    await hostStep(io, port, 'all-in-one', setPassword, startBackend)
  } else if (choice === '2') {
    await hostStep(io, port, 'server', setPassword, startBackend)
  } else if (choice === '3') {
    await joinStep(io, port, startBackend)
  } else if (choice === '4' && hostsServer) {
    await reachabilityStep(io, port, mode === 'server' ? 'server' : 'all-in-one')
  } else if (choice === '5' && hostsServer) {
    await passwordStep(io, setPassword)
  } else {
    io.print('Nothing changed.')
  }
}
