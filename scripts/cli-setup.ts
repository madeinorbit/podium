import { setPassword as realSetPassword } from '../apps/server/src/auth-store'
import { loadConfig } from '../packages/core/src/config'
import {
  applySetup,
  NETWORK_OPTIONS,
  networkOptionCommand,
  validatePublicUrl,
} from '../packages/core/src/setup'

export interface SetupIO {
  prompt(q: string): Promise<string>
  print(s: string): void
}

export interface SetupDeps {
  /** Injected for testing; defaults to the real scrypt-backed password store. */
  setPassword?: (password: string) => Promise<void>
}

/** Reachability step: pick how to expose the relay, run the command, paste the URL.
 *  Returns true once a valid URL was saved. */
async function reachabilityStep(io: SetupIO, port: number): Promise<boolean> {
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
      applySetup({ publicUrl: v.normalized })
      io.print(`\nSaved. This instance is reachable at ${v.normalized}. Restart podium to apply.`)
      return true
    }
    io.print(`  ${v.error}`)
  }
  io.print('\nNo valid URL after several attempts — giving up. Re-run `podium setup` when ready.')
  return false
}

/** Password step: a reachable instance should require login, so strongly encourage a
 *  password. Blank = run open (printed plainly so the choice is never silent). */
async function passwordStep(
  io: SetupIO,
  setPassword: (password: string) => Promise<void>,
): Promise<void> {
  io.print('\nSet a password to require login (recommended for a public URL).')
  const pw = ((await io.prompt('Password (leave blank to run open): ')) ?? '').trim()
  if (pw) {
    await setPassword(pw)
    io.print('Password set — devices must log in to use this instance.')
  } else {
    io.print('No password set — anyone who can reach this URL can use this instance.')
  }
}

export async function runCliSetup(io: SetupIO, port: number, deps: SetupDeps = {}): Promise<void> {
  const setPassword = deps.setPassword ?? realSetPassword

  // Already set up once → don't re-walk the whole flow; jump straight to the step the
  // user wants to change. First run falls through to the full walk below.
  if (loadConfig().publicUrl) {
    io.print('Setup is already configured. What do you want to change?')
    io.print('  1) Reachability / public URL')
    io.print('  2) Login password')
    const choice = ((await io.prompt('Choose 1-2 (blank to cancel): ')) ?? '').trim()
    if (choice === '1') await reachabilityStep(io, port)
    else if (choice === '2') await passwordStep(io, setPassword)
    else io.print('Nothing changed.')
    return
  }

  // First run: reachability, then (only if that succeeded) the password.
  if (await reachabilityStep(io, port)) await passwordStep(io, setPassword)
}
