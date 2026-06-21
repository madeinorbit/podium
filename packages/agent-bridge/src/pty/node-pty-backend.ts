import { createRequire } from 'node:module'
import type { PtyBackend, PtyProcess, PtySpawnOptions } from './types.js'

// Lazy require so importing this module under Bun never loads the native addon.
// node-pty is only needed when nodePtyBackend().spawn() actually runs.
const req = createRequire(import.meta.url)
let nodePty: typeof import('node-pty') | undefined
function loadNodePty(): typeof import('node-pty') {
  nodePty ??= req('node-pty') as typeof import('node-pty')
  return nodePty
}

export function nodePtyBackend(): PtyBackend {
  return {
    name: 'node-pty',
    spawn(opts: PtySpawnOptions): PtyProcess {
      const proc = loadNodePty().spawn(opts.file, opts.args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? (process.env as Record<string, string>),
        // encoding:null => onData delivers Buffers (bytes), not decoded strings.
        encoding: null as unknown as undefined,
      })
      return {
        get pid() {
          return proc.pid
        },
        onData(cb) {
          proc.onData((d: string | Buffer) =>
            cb(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)),
          )
        },
        onExit(cb) {
          proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) =>
            cb({ exitCode, signal }),
          )
        },
        write(data) {
          proc.write(Buffer.from(data))
        },
        resize(cols, rows) {
          proc.resize(cols, rows)
        },
        kill(signal) {
          proc.kill(signal)
        },
      }
    },
  }
}
