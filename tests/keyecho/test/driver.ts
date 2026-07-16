import { fileURLToPath } from 'node:url'
import { ensureBunNodePtyTtyPolyfill, resolveNodeExecutable } from '@podium/agent-bridge'
import * as pty from 'node-pty'

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
  // node-pty under Bun needs the tty.ReadStream polyfill (oven-sh/bun#25822).
  ensureBunNodePtyTtyPolyfill()
  // Real Node absolute path — Bun prepends a `node`→bunx shim on PATH under `bun --bun`.
  const proc = pty.spawn(resolveNodeExecutable(), ['--import', 'tsx', CLI, ...args], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: PKG_DIR,
    env: process.env as Record<string, string>,
  })
  let raw = ''
  proc.onData((d) => {
    raw += d
  })
  const text = () => raw.replace(ANSI, '')
  return {
    send: (bytes) => proc.write(bytes),
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
        proc.kill()
      } catch {
        /* ignore */
      }
    },
  }
}
