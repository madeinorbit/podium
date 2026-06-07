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
  let cancelNudge: (() => void) | undefined
  const frameCbs = new Set<(f: AgentFrame) => void>()
  const exitCbs = new Set<(code: number) => void>()

  const proc: IPty = spawn(opts.cmd, opts.args ?? [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd ?? process.cwd(),
    // The frontend is xterm.js, which renders 24-bit color. `name` pins
    // TERM=xterm-256color (node-pty writes it into the child env); COLORTERM is the
    // companion signal supports-color/chalk read to unlock truecolor. Without it agents
    // like Claude Code degrade to a 256-color approximation of their real palette. We
    // assert it after process.env (the frontend's capability doesn't depend on how the
    // daemon was launched) but before opts.env so callers/tests can still override.
    env: { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })

  proc.onData((data: string) => {
    const frame: AgentFrame = { seq, data: Buffer.from(data, 'utf8').toString('base64') }
    seq += 1
    for (const cb of [...frameCbs]) cb(frame)
  })

  proc.onExit(({ exitCode }) => {
    for (const cb of [...exitCbs]) cb(exitCode)
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
      if (disposed) return
      if (rows <= 1) {
        proc.write('\x0c') // Ctrl-L fallback when a one-row nudge is impossible
        return
      }
      cancelNudge?.() // drop any in-flight nudge
      // Shrink one row, then restore — but only AFTER the child emits a frame in
      // response to the shrink. A timer-based restore races the child's scheduling:
      // under load both resizes can land before the child reads the intermediate
      // size, so the net size is unchanged and Node suppresses the 'resize' event
      // (tty._refreshSize only fires on a real dimension change) — no repaint.
      // Acking on the next frame guarantees the child observed the shrink, so the
      // restore is always a genuine size change that forces a repaint.
      proc.resize(cols, rows - 1)
      const restore = () => {
        frameCbs.delete(restore)
        cancelNudge = undefined
        if (!disposed) proc.resize(cols, rows)
      }
      cancelNudge = () => {
        frameCbs.delete(restore)
        cancelNudge = undefined
      }
      frameCbs.add(restore)
    },
    geometry() {
      return { cols, rows }
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelNudge?.()
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
