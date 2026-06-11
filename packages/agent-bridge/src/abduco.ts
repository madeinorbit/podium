import { execFileSync, spawnSync } from 'node:child_process'
import { type IPty, spawn as ptySpawn } from 'node-pty'
import { type AgentSession, wrapPty } from './session'

/**
 * abduco-backed durable sessions. abduco is "detach/reattach, nothing else": a
 * daemonized master holds the agent's PTY and pipes bytes transparently — no grid,
 * no copy-mode, no status chrome — so xterm.js stays the only terminal emulator in
 * the stack. The master survives both the attach client and the daemon process
 * (verified: it setsids and reparents to the user manager).
 */

/**
 * The abduco client treats any input chunk whose FIRST byte equals the detach key
 * (default `^\` = 0x1c) as a detach request and swallows the whole chunk. We remap
 * it to 0xff, a byte that can never occur in valid UTF-8 input from xterm.js. The
 * raw byte cannot be passed through node argv (JS strings argv-encode as UTF-8, so
 * '\xff' becomes 0xC3 0xBF and the real key would be 0xC3 — the first byte of
 * é/à/ö, far worse than the default), so the attach command routes through
 * `sh -c` with printf producing the byte.
 */
export function abducoAttachArgv(label: string): string[] {
  return ['sh', '-c', `exec abduco -q -e "$(printf '\\377')" -a "$0"`, label]
}

/** abduco runs the command via execvp from argv — no shell, no quoting needed. */
export function abducoCreateArgv(label: string, cmd: string, args: string[] = []): string[] {
  return ['-n', label, cmd, ...args]
}

export function isAbducoAvailable(): boolean {
  try {
    return spawnSync('abduco', ['-v'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

export interface AbducoSessionEntry {
  name: string
  pid: number
  alive: boolean
}

/**
 * Parse `abduco` (no args) session-list output. Lines after the header are
 * `<state> <day>\t<datetime>\t<pid>\t<name>`. The state char maps to socket mode
 * bits the server toggles (abduco 0.6 source, server_mark_socket_exec):
 * `*` = S_IXUSR = a client is ATTACHED (alive!), `+` = S_IXGRP = the app
 * TERMINATED (only its exit status is held), ` ` = detached and alive. Note this
 * is the opposite of the folklore reading of `*`; trust the source — misreading
 * `*` as dead would declare every session with a connected podium client dead.
 */
export function parseAbducoList(output: string): AbducoSessionEntry[] {
  const entries: AbducoSessionEntry[] = []
  for (const line of output.split('\n')) {
    const fields = line.split('\t')
    if (fields.length < 4) continue
    const pid = Number.parseInt(fields[2]?.trim() ?? '', 10)
    const name = fields.slice(3).join('\t').trim()
    if (!name || Number.isNaN(pid)) continue
    entries.push({ name, pid, alive: !line.trimStart().startsWith('+') })
  }
  return entries
}

function listSessions(): AbducoSessionEntry[] {
  // `abduco` with no args lists sessions; it also reaps stale sockets as a side
  // effect. Exit status varies by version, so parse whatever it printed.
  const res = spawnSync('abduco', [], { encoding: 'utf8' })
  return parseAbducoList(res.stdout ?? '')
}

export function abducoHasSession(label: string): boolean {
  try {
    return listSessions().some((s) => s.name === label && s.alive)
  } catch {
    return false
  }
}

/** SIGTERM the session master — verified to take the app down and clean the socket. */
export function killAbducoSession(label: string): void {
  try {
    const entry = listSessions().find((s) => s.name === label && s.alive)
    if (entry) process.kill(entry.pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

const ATTACH_CHROME = '\x1b[?1049h\x1b[H'

/**
 * One-shot, split-safe strip of the alt-screen chrome the abduco client prints when
 * it attaches with a tty stdin. Forwarding it would push the whole session into
 * xterm.js's alternate buffer and kill scrollback — the exact bug class this module
 * exists to remove. Holds back at most ATTACH_CHROME.length bytes, only until the
 * first divergence, and is a pure passthrough afterward.
 */
export function createAltScreenStripper(): (data: string) => string {
  let held = ''
  let done = false
  return (data: string): string => {
    if (done) return data
    held += data
    if (ATTACH_CHROME.startsWith(held)) {
      if (held.length === ATTACH_CHROME.length) {
        done = true // full prefix seen — swallow it
        return ''
      }
      return '' // still a plausible prefix — keep holding
    }
    done = true
    return held.startsWith(ATTACH_CHROME) ? held.slice(ATTACH_CHROME.length) : held
  }
}

/** Delegate IPty whose onData passes through the one-time chrome stripper. */
function stripAttachChrome(proc: IPty): IPty {
  const strip = createAltScreenStripper()
  const filtered: Pick<IPty, 'pid' | 'cols' | 'rows' | 'onData' | 'onExit'> & {
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
  } = {
    get pid() {
      return proc.pid
    },
    get cols() {
      return proc.cols
    },
    get rows() {
      return proc.rows
    },
    onData: (cb) =>
      proc.onData((d) => {
        const out = strip(d)
        if (out) cb(out)
      }),
    onExit: (cb) => proc.onExit(cb),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: (s) => proc.kill(s),
  }
  return filtered as IPty
}

export interface AbducoSpawnOptions {
  label: string
  cmd: string
  args?: string[]
  cwd?: string
  cols: number
  rows: number
  env?: Record<string, string>
}

/**
 * Create a detached abduco session running the agent, then attach a client.
 * The session app inherits cwd/env from the CREATE call (abduco has no flags for
 * either); TERM/COLORTERM must be forced here — there is no tmux
 * `default-terminal` equivalent. Initial pty geometry is abduco's 80x25 default;
 * the attach client immediately resizes to cols×rows (abduco sends the size and
 * SIGWINCHes the app group on attach).
 */
export function spawnAbducoAgent(opts: AbducoSpawnOptions): AgentSession {
  execFileSync('abduco', abducoCreateArgv(opts.label, opts.cmd, opts.args ?? []), {
    stdio: 'ignore',
    cwd: opts.cwd ?? process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...opts.env,
    } as Record<string, string>,
  })
  return attachAbducoAgent({
    label: opts.label,
    cols: opts.cols,
    rows: opts.rows,
    ...(opts.env ? { env: opts.env } : {}),
  })
}

/**
 * Attach a node-pty client to an existing abduco session. dispose() SIGKILLs the
 * client (the master + agent survive) — a hard kill on purpose: the client's atexit
 * handler would otherwise print cursor/alt-screen restore chrome into the stream.
 *
 * The attach nudges a repaint: abduco only SIGWINCHes the app's process group, and
 * node-based TUIs (Claude Code included) repaint only when the dimensions actually
 * CHANGE — so reattaching at the previous geometry would show a blank screen.
 * redraw()'s shrink/restore is ack-based (restores after the app's first frame), so
 * it lands correctly even while the abduco client is still connecting.
 */
export function attachAbducoAgent(opts: {
  label: string
  cols: number
  rows: number
  env?: Record<string, string>
}): AgentSession {
  const [cmd, ...args] = abducoAttachArgv(opts.label)
  const proc = ptySpawn(cmd as string, args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    env: { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })
  const session = wrapPty(stripAttachChrome(proc))
  session.redraw()
  return {
    ...session,
    dispose() {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already exited
      }
      session.dispose()
    },
  }
}
