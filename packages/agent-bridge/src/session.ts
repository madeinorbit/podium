import type { Geometry } from '@podium/protocol'
import { type IPty, spawn } from 'node-pty'

export interface SpawnOptions {
  cmd: string
  args?: string[]
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
}

export interface AgentFrame {
  seq: number
  /** base64 of raw PTY output bytes */
  data: string
}

export interface AgentSession {
  readonly pid: number
  onFrame(cb: (frame: AgentFrame) => void): () => void
  onExit(cb: (code: number) => void): () => void
  /** base64 of input bytes to inject into the PTY */
  write(dataBase64: string): void
  resize(cols: number, rows: number): void
  /** Force a real repaint even when geometry is unchanged. */
  redraw(): void
  geometry(): Geometry
  dispose(): void
}

export function spawnAgent(opts: SpawnOptions): AgentSession {
  let cols = opts.cols
  let rows = opts.rows
  let seq = 0
  let disposed = false
  const frameCbs = new Set<(f: AgentFrame) => void>()
  const exitCbs = new Set<(code: number) => void>()

  const proc: IPty = spawn(opts.cmd, opts.args ?? [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env } as Record<string, string>,
  })

  proc.onData((data: string) => {
    const frame: AgentFrame = { seq, data: Buffer.from(data, 'utf8').toString('base64') }
    seq += 1
    for (const cb of frameCbs) cb(frame)
  })

  proc.onExit(({ exitCode }) => {
    for (const cb of exitCbs) cb(exitCode)
  })

  return {
    get pid() {
      return proc.pid
    },
    onFrame(cb) {
      frameCbs.add(cb)
      return () => frameCbs.delete(cb)
    },
    onExit(cb) {
      exitCbs.add(cb)
      return () => exitCbs.delete(cb)
    },
    write(dataBase64) {
      if (disposed) return
      proc.write(Buffer.from(dataBase64, 'base64'))
    },
    resize(c, r) {
      if (disposed) return
      cols = c
      rows = r
      proc.resize(c, r)
    },
    redraw() {
      throw new Error('not implemented')
    },
    geometry() {
      return { cols, rows }
    },
    dispose() {
      if (disposed) return
      disposed = true
      frameCbs.clear()
      exitCbs.clear()
      try {
        proc.kill()
      } catch {
        // process already exited
      }
    },
  }
}
