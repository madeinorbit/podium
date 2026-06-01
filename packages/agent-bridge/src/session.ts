import type { Geometry } from '@podium/protocol'

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

export function spawnAgent(_opts: SpawnOptions): AgentSession {
  throw new Error('not implemented')
}
