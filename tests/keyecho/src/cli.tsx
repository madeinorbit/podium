import { render } from 'ink'
import { App } from './app.js'
import { parseArgs } from './args.js'

const RESTORE = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h'

function restore() {
  try {
    process.stdout.write(RESTORE)
  } catch {
    /* ignore */
  }
}

async function main() {
  if (!process.stdin.isTTY) {
    process.stderr.write('keyecho: stdin is not a TTY. Run it in a terminal or under a PTY.\n')
    process.exit(1)
  }
  const opts = parseArgs(process.argv.slice(2))
  process.on('exit', restore)
  process.on('SIGTERM', () => process.exit(0))
  const { waitUntilExit } = render(<App mode={opts.mode} lock={opts.lock} />, { exitOnCtrlC: false })
  await waitUntilExit()
  restore()
}

void main()
