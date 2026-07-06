import { execFile } from 'node:child_process'

/** `git -C cwd rev-parse --show-toplevel` — the root of the worktree containing
 *  `cwd`, or null when `cwd` isn't inside a git worktree (or git is missing). */
export function gitToplevel(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { timeout: 5_000 },
      (err, stdout) => {
        const out = stdout?.trim()
        resolve(!err && out ? out : null)
      },
    )
  })
}

/** Bound the cwd→root cache: a long-lived daemon sees a finite set of directories,
 *  but a pathological agent that cds through thousands of dirs must not grow the
 *  map forever. FIFO eviction is fine — this is a dedup cache, not a hot path. */
const CACHE_MAX = 512

export interface CwdResolver {
  /** Worktree root containing `cwd`, or `cwd` itself when not in a git worktree. */
  resolve(cwd: string): Promise<string>
}

/** Memoized cwd → git-worktree-root resolution. Lookup failures (non-git dir,
 *  git error) resolve to the raw cwd so grouping degrades to prior behavior. */
export function createCwdResolver(opts?: {
  toplevel?: (cwd: string) => Promise<string | null>
}): CwdResolver {
  const toplevel = opts?.toplevel ?? gitToplevel
  const cache = new Map<string, Promise<string>>()
  return {
    resolve(cwd) {
      let hit = cache.get(cwd)
      if (!hit) {
        hit = toplevel(cwd).then(
          (root) => root ?? cwd,
          () => cwd,
        )
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(cwd, hit)
      }
      return hit
    },
  }
}

export interface SessionCwdTracker {
  /** Feed one hook payload's cwd; resolves it to a worktree root and emits
   *  `send` only when the session's resolved root actually changes. */
  onHookCwd(sessionId: string, cwd: string): Promise<void>
  /** Agent-declared worktree (`podium worktree` via the loopback relay). Resolves
   *  `path` to its worktree root, sends if it differs from the last sent root,
   *  supersedes any in-flight hook resolution, and returns the resolved root.
   *  The pin is STICKY: hook-observed cwds can no longer re-home the session
   *  (a `cd` into another checkout for one command doesn't bounce it); only a
   *  new `podium worktree` (or session exit) moves it again. */
  setExplicit(sessionId: string, path: string): Promise<string>
  /** Forget a session (on exit) so a respawn re-reports from scratch. */
  clear(sessionId: string): void
}

/**
 * Per-session cwd → worktree-root change tracker feeding `sessionCwd` sends.
 *
 * Why resolve at all: hook payloads carry the agent's LIVE shell directory, which
 * follows every `cd` — including into subdirectories of the same worktree. The
 * server groups sessions by this value, so restamping raw cwds makes a session
 * vanish from its worktree's tab strip the moment the agent cds into `packages/x`.
 * Resolving to the containing worktree root means only genuine worktree moves
 * (EnterWorktree, cd into another checkout) regroup the session.
 *
 * Two dedup layers: raw cwd (skip re-resolving the dir we're already in) and
 * resolved root (a subdir cd resolves to the same root → no send). A per-session
 * sequence number drops stale async resolutions so a slow git call for an old cwd
 * can't overwrite a newer one.
 */
export function createSessionCwdTracker(opts: {
  resolver: CwdResolver
  send: (sessionId: string, cwd: string) => void
}): SessionCwdTracker {
  const lastRawCwd = new Map<string, string>()
  const lastSentRoot = new Map<string, string>()
  const seq = new Map<string, number>()
  // Sessions whose worktree was declared explicitly (`podium worktree`): the
  // declaration wins over hook-observed wandering — see setExplicit docs.
  const pinned = new Set<string>()
  return {
    async onHookCwd(sessionId, cwd) {
      if (pinned.has(sessionId)) return
      if (lastRawCwd.get(sessionId) === cwd) return
      lastRawCwd.set(sessionId, cwd)
      const mySeq = (seq.get(sessionId) ?? 0) + 1
      seq.set(sessionId, mySeq)
      const root = await opts.resolver.resolve(cwd)
      if (seq.get(sessionId) !== mySeq) return // a newer cwd superseded this one
      if (lastSentRoot.get(sessionId) === root) return
      lastSentRoot.set(sessionId, root)
      opts.send(sessionId, root)
    },
    async setExplicit(sessionId, path) {
      // Bump the sequence so an in-flight hook resolution can't overwrite this,
      // and reset the raw-cwd dedup so the NEXT hook cwd is re-evaluated (a hook
      // resolving to the same root then stays quiet via the root dedup below).
      seq.set(sessionId, (seq.get(sessionId) ?? 0) + 1)
      lastRawCwd.delete(sessionId)
      pinned.add(sessionId)
      const root = await opts.resolver.resolve(path)
      if (lastSentRoot.get(sessionId) !== root) {
        lastSentRoot.set(sessionId, root)
        opts.send(sessionId, root)
      }
      return root
    },
    clear(sessionId) {
      lastRawCwd.delete(sessionId)
      lastSentRoot.delete(sessionId)
      seq.delete(sessionId)
      pinned.delete(sessionId)
    },
  }
}
