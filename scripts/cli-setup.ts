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

export async function runCliSetup(io: SetupIO, port: number): Promise<void> {
  io.print('Make this instance reachable (encrypted, no domain needed):')
  NETWORK_OPTIONS.forEach((o, i) => {
    io.print(`  ${i + 1}) ${o.label} — ${o.note}`)
  })
  const choice = Number((await io.prompt('Choose 1-4: ')).trim()) || 1
  const opt = NETWORK_OPTIONS[Math.min(Math.max(choice, 1), NETWORK_OPTIONS.length) - 1]
  if (!opt) return
  const { command, hint } = networkOptionCommand(opt.id, port)
  if (command) io.print(`\nRun this, then come back:\n\n    ${command}\n`)
  io.print(hint)
  // loop until a valid URL is pasted
  for (;;) {
    const pasted = await io.prompt('\nPaste the resulting URL: ')
    const v = validatePublicUrl(pasted)
    if (v.ok) {
      applySetup({ publicUrl: v.normalized })
      io.print(`\nSaved. This instance is reachable at ${v.normalized}. Restart podium to apply.`)
      return
    }
    io.print(`  ${v.error}`)
  }
}
