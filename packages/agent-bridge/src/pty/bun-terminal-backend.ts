import type { PtyBackend, PtyProcess, PtySpawnOptions } from './types.js'

// All Bun.* access is inside functions so this module loads (but is never selected)
// under Node.
declare const Bun: { spawn: (cmd: string[], opts: unknown) => BunPtyProc } | undefined

interface BunPtyProc {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | null
  kill(signal?: number | string): void
  terminal: {
    write(d: string | Uint8Array): void
    resize(c: number, r: number): void
    close(): void
  }
}

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
}

export function hasBunTerminal(): boolean {
  return typeof Bun !== 'undefined' && typeof Bun.spawn === 'function'
}

export function bunTerminalBackend(): PtyBackend {
  return {
    name: 'bun-terminal',
    spawn(opts: PtySpawnOptions): PtyProcess {
      if (typeof Bun === 'undefined')
        throw new Error('bun-terminal backend requires running under Bun')
      let onData: ((b: Uint8Array) => void) | undefined
      let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined
      const env = { ...(opts.env ?? (process.env as Record<string, string>)) }
      if (!env.TERM) env.TERM = 'xterm-256color'
      const proc = Bun.spawn([opts.file, ...opts.args], {
        cwd: opts.cwd ?? process.cwd(),
        env,
        terminal: {
          cols: opts.cols,
          rows: opts.rows,
          data(_t: unknown, bytes: Uint8Array) {
            onData?.(bytes)
          },
        },
      })
      void proc.exited.then(() => {
        onExit?.({
          exitCode: proc.exitCode ?? 0,
          signal: proc.signalCode ? SIGNALS[proc.signalCode] : undefined,
        })
      })
      return {
        get pid() {
          return proc.pid
        },
        onData(cb) {
          onData = cb
        },
        onExit(cb) {
          onExit = cb
        },
        write(data) {
          proc.terminal.write(data)
        },
        resize(cols, rows) {
          proc.terminal.resize(cols, rows)
        },
        kill(signal) {
          try {
            proc.kill(signal ? (SIGNALS[signal] ?? signal) : undefined)
          } catch {
            /* already gone */
          }
          try {
            proc.terminal.close()
          } catch {
            /* already gone */
          }
        },
      }
    },
  }
}
