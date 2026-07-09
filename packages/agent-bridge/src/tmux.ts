import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { defaultPtyBackend } from './pty/index.js'
import type { PtyBackend } from './pty/types.js'
import { type AgentSession, withHardRepaint, wrapPty } from './session.js'

const SESSION = 'main'

/** POSIX single-quote a string for `sh -c` (tmux runs new-session's command via the shell). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function newSessionArgs(
  label: string,
  cols: number,
  rows: number,
  cwd: string | undefined,
  inner: string,
): string[] {
  return [
    '-L',
    label,
    'new-session',
    '-d',
    '-s',
    SESSION,
    '-x',
    String(cols),
    '-y',
    String(rows),
    ...(cwd ? ['-c', cwd] : []),
    inner,
  ]
}

/** Config applied right after new-session, before the client attaches (spike-validated). */
export function tmuxConfigCommands(label: string): string[][] {
  const set = (...a: string[]): string[] => ['-L', label, 'set', ...a]
  return [
    set('-g', 'prefix', 'None'),
    set('-sg', 'escape-time', '0'),
    set('-g', 'status', 'off'),
    set('-g', 'set-titles', 'on'),
    set('-g', 'set-titles-string', '#{pane_title}'),
    set('-g', 'extended-keys', 'on'),
    set('-g', 'allow-passthrough', 'on'),
    set('-g', 'default-terminal', 'tmux-256color'),
    set('-ga', 'terminal-overrides', ',xterm-256color:RGB'),
  ]
}

export function isTmuxAvailable(): boolean {
  // Never on Windows: an msys2/cygwin tmux on PATH would answer `-V` but the whole
  // wrapper (sh quoting, POSIX sockets) assumes a POSIX host — Windows sessions run
  // on the ConPTY backend without a durable host instead [spec:SP-7f2c].
  if (process.platform === 'win32') return false
  try {
    return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

export function tmuxHasSession(label: string): boolean {
  return (
    spawnSync('tmux', ['-L', label, 'has-session', '-t', SESSION], { stdio: 'ignore' }).status === 0
  )
}

const execFileAsync = promisify(execFile)

/** Non-blocking {@link tmuxHasSession} — `await`-able so it never blocks the event loop. */
export async function tmuxHasSessionAsync(label: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-L', label, 'has-session', '-t', SESSION])
    return true
  } catch {
    return false
  }
}

export function killTmuxServer(label: string): void {
  try {
    execFileSync('tmux', ['-L', label, 'kill-server'], { stdio: 'ignore' })
  } catch {
    // already gone
  }
}

/** Non-blocking {@link killTmuxServer} — prefer on the daemon's per-session `kill` path. */
export async function killTmuxServerAsync(label: string): Promise<void> {
  try {
    await execFileAsync('tmux', ['-L', label, 'kill-server'])
  } catch {
    // already gone
  }
}

export interface TmuxSpawnOptions {
  label: string
  cmd: string
  args?: string[]
  cwd?: string
  cols: number
  rows: number
  env?: Record<string, string>
}

/** Create a detached per-session tmux server running the agent, apply config, attach a client. */
export function spawnTmuxAgent(opts: TmuxSpawnOptions): AgentSession {
  const inner = [opts.cmd, ...(opts.args ?? [])].map(shellQuote).join(' ')
  const env = { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>
  execFileSync('tmux', newSessionArgs(opts.label, opts.cols, opts.rows, opts.cwd, inner), {
    stdio: 'ignore',
    env,
  })
  for (const args of tmuxConfigCommands(opts.label)) {
    execFileSync('tmux', args, { stdio: 'ignore' })
  }
  return attachTmuxAgent({ label: opts.label, cols: opts.cols, rows: opts.rows, env: opts.env })
}

/** Attach a node-pty tmux client to an existing session. dispose() detaches (agent survives). */
export function attachTmuxAgent(opts: {
  label: string
  cols: number
  rows: number
  env?: Record<string, string>
  /** Reattaching a shell: nudge with Ctrl-L too, since it won't repaint on SIGWINCH while idle. */
  hardRepaint?: boolean
  backend?: PtyBackend
}): AgentSession {
  const backend = opts.backend ?? defaultPtyBackend()
  const proc = backend.spawn({
    file: 'tmux',
    args: ['-L', opts.label, 'attach', '-t', SESSION],
    cols: opts.cols,
    rows: opts.rows,
    env: { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })
  return withHardRepaint(
    wrapPty(proc, { cols: opts.cols, rows: opts.rows }),
    opts.hardRepaint ?? false,
  )
}
