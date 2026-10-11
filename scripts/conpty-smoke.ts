/**
 * Runtime PTY smoke for the bare (non-durable) pty layer — spawnAgent → bun-terminal
 * backend → ConPTY on Windows [spec:SP-7f2c]. Since POD-4617 no daemon runs a session
 * on this layer directly (a daemon with no podium-host refuses to spawn); it is what
 * a Windows podium-host would sit on, and this keeps it proven. Run: `bun --conditions=@podium/source scripts/conpty-smoke.ts`
 * (the condition resolves the @podium/* workspace imports straight to src).
 *
 * Proves, against a real interactive shell:
 *   1. spawn allocates a PTY and the shell produces output (prompt),
 *   2. write() round-trips: a command typed into the PTY executes and its RESULT
 *      (a computed number never present in the input) comes back out,
 *   3. resize() doesn't throw,
 *   4. `exit` terminates the session with code 0 and onExit fires.
 *
 * Cross-platform on purpose: the production Windows shell (PowerShell, else cmd.exe), sh -i
 * on POSIX — CI runs it on windows-latest as the ConPTY proof; POSIX runs keep the script
 * itself honest.
 */
import { agentLaunchCommand } from '../packages/harness/src/launch.js'
import { spawnAgent } from '../packages/pty/src/session.js'

const isWin = process.platform === 'win32'
// Windows resolves through the PRODUCTION shell-launch path (agentLaunchCommand →
// SHELL || PowerShell || COMSPEC) so the smoke green-lights the shell the daemon
// actually spawns. POSIX pins plain `sh -i` instead — that leg only keeps the
// script itself honest, and the user's login shell may not speak the probe syntax.
const { cmd: shell, args } = isWin
  ? agentLaunchCommand('shell', { cwd: process.cwd() })
  : { cmd: 'sh', args: ['-i'] }
// The command's OUTPUT (543656) never appears in what we type, so seeing it proves
// the shell executed the command — not merely that the PTY echoed our input.
// Each shell needs its own spelling: PowerShell prints a bare expression's value, cmd.exe
// only computes through `set /a`, and neither understands the other's.
function probeFor(shellPath: string): string {
  const name = shellPath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (name === 'pwsh.exe' || name === 'powershell.exe') return '271828*2\r'
  if (isWin) return 'set /a 271828*2\r'
  return 'echo $((271828*2))\r'
}
const probe = probeFor(shell)
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
const decoder = new TextDecoder()
session.onFrame((f) => {
  output += decoder.decode(f.data, { stream: true })
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

// Explicit `exit 0`: cmd.exe's bare `exit` semantics around a prior command's
// ERRORLEVEL are folklore-laden; pin the code so the assertion tests the PTY's
// exit plumbing, not cmd trivia. sh accepts the same spelling.
session.write(Buffer.from('exit 0\r').toString('base64'))
await waitFor('shell exited cleanly on `exit`', () => exited !== undefined)
if (exited && exited.code !== 0) fail(`exit code 0 (got ${exited.code})`, output)

console.log(`PASS: ConPTY/PTY smoke on ${process.platform} (${shell})`)
process.exit(0)
