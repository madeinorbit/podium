import { execFile } from 'node:child_process'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import type { Geometry } from '@podium/model'
import { ABDUCO_FEATURES, resolveAbducoBin } from './abduco-bin.js'
import { createAltScreenStripper } from './alt-screen-stripper.js'
import { defaultPtyBackend } from './backends/index.js'
import type { PtyBackend, PtyProcess } from './backends/types.js'
import { liveEnv, stopSessionScope, type SystemctlRunner } from './scope.js'
import { type DurableAttachment, wrapPty } from './session.js'
import { shellQuote } from './shell-quote.js'

const log = createLogger('pty:abduco')

/**
 * ADOPTING RUNNING abduco SESSIONS — nothing here creates one (POD-4986).
 *
 * Every Podium release before POD-4986 ran its sessions on abduco. podium-host is
 * now the only host a spawn uses, but a customer who upgrades keeps every session
 * that is already running: an abduco master found under a session's label is
 * attached to (`attachAbducoAgent`), listed in the census, probed and killed
 * exactly as before. The attach client is the vendored abduco binary
 * (`./abduco-bin.ts`) until a native client of abduco's socket protocol replaces
 * it; creating a session, reclaiming a terminated master for a respawn and the
 * create-path diagnostics are gone.
 *
 * abduco is "detach/reattach, nothing else": a daemonized master holds the
 * agent's PTY and pipes bytes transparently. The master survives both the attach
 * client and the daemon process (it setsids and reparents to the user manager).
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
export function abducoAttachArgv(
  label: string,
  bin = 'abduco',
  opts?: { sizeNeutral?: boolean },
): string[] {
  // -N (podium's abduco patch): attach without announcing a size. Only a binary
  // that carries the feature understands it — an upstream abduco would reject it
  // and the attach would fail, so the caller resolves that binary first.
  const flags = `-q${opts?.sizeNeutral ? ' -N' : ''}`
  return ['sh', '-c', `exec ${shellQuote(bin)} ${flags} -e "$(printf '\\377')" -a "$0"`, label]
}

/**
 * The binary for an attach, plus whether it can actually be asked to attach
 * size-neutrally. A caller that wants `-N` needs the patched build; when the
 * machine only has an upstream abduco the attach still happens, with today's
 * resize-on-attach behaviour, rather than failing outright.
 */
export function resolveAttachBin(sizeNeutral: boolean): { bin: string; sizeNeutral: boolean } {
  if (!sizeNeutral) return { bin: resolveAbducoBin() ?? 'abduco', sizeNeutral: false }
  const patched = resolveAbducoBin({ requireFeatures: ABDUCO_FEATURES })
  if (patched) return { bin: patched, sizeNeutral: true }
  if (!warnedNoSizeNeutral) {
    warnedNoSizeNeutral = true
    log.warn('no podium abduco build available — attaching will resize the running program', {
      requiredFeatures: ABDUCO_FEATURES,
    })
  }
  return { bin: resolveAbducoBin() ?? 'abduco', sizeNeutral: false }
}

let warnedNoSizeNeutral = false

/**
 * True when an abduco binary can be obtained — $PODIUM_ABDUCO, PATH, the build
 * cache, or by compiling the vendored source on first use (see abduco-bin.ts).
 */
export function isAbducoAvailable(): boolean {
  return resolveAbducoBin() !== undefined
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

const execFileAsync = promisify(execFile)

const ABDUCO_SOCKET_WAIT_MS = 5000
const ABDUCO_SOCKET_POLL_MS = 10
/** Ceiling for the global `abduco` listing — see {@link listSessions}. */
const ABDUCO_LIST_TIMEOUT_MS = 8000

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
 * `abduco` with no args lists sessions and reaps stale sockets as a side effect.
 * Exit status varies by version, so parse whatever it printed, including stdout
 * attached to a non-zero exit.
 */
async function listSessions(): Promise<AbducoSessionEntry[]> {
  const bin = resolveAbducoBin()
  if (!bin) return []
  try {
    // BOUNDED (POD-1953). The listing connects to every master in turn, so one
    // wedged session makes it hang — and an unbounded hang here is not a slow
    // answer, it is a lost one: the caller's `await` never returns and whatever
    // followed it never runs. Every caller has a correct empty-list fallback.
    const { stdout } = await execFileAsync(bin, [], {
      encoding: 'utf8',
      env: liveEnv(),
      timeout: ABDUCO_LIST_TIMEOUT_MS,
    })
    return parseAbducoList(stdout ?? '')
  } catch (err) {
    // `abduco` exits non-zero on some versions even when it printed a valid list;
    // recover whatever it wrote to stdout before giving up.
    const stdout = (err as { stdout?: string })?.stdout
    return stdout ? parseAbducoList(stdout) : []
  }
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
  // Started BEFORE the listing, not after it (POD-1953). The scope sweep is the
  // reap that always works — it signals the whole cgroup by unit name and needs
  // nothing from `abduco` — but it used to be reachable only THROUGH the await
  // below, so a listing that hung took the reliable half down with it and the
  // kill became a silent no-op: master alive, scope alive, nothing logged, and a
  // row that said 'hibernated' for four hours.
  const scope = stopSessionScope(label, run)
  try {
    const entry = (await listSessions()).find((s) => s.name === label && s.alive)
    if (entry) process.kill(entry.pid, 'SIGTERM')
  } catch {
    // already gone
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
  let sessions: AbducoSessionEntry[]
  try {
    sessions = await listSessions()
  } catch {
    return reaped
  }
  for (const s of sessions) {
    if (!s.alive) continue
    const m = patterns.map((re) => re.exec(s.name)).find((x) => x?.[1])
    if (!m?.[1]) continue
    const spawner = Number(m[1])
    if (spawner !== process.pid && pidIsAlive(spawner)) continue
    try {
      process.kill(s.pid, 'SIGTERM')
      reaped.push(s.name)
    } catch {
      // raced to death
    }
  }
  // An idle master parks in poll() and can sit on the pending SIGTERM; listing
  // connects to every socket, and that wake is when the quit flag is processed.
  if (reaped.length > 0) {
    try {
      await listSessions()
    } catch {
      // best-effort nudge
    }
  }
  return reaped
}

/** Delegate PtyProcess whose onData passes through the one-time chrome stripper. */
function stripAttachChrome(proc: PtyProcess, onReady: () => void): PtyProcess {
  const strip = createAltScreenStripper()
  let ready = false
  return {
    get pid() {
      return proc.pid
    },
    onData: (cb) =>
      proc.onData((d) => {
        if (!ready) {
          ready = true
          onReady()
        }
        const out = strip(d)
        if (out.length) cb(out)
      }),
    onExit: (cb) => proc.onExit(cb),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: (s) => proc.kill(s),
  }
}

/**
 * Attach a Bun.Terminal client to an existing abduco session. dispose() SIGKILLs the
 * client (the master + agent survive) — a hard kill on purpose: the client's atexit
 * handler would otherwise print cursor/alt-screen restore chrome into the stream.
 *
 * An attach never signals a TUI to repaint (POD-4723): a viewer repaints from the
 * daemon's screen snapshot, and the program repaints on a real size change only.
 * A shell alone gets a Ctrl-L once attached (`hardRepaint`).
 */
/**
 * How long a size-neutral attach waits for its client to connect before
 * repainting anyway. Long enough for a local socket attach, short enough that a
 * reconnected viewer is not left looking at nothing.
 */
const ATTACH_REPAINT_FALLBACK_MS = 1000
const CTRL_L = Uint8Array.of(0x0c)

/**
 * The size a size-neutral attach opens its pty at. `-N` means these dimensions
 * are never announced, so they are never the program's size and the value is
 * free — and it must NOT be the caller's last-known geometry, because a viewer's
 * first ask is usually for exactly that: it would be a no-op change here and
 * never reach the program, or would need a forced shrink-and-restore that moves
 * the program by a row. A size no viewer can ask for keeps every real ask a
 * single resize: one packet, one SIGWINCH, no reflow [spec:SP-6144].
 */
const SIZE_NEUTRAL_ATTACH_GEOMETRY = { cols: 1, rows: 1 } as const

interface AbducoAttachCommon {
  label: string
  /** Existing socket path, when recovery found a host-suffixed socket. */
  socketPath?: string
  env?: Record<string, string>
  /** Reattaching a shell: send Ctrl-L once attached, since an idle shell never repaints by itself. */
  hardRepaint?: boolean
  /**
   * Whether to ask for a repaint once attached. Defaults true.
   */
  repaintOnAttach?: boolean
  backend?: PtyBackend
}

/**
 * An attach either announces a size to the running program or it does not, and
 * the two carry different geometry — which is why this is a union rather than an
 * optional flag beside a required `cols`/`rows`.
 */
export type AbducoAttachOptions =
  | (AbducoAttachCommon & {
      sizeNeutral?: false
      /** Applied to the program: this attach's pty size IS the program's size. */
      cols: number
      rows: number
    })
  | (AbducoAttachCommon & {
      /**
       * Attach without announcing a size (`-N`): the running program is neither
       * resized nor signalled by this attach, whose pty opens at a sentinel size.
       * Every attach to an ALREADY RUNNING program wants this — a reconnect is
       * not a viewer asking for a size, and the caller's last-known size may be
       * stale. The exception is the attach right after a create: the master's pty
       * is forked at abduco's own default (80x25, it has no tty), and that first
       * attach's resize packet is the only thing that moves the program to the
       * requested size [spec:SP-6144].
       */
      sizeNeutral: true
      /**
       * Used ONLY when no `-N` build exists and {@link resolveAttachBin}
       * downgrades this to an ordinary attach — which then APPLIES this geometry
       * to the running program (abduco reports nothing back: POD-4723). Never
       * read on the `-N` path. Last-known is the right value: the downgraded
       * attach re-grids the program, and any other size would leave the agent and
       * every viewer's render disagreeing until someone asked.
       */
      fallbackGeometry: Geometry
      cols?: never
      rows?: never
    })

export function attachAbducoAgent(opts: AbducoAttachOptions): DurableAttachment {
  const attach = resolveAttachBin(opts.sizeNeutral === true)
  const [cmd, ...args] = abducoAttachArgv(opts.socketPath ?? opts.label, attach.bin, {
    sizeNeutral: attach.sizeNeutral,
  })
  const backend = opts.backend ?? defaultPtyBackend()
  const geometry = attach.sizeNeutral
    ? SIZE_NEUTRAL_ATTACH_GEOMETRY
    : opts.sizeNeutral === true
      ? opts.fallbackGeometry
      : { cols: opts.cols, rows: opts.rows }
  const proc = backend.spawn({
    file: cmd as string,
    args,
    cols: geometry.cols,
    rows: geometry.rows,
    env: { ...process.env, COLORTERM: 'truecolor', ...opts.env } as Record<string, string>,
  })
  let repaintPending = false
  let repaintTimer: ReturnType<typeof setTimeout> | undefined
  // THE ONE REPAINT AN ATTACH MAY STILL ASK FOR (POD-4723): a shell's Ctrl-L.
  // A TUI is never signalled by an attach — it repaints on a real size change,
  // which only a viewer's ask produces.
  const repaint = (): void => {
    if (opts.hardRepaint) session.writeBytes(CTRL_L)
  }
  const flushRepaint = (): void => {
    if (repaintTimer) clearTimeout(repaintTimer)
    repaintTimer = undefined
    if (!repaintPending) return
    repaintPending = false
    repaint()
  }
  const filtered = stripAttachChrome(proc, flushRepaint)
  const session = wrapPty(filtered)
  if (opts.repaintOnAttach ?? true) {
    if (attach.sizeNeutral) {
      // A keystroke written before the attach client has taken the attach pty
      // out of canonical mode sits in its line buffer — echoed, and delivered
      // glued to whatever the viewer types next (measured: the agent read
      // `0c796f0a` as one chunk). So wait for the client's first byte, with a
      // fallback for a session quiet enough that none comes.
      repaintPending = true
      repaintTimer = setTimeout(flushRepaint, ATTACH_REPAINT_FALLBACK_MS)
      repaintTimer.unref?.()
    } else repaint()
  }
  return {
    ...session,
    dispose() {
      if (repaintTimer) clearTimeout(repaintTimer)
      repaintTimer = undefined
      try {
        proc.kill('SIGKILL')
      } catch {
        // already exited
      }
      session.dispose()
    },
  }
}
