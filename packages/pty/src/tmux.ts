import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { defaultPtyBackend } from './backends/index.js'
import type { PtyBackend } from './backends/types.js'
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

const execFileAsync = promisify(execFile)

/** Whether this socket label owns a live tmux session. */
export async function tmuxHasSession(label: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-L', label, 'has-session', '-t', SESSION])
    return true
  } catch {
    return false
  }
}

/** Stop this label's tmux server; an already-gone server is a successful no-op. */
export async function killTmuxServer(label: string): Promise<void> {
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
  backend?: PtyBackend
}

/**
 * Env for tmux create/attach. Force a real TERM (abduco does the same): agent
 * sessions and many test runners inherit `TERM=dumb`, and tmux then fails the
 * pane with "open terminal failed: terminal does not support clear" so the
 * fixture/agent never paints — reattach looks like a silent PTY. [spec:SP-3f93]
 */
function tmuxClientEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...extra,
  } as Record<string, string>
}

/** Create a detached per-session tmux server running the agent, apply config, attach a client. */
export async function spawnTmuxAgent(opts: TmuxSpawnOptions): Promise<AgentSession> {
  const inner = [opts.cmd, ...(opts.args ?? [])].map(shellQuote).join(' ')
  const env = tmuxClientEnv(opts.env)
  await execFileAsync('tmux', newSessionArgs(opts.label, opts.cols, opts.rows, opts.cwd, inner), {
    env,
  })
  for (const args of tmuxConfigCommands(opts.label)) {
    await execFileAsync('tmux', args, { env })
  }
  return attachTmuxAgent({
    label: opts.label,
    cols: opts.cols,
    rows: opts.rows,
    env: opts.env,
    backend: opts.backend,
  })
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
    env: tmuxClientEnv(opts.env),
  })
  return withHardRepaint(
    wrapPty(proc, { cols: opts.cols, rows: opts.rows }),
    opts.hardRepaint ?? false,
  )
}
