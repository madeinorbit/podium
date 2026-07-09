/**
 * Runtime PTY smoke for the bare (non-abduco) session path — the exact path Windows
 * uses in production (durable backend 'none' → spawnAgent → bun-terminal backend →
 * ConPTY [spec:SP-7f2c]). Run under Bun: `bun scripts/conpty-smoke.ts`.
 *
 * Proves, against a real interactive shell:
 *   1. spawn allocates a PTY and the shell produces output (prompt),
 *   2. write() round-trips: a command typed into the PTY executes and its RESULT
 *      (a computed number never present in the input) comes back out,
 *   3. resize() doesn't throw,
 *   4. `exit` terminates the session with code 0 and onExit fires.
 *
 * Cross-platform on purpose: cmd.exe on Windows, sh -i on POSIX — CI runs it on
 * windows-latest as the ConPTY proof; POSIX runs keep the script itself honest.
 */
import { spawnAgent } from '../packages/agent-bridge/src/session.js'

const isWin = process.platform === 'win32'
const shell = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : 'sh'
const args = isWin ? [] : ['-i']
// The command's OUTPUT (543656) never appears in what we type, so seeing it proves
// the shell executed the command — not merely that the PTY echoed our input.
const probe = isWin ? 'set /a 271828*2\r' : 'echo $((271828*2))\r'
const expected = '543656'

const STEP_TIMEOUT_MS = 30_000

function fail(step: string, output: string): never {
  console.error(`FAIL at step: ${step}`)
  console.error(`--- captured PTY output (${output.length} chars) ---`)
  console.error(JSON.stringify(output))
  process.exit(1)
}

let output = ''
let exited: { code: number } | undefined
const session = spawnAgent({ cmd: shell, args, cols: 80, rows: 24 })
session.onFrame((f) => {
  output += Buffer.from(f.data, 'base64').toString('utf8')
})
session.onExit((code) => {
  exited = { code }
})

async function waitFor(step: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (!done()) {
    if (Date.now() > deadline) fail(step, output)
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`ok: ${step}`)
}

await waitFor('shell produced output (PTY read path)', () => output.length > 0)

session.write(Buffer.from(probe).toString('base64'))
await waitFor('probe command executed (PTY write→exec→read round-trip)', () =>
  output.includes(expected),
)

session.resize(100, 30)
console.log('ok: resize accepted')

session.write(Buffer.from('exit\r').toString('base64'))
await waitFor('shell exited cleanly on `exit`', () => exited !== undefined)
if (exited && exited.code !== 0) fail(`exit code 0 (got ${exited?.code})`, output)

console.log(`PASS: ConPTY/PTY smoke on ${process.platform} (${shell})`)
process.exit(0)
