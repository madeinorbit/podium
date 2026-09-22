import { fileURLToPath } from 'node:url'
import { bunTerminalBackend } from '@podium/process/pty'
import { wrapPty } from '@podium/process/screen'

const CLI = fileURLToPath(new URL('../src/cli.tsx', import.meta.url))
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url))

// Strip ANSI so we can search the rendered text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: needed to strip ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

export interface Keyecho {
  send(bytes: string): void
  text(): string
  waitFor(pred: (text: string) => boolean, timeoutMs?: number): Promise<void>
  dispose(): void
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

export function bootKeyecho(args: string[] = []): Keyecho {
  // A bare pty on purpose: keyecho is a TUI fixture, not a session, so nothing
  // here goes through a durable host (the screen door exports no spawn).
  const session = wrapPty(
    bunTerminalBackend().spawn({
      file: process.execPath,
      args: [CLI, ...args],
      cols: 100,
      rows: 30,
      cwd: PKG_DIR,
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    }),
    { cols: 100, rows: 30 },
  )
  let raw = ''
  const decoder = new TextDecoder()
  session.onFrame((frame) => {
    raw += decoder.decode(frame.data, { stream: true })
  })
  const text = () => raw.replace(ANSI, '')
  return {
    send: (bytes) => session.write(Buffer.from(bytes, 'latin1').toString('base64')),
    text,
    waitFor: (pred, timeoutMs = 4000) =>
      new Promise<void>((resolve, reject) => {
        const started = nowMs()
        const tick = () => {
          if (pred(text())) return resolve()
          if (nowMs() - started > timeoutMs)
            return reject(new Error(`timeout; last text:\n${text().slice(-600)}`))
          setTimeout(tick, 30)
        }
        tick()
      }),
    dispose: () => {
      try {
        session.dispose()
      } catch {
        /* ignore */
      }
    },
  }
}
