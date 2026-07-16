/**
 * Shared session-isolation plumbing for the e2e harness. The harness points
 * ABDUCO_SOCKET_DIR and TMUX_TMPDIR into a deterministic per-port directory so
 * its durable sessions are (a) invisible to the developer's real abduco/tmux
 * sessions and (b) reapable as a set — Playwright SIGKILLs the webServer tree on
 * shutdown, so an in-process handler alone cannot be trusted to clean up.
 * reapHarnessSessions() runs at harness startup (self-healing after a hard kill)
 * and again from Playwright's globalTeardown.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const HARNESS_SHUTDOWN_GRACE_MS = 10_000
const HARNESS_FORCE_KILL_WAIT_MS = 1_000
const HARNESS_SHUTDOWN_POLL_MS = 50

/**
 * Tmp root for the harness's per-port dirs: the HOST tmpdir, deliberately NOT the
 * per-test-file `TMPDIR` container that test-hermetic-env.ts installs (SP-0be7).
 * That container is exported as PODIUM_TEST_HOST_TMPDIR's fallback only; two
 * reasons this base must escape it:
 *
 *  1. Determinism. This path is a cross-PROCESS contract, not a per-process temp:
 *     serve-harness parks durable abduco masters under it, and a *different*
 *     process (Playwright globalTeardown, the next run's startup reap) must
 *     recompute the identical path to reap them "as a set". The container is
 *     per-fork and random, so vitest forks and the Playwright side silently
 *     disagreed on where the harness lived.
 *  2. abduco's socket budget. abduco builds the master's socket at
 *     `$ABDUCO_SOCKET_DIR/abduco/<user>/<label><@host>` and hard-fails with
 *     "create-session: File name too long" once that exceeds sun_path (108).
 *     A `podium-<uuid>` label + `@<host>` spends 64 of it, leaving 43 for the
 *     socket dir: `/tmp/podium-e2e-<port>/abduco` (27) fits, but the container
 *     prefix (`/podium-test-run-XXXXXX`, +23) overflowed it — the daemon could
 *     not spawn ANY session and the e2e test only saw a 20s output timeout.
 *
 * Not a tmp leak: unlike the unmanaged mkdtemp sites SP-0be7 contained, this is
 * ONE fixed dir per port that reapHarnessSessions() removes at startup (self-
 * healing after a hard kill), on afterAll, and from globalTeardown.
 */
function harnessTmpRoot(): string {
  return process.env.PODIUM_TEST_HOST_TMPDIR?.trim() || tmpdir()
}

export function harnessStateBase(port: number): string {
  return join(harnessTmpRoot(), `podium-e2e-${port}`)
}
export function harnessPidFile(port: number): string {
  return join(harnessStateBase(port), 'state', 'harness.pid')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Stop the long-running harness before deleting the state it owns. Playwright runs
 * globalTeardown while its webServer can still be alive, so deleting first races the
 * server's asynchronous transcript-lake writer. serve-harness removes its pid file
 * only after daemon + server close; that removal is the graceful-shutdown ack.
 *
 * A wedged harness gets a bounded grace period and then SIGKILL. The durable PTY
 * masters are separate processes and remain the reaper's responsibility below.
 */
export async function stopHarnessProcess(
  port: number,
  options: { graceMs?: number; forceKillWaitMs?: number; pollMs?: number } = {},
): Promise<void> {
  const pidFile = harnessPidFile(port)
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  } catch {
    return
  }
  // Never turn a corrupt/stale marker into a broad signal (especially pid 0,
  // which targets the caller's whole process group).
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // already exited
  }

  const pollMs = options.pollMs ?? HARNESS_SHUTDOWN_POLL_MS
  const gracefulDeadline = Date.now() + (options.graceMs ?? HARNESS_SHUTDOWN_GRACE_MS)
  while (existsSync(pidFile) && processIsAlive(pid) && Date.now() < gracefulDeadline) {
    await sleep(pollMs)
  }
  // Missing marker means serve-harness has closed every writer. A dead process is
  // equally safe even when a hard exit left the marker behind.
  if (!existsSync(pidFile) || !processIsAlive(pid)) return

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return // raced to exit after the final liveness check
  }
  const killedDeadline = Date.now() + (options.forceKillWaitMs ?? HARNESS_FORCE_KILL_WAIT_MS)
  while (processIsAlive(pid) && Date.now() < killedDeadline) await sleep(pollMs)
}

export function harnessEnv(port: number): {
  base: string
  stateDir: string
  abducoSocketDir: string
  tmuxTmpDir: string
  discoveryHomeDir: string
  codexHomeDir: string
  codexRolloutRoot: string
  codexRolloutTraceRoot: string
} {
  const base = harnessStateBase(port)
  const discoveryHomeDir = join(base, 'home')
  const codexHomeDir = join(discoveryHomeDir, '.codex')
  return {
    base,
    stateDir: join(base, 'state'),
    abducoSocketDir: join(base, 'abduco'),
    tmuxTmpDir: join(base, 'tmux'),
    discoveryHomeDir,
    codexHomeDir,
    codexRolloutRoot: join(codexHomeDir, 'sessions'),
    codexRolloutTraceRoot: join(codexHomeDir, 'rollout-traces'),
  }
}

export interface RealAgentCodexEnvOptions {
  /** Test hook: the native home containing the default .codex/auth.json. */
  sourceHomeDir?: string
  /** Test hook: the native Codex home from which auth.json is copied. */
  sourceCodexHomeDir?: string
}

/**
 * Give opt-in real-agent browser runs an empty Codex history while retaining the
 * native login needed to exercise the real CLI. The daemon's discovery override
 * points at discoveryHomeDir, so scanner + live observer resolve the same private
 * `.codex` tree that the spawned CLI sees through CODEX_HOME. [spec:SP-9257]
 */
export function applyRealAgentCodexEnv(
  port: number,
  options: RealAgentCodexEnvOptions = {},
): ReturnType<typeof harnessEnv> {
  const dirs = harnessEnv(port)
  const sourceHomeDir = options.sourceHomeDir ?? homedir()
  // Capture the inherited Codex home before replacing it. A developer may already
  // select a non-default native account with CODEX_HOME; that is the auth to reuse.
  const sourceCodexHomeDir =
    options.sourceCodexHomeDir ?? (process.env.CODEX_HOME?.trim() || join(sourceHomeDir, '.codex'))
  const sourceAuth = join(sourceCodexHomeDir, 'auth.json')
  const isolatedAuth = join(dirs.codexHomeDir, 'auth.json')

  if (!existsSync(sourceAuth)) {
    throw new Error(
      `PODIUM_E2E_REAL_AGENTS=1 requires a native Codex login at ${sourceAuth}; run codex login first`,
    )
  }

  // Keep credential-bearing test state private even on a shared /tmp. chmod is
  // deliberate after recursive mkdir: an existing dir may have been created with
  // a wider umask before a failed run.
  for (const dir of [dirs.base, dirs.discoveryHomeDir, dirs.codexHomeDir, dirs.codexRolloutRoot]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  copyFileSync(sourceAuth, isolatedAuth, constants.COPYFILE_EXCL)
  chmodSync(isolatedAuth, 0o600)

  process.env.CODEX_HOME = dirs.codexHomeDir
  // This optional Codex diagnostic trace is separate from sessions/. If an outer
  // Codex process enabled it, keep the child harness from writing into that live root.
  if (process.env.CODEX_ROLLOUT_TRACE_ROOT?.trim()) {
    mkdirSync(dirs.codexRolloutTraceRoot, { recursive: true, mode: 0o700 })
    chmodSync(dirs.codexRolloutTraceRoot, 0o700)
    process.env.CODEX_ROLLOUT_TRACE_ROOT = dirs.codexRolloutTraceRoot
  }
  return dirs
}

/** SIGTERM every abduco master and tmux server inside the harness dirs, then wipe. */
export function reapHarnessSessions(port: number): void {
  const { base, abducoSocketDir, tmuxTmpDir } = harnessEnv(port)

  // abduco: the listing both reveals master pids and reaps stale sockets. Masters
  // must be signalled BEFORE the directory is removed — an unlinked socket leaves
  // an orphan master that no listing can see again.
  //
  // DANGER, learned the hard way (2026-06-13): abduco 0.6 silently falls back to
  // the REAL socket dir (~/.abduco etc.) when ABDUCO_SOCKET_DIR does not exist,
  // and then the listing shows the developer's LIVE agent sessions in the
  // pid-bearing format — which this loop would SIGTERM. This dir is always
  // missing at startup (the previous reap rmSync'd it), so every e2e run killed
  // every real podium agent on the machine. Two guards: create the dir before
  // listing (pins abduco's primary dir), and only kill pids whose session socket
  // actually exists inside the isolated dir.
  try {
    mkdirSync(abducoSocketDir, { recursive: true })
    // abduco 0.6 nests sockets under `abduco/<user>/` inside $ABDUCO_SOCKET_DIR
    // (layout varies by version) — walk the whole tree so the guard recognizes
    // our sessions wherever the sockets actually land.
    const socketFiles = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? socketFiles(join(d, e.name)) : [e.name],
      )
    const ourSockets = new Set(
      socketFiles(abducoSocketDir).flatMap((f) => [f, f.split('@')[0] ?? f]),
    )
    const listing = () =>
      spawnSync('abduco', [], {
        encoding: 'utf8',
        env: { ...process.env, ABDUCO_SOCKET_DIR: abducoSocketDir },
      }).stdout ?? ''
    const ours = (out: string): { pid: number; name: string }[] => {
      const found: { pid: number; name: string }[] = []
      for (const line of out.split('\n')) {
        const fields = line.split('\t')
        const pid = Number.parseInt(fields[2]?.trim() ?? '', 10)
        const name = fields[3]?.trim() ?? ''
        if (
          fields.length >= 4 &&
          !Number.isNaN(pid) &&
          !line.trimStart().startsWith('+') &&
          ourSockets.has(name)
        ) {
          found.push({ pid, name })
        }
      }
      return found
    }
    const targets = ours(listing())
    for (const t of targets) {
      try {
        process.kill(t.pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
    if (targets.length > 0) {
      // An idle master parks in poll() and may never observe the pending
      // SIGTERM. Listing again connects to every socket — that wake is when
      // the quit flag gets processed. SIGKILL whatever still ignores us:
      // killing the master drops the PTY, which takes the agent down too.
      listing()
      const deadline = Date.now() + 1500
      let alive = targets
      while (alive.length > 0 && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
        alive = alive.filter((t) => {
          try {
            process.kill(t.pid, 0)
            return true
          } catch {
            return false
          }
        })
      }
      for (const t of alive) {
        try {
          process.kill(t.pid, 'SIGKILL')
        } catch {
          // raced to death
        }
      }
      // Do not start removing socket/state trees while a just-SIGKILLed master
      // can still be unwinding its child PTY. This wait is bounded because a
      // zombie may remain visible to kill(pid, 0) until its parent reaps it.
      const killedDeadline = Date.now() + 500
      while (alive.some((t) => processIsAlive(t.pid)) && Date.now() < killedDeadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
  } catch {
    // abduco not installed — nothing of ours can be running under it
  }

  // tmux: one server per -L label, sockets under $TMUX_TMPDIR/tmux-<uid>/.
  try {
    const sockRoot = join(tmuxTmpDir, `tmux-${process.getuid?.() ?? 0}`)
    if (existsSync(sockRoot)) {
      for (const sock of readdirSync(sockRoot)) {
        try {
          execFileSync('tmux', ['-S', join(sockRoot, sock), 'kill-server'], { stdio: 'ignore' })
        } catch {
          // server already dead
        }
      }
    }
  } catch {
    // tmux not installed
  }

  // Node retries ENOTEMPTY/EBUSY/EPERM only when maxRetries is non-zero. Writers
  // should already be stopped, but a dying process or filesystem lag can still
  // leave a short removal race; bound it rather than replacing the test result.
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

/** Create the isolation dirs and point this process's env at them. */
export function applyHarnessEnv(port: number): ReturnType<typeof harnessEnv> {
  const dirs = harnessEnv(port)
  for (const d of [dirs.stateDir, dirs.abducoSocketDir, dirs.tmuxTmpDir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 })
  }
  chmodSync(dirs.base, 0o700)
  process.env.ABDUCO_SOCKET_DIR = dirs.abducoSocketDir
  process.env.TMUX_TMPDIR = dirs.tmuxTmpDir
  process.env.PODIUM_STATE_DIR = dirs.stateDir
  // When the harness itself runs inside a Podium-launched shell (agents in a
  // Podium session), the parent exports PODIUM_WEB_DIR pointing at the
  // INSTALLED web bundle. Inheriting it would make the e2e server serve that
  // stale build instead of the apps/web/dist the suite just built — so drop it
  // and let server.ts fall back to the repo-relative dist.
  delete process.env.PODIUM_WEB_DIR
  return dirs
}
