/**
 * Shared session-isolation plumbing for the e2e harness. Each invocation gets a
 * short, owned run root so concurrent same-port harnesses cannot share durable
 * state, sockets, or scratch repositories. The root is intentionally compact
 * because Unix socket paths have a strict length limit.
 *
 * Playwright SIGKILLs the webServer tree on shutdown, so an in-process handler
 * alone cannot be trusted to clean up; startup and globalTeardown reap only
 * roots carrying this harness's ownership marker.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const HARNESS_SHUTDOWN_GRACE_MS = 10_000
const HARNESS_FORCE_KILL_WAIT_MS = 1_000
const HARNESS_SHUTDOWN_POLL_MS = 50
const HARNESS_RUN_ID_ENV = 'PODIUM_E2E_RUN_ID'
const HARNESS_OWNER_FILE = '.podium-e2e-owner'
const HARNESS_OWNER_VERSION = 1
const GENERATED_RUN_ID_LENGTH = 8

interface HarnessOwner {
  version: typeof HARNESS_OWNER_VERSION
  port: number
  runId: string
  pid: number
  createdAt: number
}

/**
 * Give one Playwright/harness invocation a short identity. The identity is
 * carried in the environment to the webServer, browser workers, and teardown;
 * direct harness scripts mint it in their own process. It is deliberately
 * short because the directory also contains Unix socket paths.
 */
export function ensureHarnessRunId(): string {
  const existing = process.env[HARNESS_RUN_ID_ENV]?.trim()
  const runId = existing ? compactRunId(existing) : randomRunId()
  process.env[HARNESS_RUN_ID_ENV] = runId
  return runId
}

function randomRunId(): string {
  return randomUUID().replaceAll('-', '').slice(0, GENERATED_RUN_ID_LENGTH)
}

function compactRunId(value: string): string {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (compact.length > 0 && compact.length <= GENERATED_RUN_ID_LENGTH) return compact
  // An externally supplied long token must not be allowed to grow socket paths.
  return createHash('sha256').update(value).digest('hex').slice(0, GENERATED_RUN_ID_LENGTH)
}

/**
 * Host tmpdir is intentionally used instead of the per-file hermetic TMPDIR
 * container. This is a cross-process path contract: the webServer, browser
 * workers, and globalTeardown must all resolve the same short root.
 * Keep production TMPDIR at /tmp: current socket paths have only single-digit
 * headroom, and a TMPDIR roughly six characters longer can make session spawn
 * fail and surface only as a silent e2e output timeout. The short run id, not a
 * longer TMPDIR, provides per-run isolation.
 */
function harnessTmpRoot(): string {
  return process.env.PODIUM_TEST_HOST_TMPDIR?.trim() || tmpdir()
}

function harnessStateBaseFor(port: number, runId: string): string {
  return join(harnessTmpRoot(), `podium-e2e-${port}-${runId}`)
}

function harnessOwnerFile(base: string): string {
  return join(base, HARNESS_OWNER_FILE)
}

function readHarnessOwner(ownerFile: string): HarnessOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(ownerFile, 'utf8')) as Partial<HarnessOwner>
    if (
      value.version !== HARNESS_OWNER_VERSION ||
      !Number.isSafeInteger(value.port) ||
      typeof value.runId !== 'string' ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 1 ||
      !Number.isFinite(value.createdAt)
    ) {
      return undefined
    }
    return value as HarnessOwner
  } catch {
    return undefined
  }
}

function ownerMatches(
  owner: HarnessOwner | undefined,
  port: number,
  runId: string,
): owner is HarnessOwner {
  return owner?.port === port && owner.runId === runId
}

function ownsHarnessDir(dirs: ReturnType<typeof harnessEnv>): boolean {
  return ownerMatches(readHarnessOwner(dirs.ownerFile), dirs.port, dirs.runId)
}

/** Claim a run root before any state, socket, or scratch-repository files exist. */
function claimHarnessDir(dirs: ReturnType<typeof harnessEnv>): void {
  mkdirSync(dirs.base, { recursive: true, mode: 0o700 })
  const owner = readHarnessOwner(dirs.ownerFile)
  if (owner) {
    if (ownerMatches(owner, dirs.port, dirs.runId) && owner.pid === process.pid) return
    throw new Error(`e2e harness run root is already owned: ${dirs.base}`)
  }
  if (readdirSync(dirs.base).length > 0) {
    throw new Error(`e2e harness run root is unowned: ${dirs.base}`)
  }

  const nextOwner: HarnessOwner = {
    version: HARNESS_OWNER_VERSION,
    port: dirs.port,
    runId: dirs.runId,
    pid: process.pid,
    createdAt: Date.now(),
  }
  try {
    writeFileSync(dirs.ownerFile, `${JSON.stringify(nextOwner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    const existing = readHarnessOwner(dirs.ownerFile)
    if (existing && ownerMatches(existing, dirs.port, dirs.runId) && existing.pid === process.pid) {
      return
    }
    throw error
  }
  chmodSync(dirs.base, 0o700)
}

export function harnessStateBase(port: number, requestedRunId?: string): string {
  return harnessStateBaseFor(port, compactRunId(requestedRunId ?? ensureHarnessRunId()))
}

export function harnessPidFile(port: number, requestedRunId?: string): string {
  return join(harnessStateBase(port, requestedRunId), 'state', 'harness.pid')
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
  const dirs = harnessEnv(port)
  if (!ownsHarnessDir(dirs)) return
  const pidFile = join(dirs.stateDir, 'harness.pid')
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

export function harnessEnv(port: number, requestedRunId?: string): {
  port: number
  runId: string
  base: string
  ownerFile: string
  stateDir: string
  abducoSocketDir: string
  tmuxTmpDir: string
  discoveryHomeDir: string
  codexHomeDir: string
  codexRolloutRoot: string
  codexRolloutTraceRoot: string
} {
  const runId = compactRunId(requestedRunId ?? ensureHarnessRunId())
  const base = harnessStateBaseFor(port, runId)
  const discoveryHomeDir = join(base, 'home')
  const codexHomeDir = join(discoveryHomeDir, '.codex')
  return {
    port,
    runId,
    base,
    ownerFile: harnessOwnerFile(base),
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
  claimHarnessDir(dirs)
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

/**
 * SIGTERM every abduco master and tmux server inside the harness dirs, then wipe.
 * Callers validate the ownership marker before reaching this private helper.
 */
function reapHarnessSessionsOwned(dirs: ReturnType<typeof harnessEnv>): void {
  const { base, stateDir, abducoSocketDir, tmuxTmpDir } = dirs

  // The harness's daemon installs its own abduco under <state>/bin when none is
  // on PATH — the leaked masters run exactly that binary. Listing with a missing
  // `abduco` yields an empty listing, and the rmSync below would then unlink the
  // sockets and orphan every master invisibly. Prefer the harness's own copy.
  const harnessAbduco = join(stateDir, 'bin', 'abduco')
  const abducoBin = existsSync(harnessAbduco) ? harnessAbduco : 'abduco'

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
      spawnSync(abducoBin, [], {
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

export function reapHarnessSessions(port: number, requestedRunId?: string): void {
  const dirs = harnessEnv(port, requestedRunId)
  if (!ownsHarnessDir(dirs)) return
  reapHarnessSessionsOwned(dirs)
}

export function harnessScratchRepo(port: number, requestedRunId?: string): string {
  return join(harnessStateBase(port, requestedRunId), 'zz-podium-e2e-repo-' + port)
}

/** Reap only abandoned run roots carrying this harness's ownership marker. */
export function reapStaleHarnessDirs(_now: number = Date.now()): number[] {
  const reaped: number[] = []
  let entries: string[]
  try {
    entries = readdirSync(harnessTmpRoot())
  } catch {
    return reaped
  }

  for (const entry of entries) {
    const match = /^podium-e2e-([0-9]+)-([a-z0-9]+)$/.exec(entry)
    if (!match) continue
    const portText = match[1]
    const runId = match[2]
    if (portText === undefined || runId === undefined) continue
    const port = Number(portText)
    const dirs = harnessEnv(port, runId)
    const owner = readHarnessOwner(dirs.ownerFile)
    // A directory without a valid marker is not ours, even if its name looks
    // familiar. In particular, never age-delete a caller's similarly named dir.
    if (!ownerMatches(owner, port, runId)) continue
    if (owner.pid === process.pid || processIsAlive(owner.pid)) continue
    try {
      reapHarnessSessionsOwned(dirs)
      reaped.push(port)
    } catch {
      // best-effort: a half-removed dir heals on the next sweep
    }
  }
  return reaped
}

/**
 * Create the owned isolation dirs and point this process's in-process consumers at them.
 *
 * The returned `env` is the child-process boundary: Bun does not reliably observe later
 * process.env mutations, so every child launched by the harness must receive this snapshot.
 */
export function applyHarnessEnv(
  port: number,
  requestedRunId?: string,
): ReturnType<typeof harnessEnv> & { env: Record<string, string> } {
  // Every harness startup reaches this function. Sweep dead, explicitly owned
  // sibling roots before claiming this run so hard-killed sessions self-heal.
  reapStaleHarnessDirs()
  const dirs = harnessEnv(port, requestedRunId)
  claimHarnessDir(dirs)
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
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  delete env.PODIUM_WEB_DIR
  return { ...dirs, env }
}
