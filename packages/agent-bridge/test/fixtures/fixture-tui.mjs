#!/usr/bin/env node
// Deterministic alt-screen TUI for agent-bridge Tier-0 tests.
// Prints its PTY geometry, a monotonically increasing paint counter, and the
// hex of the last input chunk. Repaints on SIGWINCH (stdout 'resize').
let paint = 0
let lastInput = ''

function render() {
  paint += 1
  const cols = process.stdout.columns ?? 0
  const rows = process.stdout.rows ?? 0
  process.stdout.write('\x1b[2J\x1b[H')
  process.stdout.write(`PODIUM-FIXTURE cols=${cols} rows=${rows} paint=${paint}\r\n`)
  process.stdout.write(`last-input=${lastInput}\r\n`)
}

process.stdout.write('\x1b[?1049h') // enter alt screen
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', (buf) => {
  lastInput = Buffer.from(buf).toString('hex')
  if (lastInput === '03') {
    process.stdout.write('\x1b[?1049l') // leave alt screen
    process.exit(0) // Ctrl-C exits cleanly
  }
  render()
})
process.stdout.on('resize', render)
render()
