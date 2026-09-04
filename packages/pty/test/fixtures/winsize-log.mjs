// Logs its pty winsize once at startup and again on EVERY SIGWINCH, with a
// monotonic counter so a reader can tell "the app was signalled again" from
// "the same line arrived twice". Used by the abduco attach-boundary test
// (POD-3235 C14): the question is whether the agent is signalled on a
// same-size attach, which only the agent itself can answer.
const size = () => {
  // getWindowSize() is a live TIOCGWINSZ; process.stdout.columns is cached.
  const [cols, rows] = process.stdout.getWindowSize?.() ?? [0, 0]
  return `cols=${cols} rows=${rows}`
}
process.stdout.write(`WINSZ ${size()}\n`)
let n = 0
process.on('SIGWINCH', () => {
  n += 1
  process.stdout.write(`SIGWINCH#${n} ${size()}\n`)
})
setInterval(() => {}, 3600_000)
