// Logs its pty winsize once at startup and again on EVERY SIGWINCH, with a
// monotonic counter so a reader can tell "the app was signalled again" from
// "the same line arrived twice". Used by the host attach-boundary tests
// (POD-3235 C14): the question is whether the agent is signalled on a
// same-size attach, which only the agent itself can answer.
import { appendFileSync } from 'node:fs'

// WINSIZE_LOG, when set, receives every line too: a reader that attaches
// after the program already reported still sees everything it said
// (POD-4723).
const logPath = process.env.WINSIZE_LOG
const out = (line) => {
  process.stdout.write(line)
  if (logPath) appendFileSync(logPath, line)
}
const size = () => {
  // getWindowSize() is a live TIOCGWINSZ; process.stdout.columns is cached.
  const [cols, rows] = process.stdout.getWindowSize?.() ?? [0, 0]
  return `cols=${cols} rows=${rows}`
}
out(`WINSZ ${size()}\n`)
let n = 0
process.on('SIGWINCH', () => {
  n += 1
  out(`SIGWINCH#${n} ${size()}\n`)
})
setInterval(() => {}, 3600_000)
