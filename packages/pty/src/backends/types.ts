export interface PtySpawnOptions {
  file: string
  args: string[]
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
}

/** Backend-neutral PTY handle. Canonical data form is BYTES. */
export interface PtyProcess {
  readonly pid: number
  onData(cb: (bytes: Uint8Array) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: Uint8Array): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtyBackend {
  readonly name: 'node-pty' | 'bun-terminal'
  spawn(opts: PtySpawnOptions): PtyProcess
}
