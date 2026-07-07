import type { PtyBackend, PtyProcess, PtySpawnOptions } from './types.js'

// All Bun.* access is inside functions so this module loads (but is never selected)
// under Node.
declare const Bun:
  | { spawn: (cmd: string[], opts: unknown) => BunPtyProc; version: string }
  | undefined

/** This Bun's version string, or '?' when not running under Bun. */
export function bunVersion(): string {
  return typeof Bun !== 'undefined' ? Bun.version : '?'
}

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

/** Running under Bun with a spawnable process API. Says nothing about the terminal
 *  PTY API — use {@link hasBunTerminal} for that. */
export function isUnderBun(): boolean {
  return typeof Bun !== 'undefined' && typeof Bun.spawn === 'function'
}

let bunTerminalProbe: boolean | undefined
/**
 * Feature-DETECT (not version-guess) whether this Bun's `Bun.spawn({terminal})` actually
 * yields a working PTY handle. A Bun predating the terminal API silently IGNORES the
 * option and returns a proc with NO `.terminal` — which used to surface much later as
 * `proc.terminal.resize is undefined` on the first abduco attach, i.e. black remote
 * terminals after a reconnect. Probing here lets callers fall back / fail loud up front
 * instead. Cached: spawns a throwaway `true` exactly once.
 */
export function hasBunTerminal(): boolean {
  if (bunTerminalProbe !== undefined) return bunTerminalProbe
  if (!isUnderBun()) {
    bunTerminalProbe = false
    return bunTerminalProbe
  }
  try {
    const p = (Bun as NonNullable<typeof Bun>).spawn(['true'], {
      terminal: { cols: 80, rows: 24, data() {} },
    }) as { terminal?: { resize?: unknown; close?: () => void }; kill?: () => void }
    bunTerminalProbe = !!p.terminal && typeof p.terminal.resize === 'function'
    try {
      p.terminal?.close?.()
    } catch {
      /* already gone */
    }
    try {
      p.kill?.()
    } catch {
      /* already gone */
    }
  } catch {
    bunTerminalProbe = false
  }
  return bunTerminalProbe
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
