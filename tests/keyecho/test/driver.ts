import { fileURLToPath } from 'node:url'
import { bunTerminalBackend, spawnAgent } from '@podium/pty'

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
  const session = spawnAgent(
    {
      cmd: process.execPath,
      args: [CLI, ...args],
      cols: 100,
      rows: 30,
      cwd: PKG_DIR,
      env: process.env as Record<string, string>,
    },
    bunTerminalBackend(),
  )
  let raw = ''
  session.onFrame((frame) => {
    raw += Buffer.from(frame.data, 'base64').toString('utf8')
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
