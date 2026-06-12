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
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function harnessStateBase(port: number): string {
  return join(tmpdir(), `podium-e2e-${port}`)
}

export function harnessEnv(port: number): {
  base: string
  stateDir: string
  abducoSocketDir: string
  tmuxTmpDir: string
} {
  const base = harnessStateBase(port)
  return {
    base,
    stateDir: join(base, 'state'),
    abducoSocketDir: join(base, 'abduco'),
    tmuxTmpDir: join(base, 'tmux'),
  }
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

  rmSync(base, { recursive: true, force: true })
}

/** Create the isolation dirs and point this process's env at them. */
export function applyHarnessEnv(port: number): ReturnType<typeof harnessEnv> {
  const dirs = harnessEnv(port)
  for (const d of [dirs.stateDir, dirs.abducoSocketDir, dirs.tmuxTmpDir]) {
    mkdirSync(d, { recursive: true })
  }
  process.env.ABDUCO_SOCKET_DIR = dirs.abducoSocketDir
  process.env.TMUX_TMPDIR = dirs.tmuxTmpDir
  process.env.PODIUM_STATE_DIR = dirs.stateDir
  return dirs
}
