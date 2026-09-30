import { execFile } from 'node:child_process'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AbducoConnection, probeAbducoPid } from './abduco-client.js'
import { liveEnv, type SystemctlRunner, stopSessionScope } from './scope.js'
import { type AgentFrame, type DurableAttachment, wrapPty } from './session.js'

/**
 * Upgrade-only adoption of abduco sessions started by every released Podium.
 * New sessions use podium-host. The native client speaks the old master's
 * socket protocol without an abduco executable, compiler or local attach PTY.
 * Delete this compatibility layer once no running legacy session can remain.
 */

const execFileAsync = promisify(execFile)

const ABDUCO_SOCKET_WAIT_MS = 5000
const ABDUCO_SOCKET_POLL_MS = 10

/**
 * Candidate roots in abduco's resolution order — ALL FOUR OF THEM (POD-2853).
 *
 * abduco does not resolve one directory, it walks a FALL-THROUGH CHAIN:
 * `ABDUCO_SOCKET_DIR`, then `HOME`, then `TMPDIR`, then `/tmp` (config.h), and
 * it moves to the next one on ANY failure of the current one — the directory's
 * parent does not exist, `mkdir` is refused, the per-user subdirectory is owned
 * by someone else or group/world accessible, the composed name truncates, or
 * the probe bind fails. It says nothing when it does: the create SUCCEEDS, at a
 * different root.
 *
 * This function used to stop at the first root. When `ABDUCO_SOCKET_DIR` was
 * set it looked ONLY under it, and when it was unset ONLY under `$HOME/.abduco`
 * — so a master that fell through to `/tmp` was invisible to every caller that
 * asks "is this label alive". Measured directly: an abduco master created with
 * a given environment, alive and holding its socket, while `abducoSocketPath`
 * called with THAT SAME ENVIRONMENT answered `undefined`.
 *
 * THE ERROR IS ONE-SIDED TOWARD "ABSENT", which is the expensive direction on
 * every caller — when abduco still spawned, the create path reported "did not
 * publish a live socket" for a session that was running; today the reattach
 * path answers "session not found" for a master that is still there. Same shape as
 * POD-2761, which fixed the ATTACH path's environment and left this one.
 *
 * The two non-user-specific entries under `ABDUCO_SOCKET_DIR` are historical
 * compatibility, not abduco's behaviour, and are kept so nothing that resolves
 * today stops resolving.
 */
function abducoSocketDirs(env: NodeJS.ProcessEnv, username?: string): string[] {
  const dirs: string[] = []
  let user = username
  if (!user) {
    try {
      user = userInfo().username
    } catch {
      // No passwd entry: abduco names the subdirectory by numeric uid instead.
      user = typeof process.getuid === 'function' ? String(process.getuid()) : undefined
    }
  }
  /** A non-personal root: `<root>/abduco/<user>`, exactly as create_socket_dir builds it. */
  const shared = (root: string) => {
    if (user) dirs.push(join(root, 'abduco', user))
  }
  if (env.ABDUCO_SOCKET_DIR) {
    shared(env.ABDUCO_SOCKET_DIR)
    dirs.push(join(env.ABDUCO_SOCKET_DIR, 'abduco'), env.ABDUCO_SOCKET_DIR)
  }
  // HOME is abduco's `personal` root: `$HOME/.abduco`, with NO user subdirectory.
  if (env.HOME) dirs.push(join(env.HOME, '.abduco'))
  if (env.TMPDIR) shared(env.TMPDIR)
  shared('/tmp')
  // De-duplicated because the chain overlaps in ordinary configurations —
  // TMPDIR is very often /tmp — and every duplicate is another readdir on the
  // spawn path's poll loop.
  return dirs.filter((dir, i) => dirs.indexOf(dir) === i)
}

/**
 * Resolve one live abduco socket for a durable label.
 *
 * Relative abduco names are stored as `<label>@<hostname>`. The hostname is
 * written once by the abduco master and can be stale after an OS rename, so a
 * recovery path must retain the discovered filename and attach by its absolute
 * path instead of asking abduco to reconstruct it from the current hostname.
 */
export function abducoSocketPath(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  username?: string,
): string | undefined {
  for (const path of abducoSocketCandidates(label, env, username)) {
    try {
      if ((statSync(path).mode & 0o010) === 0) return path
    } catch {
      // The master exited between readdir and stat; keep looking.
    }
  }
  return undefined
}

/** abduco's create-dir probe: bind `.abduco-<pid>`, then unlink on the success path. */
const ABDUCO_BIND_TEMP_RE = /^\.abduco-(\d+)$/

/**
 * `kill(pid, 0)` liveness: ESRCH is gone; EPERM means the pid is alive but not
 * ours. Same shape {@link reapAbducoTestSessions} uses for crashed spawners.
 */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Unlink leftover `.abduco-<pid>` bind probes whose pid is not alive.
 *
 * abduco binds that name while picking a writable socket directory (then
 * unlinks it and binds the real session socket). A killed spawn, failed
 * create, or crashed test runner leaves the probe behind. Nothing else
 * reaps them, so `abducoSocketCandidates`' `readdirSync` — and the global
 * `abduco` listing — grow without bound.
 *
 * A temp whose pid is still alive is a bind in flight: leave it. Pid
 * liveness, not mtime: a just-started create must not be collected.
 */
export function reapStaleAbducoBindTemps(
  env: NodeJS.ProcessEnv = process.env,
  username?: string,
): string[] {
  const reaped: string[] = []
  for (const dir of abducoSocketDirs(env, username)) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const match = ABDUCO_BIND_TEMP_RE.exec(name)
      if (!match) continue
      const pid = Number(match[1])
      if (!Number.isInteger(pid) || pid < 1 || pidIsAlive(pid)) continue
      const path = join(dir, name)
      try {
        unlinkSync(path)
        reaped.push(path)
      } catch {
        // raced with a live bind, or already gone
      }
    }
  }
  return reaped
}

/** Every socket file that could belong to this label, in abduco's own preference order. */
function abducoSocketCandidates(
  label: string,
  env: NodeJS.ProcessEnv,
  username?: string,
): string[] {
  const paths: string[] = []
  for (const dir of abducoSocketDirs(env, username)) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const candidates = names
      .filter((name) => name === label || name.startsWith(`${label}@`))
      .sort((a, b) => {
        // Prefer an explicitly named socket, then make historical host-suffixed
        // recovery deterministic when more than one stale candidate exists.
        if (a === label) return -1
        if (b === label) return 1
        return a.localeCompare(b)
      })
    for (const name of candidates) paths.push(join(dir, name))
  }
  return paths
}

/**
 * Wait for a master to publish its socket before starting the attach client.
 * "abduco -n" (run by an older Podium, or by a test standing in for one) exits
 * after handing work to the daemonized master, which can still be between fork
 * and bind when an immediate "-a" runs. A durable label is unique, so the
 * socket index is the readiness signal and also gives the absolute path needed
 * for renamed hosts.
 */
export async function waitForAbducoSocket(
  label: string,
  env: NodeJS.ProcessEnv = liveEnv(),
  options: { timeoutMs?: number; pollMs?: number; username?: string } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? ABDUCO_SOCKET_WAIT_MS
  const pollMs = options.pollMs ?? ABDUCO_SOCKET_POLL_MS
  const deadline = Date.now() + timeoutMs
  let path = abducoSocketPath(label, env, options.username)
  while (path === undefined && Date.now() < deadline) {
    const delay = Math.min(pollMs, Math.max(1, deadline - Date.now()))
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    path = abducoSocketPath(label, env, options.username)
  }
  if (path === undefined) {
    throw new Error(
      'abduco session ' + label + ' did not publish a live socket within ' + timeoutMs + 'ms',
    )
  }
  return path
}

export function abducoSocketHasSession(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  username?: string,
): boolean {
  return abducoSocketPath(label, env, username) !== undefined
}

/**
 * Whether a live abduco master owns this label. Answered from the socket index
 * ({@link abducoSocketHasSession}), never the global `abduco` listing: on daemon
 * recovery the listing connects to every master in lexical order, so one wedged
 * legacy session turns into a fleet-wide reattach outage. Kept async because every
 * caller awaits it and the previous implementation shelled out.
 */
export async function abducoHasSession(label: string): Promise<boolean> {
  return abducoSocketHasSession(label)
}

/**
 * SIGTERM the session master and sweep its systemd scope. The async list/process
 * path keeps burst kills from starving every other session on the daemon loop.
 */
export async function killAbducoSession(
  label: string,
  run: SystemctlRunner = execFileAsync,
): Promise<void> {
  const scope = stopSessionScope(label, run)
  try {
    const path = abducoSocketPath(label)
    if (path) process.kill(await probeAbducoPid(path), 'SIGTERM')
  } catch {
    // Already gone or unreachable; the unconditional scope sweep still runs.
  }
  // Also sweep the session's scope cgroup (POD-108): SIGTERMing the master takes
  // the agent down via PTY hangup, but grandchildren the agent spawned (test
  // runs, builds, stray Xvfb) survive in the scope and stay resident, and an
  // archived session never gets another spawn to clear them. `systemctl stop` signals the whole cgroup and
  // escalates to SIGKILL on its stop timeout; reset-failed clears leftover unit
  // state. Unconditional: a dead master with squatting orphans still needs it.
  await scope
}

/**
 * Every durable label this host is still RUNNING, read from the socket index.
 *
 * The census answer for POD-1953: a server that parked a row cannot know the
 * reap landed, so on connect the daemon tells it which labels are in fact still
 * alive. No `abduco` fork, so it cannot hang behind a wedged master however many
 * sessions this machine holds.
 *
 * ONE readdir per directory and ONE stat per entry. Asking
 * {@link abducoSocketPath} per label instead would re-read the whole directory
 * for every entry in it, and these directories are not small — the box this was
 * written on had 7032 sockets, where the quadratic form took 30 SECONDS and hung
 * the daemon's connect handshake behind it.
 *
 * A master that TERMINATED (S_IXGRP: the app exited, the master lingers holding
 * its exit status) owns the name but is not an agent, and is excluded here for
 * the same reason {@link abducoSocketPath} skips it: reviving a row over one
 * would resurrect nothing.
 */
export function listLiveAbducoLabels(
  env: NodeJS.ProcessEnv = process.env,
  /** Injection seam: the cost this function is bounded on is the read COUNT. */
  readdir: (dir: string) => string[] = readdirSync,
): string[] {
  const labels = new Set<string>()
  for (const dir of abducoSocketDirs(env)) {
    let names: string[]
    try {
      names = readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      // abduco binds `.abduco-<pid>` and renames it into place, and the temp is
      // left behind whenever that does not complete — 6944 of them on the box
      // this was written on. They are not sessions, and their mode is abduco's
      // business, not a contract: exclude them by name rather than trusting the
      // permission bits below to keep classifying them as dead.
      if (name.startsWith('.')) continue
      // Relative names are stored `<label>@<hostname>`; the label is the part
      // before the FIRST '@' (podium labels never contain one).
      const label = name.split('@')[0]
      if (!label) continue
      try {
        if ((statSync(join(dir, name)).mode & 0o010) === 0) labels.add(label)
      } catch {
        // The master exited between readdir and stat — not live, keep going.
      }
    }
  }
  return [...labels]
}

/**
 * Teardown sweep for the abduco test harnesses (POD-107). Test labels embed the
 * spawning test process's pid (`podium-abduco-itest-<pid>`, `podium-ab-retail-<pid>`,
 * …), and the per-test `killAbducoSession` sits on the happy path only — a failed
 * assertion or a killed runner skips it and the detached master lives for days,
 * attributed to "project processes" in the host memory breakdown. Call this from
 * `afterAll`: it kills every session matching one of `patterns` whose captured pid
 * (each pattern's FIRST capture group) is this process — this run's sessions,
 * pass or fail — or no longer alive — a previous crashed run. Sessions of a
 * concurrent test process survive: their embedded pid is alive and not ours.
 */
export async function reapAbducoTestSessions(patterns: RegExp[]): Promise<string[]> {
  const reaped: string[] = []
  for (const name of listLiveAbducoLabels()) {
    const match = patterns.map((re) => re.exec(name)).find((x) => x?.[1])
    if (!match?.[1]) continue
    const spawner = Number(match[1])
    if (spawner !== process.pid && pidIsAlive(spawner)) continue
    try {
      const path = abducoSocketPath(name)
      if (!path) continue
      process.kill(await probeAbducoPid(path), 'SIGTERM')
      reaped.push(name)
    } catch {
      // Raced to death or unreachable.
    }
  }
  return reaped
}

export interface AbducoAttachOptions {
  label: string
  /** Preserve the discovered filename, including a former hostname. */
  socketPath?: string
  env?: Record<string, string>
  /** Recovery is size-neutral: only a later viewer request changes the tty. */
  sizeNeutral?: boolean
  cols?: number
  rows?: number
  readOnly?: boolean
  /** An explicitly requested shell repaint, sent after ATTACH. */
  hardRepaint?: boolean
  repaintOnAttach?: boolean
}

export type AbducoAttachment = DurableAttachment & { readonly ready: Promise<number> }

export function attachAbducoAgent(opts: AbducoAttachOptions): AbducoAttachment {
  const path = opts.socketPath ?? abducoSocketPath(opts.label, { ...process.env, ...opts.env })
  if (!path) throw new Error(`abduco session '${opts.label}' has no live socket`)
  const proc = new AbducoConnection(path, {
    readOnly: opts.readOnly,
    ...(!opts.sizeNeutral && opts.cols !== undefined && opts.rows !== undefined
      ? { geometry: { cols: opts.cols, rows: opts.rows } }
      : {}),
  })
  const session = wrapPty(proc)
  if (opts.hardRepaint && (opts.repaintOnAttach ?? true)) proc.write(Uint8Array.of(0x0c))
  // PID and output may arrive in the same read, before the awaiting daemon
  // installs its listeners. Keep that first output and exit through the handoff.
  const earlyFrames: AgentFrame[] = []
  let listening = false
  let exitCode: number | undefined
  let title: string | undefined
  session.onFrame((frame) => {
    if (!listening) earlyFrames.push(frame)
  })
  session.onExit((code) => {
    exitCode = code
  })
  session.onTitle((value) => {
    title = value
  })
  return {
    ...session,
    // Object spread evaluates getters before the asynchronous PID packet.
    get pid() {
      return proc.pid
    },
    ready: proc.ready,
    onFrame(cb) {
      const unsubscribe = session.onFrame(cb)
      if (!listening) {
        listening = true
        for (const frame of earlyFrames.splice(0)) cb(frame)
      }
      return unsubscribe
    },
    onTitle(cb) {
      const unsubscribe = session.onTitle(cb)
      if (title !== undefined) cb(title)
      return unsubscribe
    },
    onExit(cb) {
      if (exitCode === undefined) return session.onExit(cb)
      let subscribed = true
      queueMicrotask(() => {
        if (subscribed) cb(exitCode as number)
      })
      return () => {
        subscribed = false
      }
    },
    dispose() {
      earlyFrames.length = 0
      title = undefined
      session.dispose()
    },
  }
}
