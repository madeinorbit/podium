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
    const ourSockets = new Set(
      readdirSync(abducoSocketDir).flatMap((f) => [f, f.split('@')[0] ?? f]),
    )
    const out = spawnSync('abduco', [], {
      encoding: 'utf8',
      env: { ...process.env, ABDUCO_SOCKET_DIR: abducoSocketDir },
    }).stdout
    for (const line of (out ?? '').split('\n')) {
      const fields = line.split('\t')
      const pid = Number.parseInt(fields[2]?.trim() ?? '', 10)
      const name = fields[3]?.trim() ?? ''
      if (
        fields.length >= 4 &&
        !Number.isNaN(pid) &&
        !line.trimStart().startsWith('+') &&
        ourSockets.has(name)
      ) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // already gone
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
