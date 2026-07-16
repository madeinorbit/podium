import { execFile } from 'node:child_process'
import { basename, dirname, resolve as resolvePath } from 'node:path'

/** Where a directory sits in git's worktree layout [spec:SP-4ef9]:
 *  - `main`     — the repo's PRIMARY checkout. Never a workspace: agents step into
 *                 it to run one command (a merge, a fetch) and step back out.
 *  - `worktree` — a linked worktree (`git worktree add`). THE unit of workspace.
 *  - `none`     — not inside a git worktree at all. */
export type WorktreeKind = 'main' | 'worktree' | 'none'

export interface WorktreeInfo {
  /** Root of the worktree containing the cwd — the raw cwd when kind is 'none'. */
  root: string
  kind: WorktreeKind
  /** Root of the repo's primary checkout — the path issues carry as `repoPath`, so
   *  a caller can tell which repo `root` belongs to. Absent when kind is 'none', and
   *  for layouts whose common git dir isn't `<root>/.git` (a bare repo serving
   *  worktrees), where no primary checkout exists to name. */
  repoRoot?: string
}

function run(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5_000 }, (err, stdout) => {
      const out = stdout?.trim()
      resolve(!err && out ? out : null)
    })
  })
}

/** Classify `cwd` with one `git rev-parse`: its worktree root, and whether that root
 *  is the repo's main checkout or a linked worktree. Null when `cwd` isn't inside a
 *  git worktree (or git is missing).
 *
 *  Main vs linked is git's OWN distinction, not a podium heuristic: a linked worktree
 *  keeps a private git dir (`<repo>/.git/worktrees/<name>`) while sharing the repo's
 *  common dir, whereas in the primary checkout the two are one directory. Reading it
 *  from git means no repo-registry lookup, no daemon/server round trip, and a correct
 *  answer for repos podium has never scanned.
 *
 *  Both paths are resolved against `cwd` before comparing: git prints them relative
 *  to the directory it ran in (`.git` from a root, `../.git` from a subdirectory) and
 *  absolute only sometimes, so the raw strings differ even when the directory is the
 *  same. (`--path-format=absolute` would do this in git, but it needs git ≥ 2.31 and
 *  a silent misclassification on an older git is worse than resolving them here.) */
export function gitWorktree(cwd: string): Promise<WorktreeInfo | null> {
  return run(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], cwd).then(
    (out) => {
      const [root, gitDir, commonDir] = (out ?? '').split('\n').map((l) => l.trim())
      if (!root || !gitDir || !commonDir) return null
      const common = resolvePath(cwd, commonDir)
      const kind: WorktreeKind = resolvePath(cwd, gitDir) === common ? 'main' : 'worktree'
      const repoRoot = basename(common) === '.git' ? dirname(common) : undefined
      return { root, kind, ...(repoRoot ? { repoRoot } : {}) }
    },
    () => null,
  )
}

/** The branch checked out at `cwd` — null when detached, bare, or not a worktree.
 *  Deliberately UNCACHED, unlike a worktree's root and kind: a branch is mutable
 *  (the agent checks out another one), and a stale branch would be stamped onto an
 *  issue as fact. Only ever called when a session actually moves, so it's cold. */
export function gitBranch(cwd: string): Promise<string | null> {
  return run(['symbolic-ref', '--short', '-q', 'HEAD'], cwd)
}

/** Bound the cwd→root cache: a long-lived daemon sees a finite set of directories,
 *  but a pathological agent that cds through thousands of dirs must not grow the
 *  map forever. FIFO eviction is fine — this is a dedup cache, not a hot path. */
const CACHE_MAX = 512

export interface CwdResolver {
  /** Classify `cwd`; falls back to `{ root: cwd, kind: 'none' }` outside git. */
  resolve(cwd: string): Promise<WorktreeInfo>
}

/** Memoized cwd → worktree classification. Lookup failures (non-git dir, git error)
 *  resolve to the raw cwd so grouping degrades to prior behavior. Safe to cache
 *  indefinitely: a directory's worktree root, kind and repo are fixed for its
 *  lifetime — a linked worktree never becomes the main checkout. */
export function createCwdResolver(opts?: {
  lookup?: (cwd: string) => Promise<WorktreeInfo | null>
}): CwdResolver {
  const lookup = opts?.lookup ?? gitWorktree
  const cache = new Map<string, Promise<WorktreeInfo>>()
  return {
    resolve(cwd) {
      let hit = cache.get(cwd)
      if (!hit) {
        const raw: WorktreeInfo = { root: cwd, kind: 'none' }
        hit = lookup(cwd).then(
          (info) => info ?? raw,
          () => raw,
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

/** One `sessionCwd` send: the worktree a session now sits in, plus what the daemon
 *  knows about that directory — the daemon is the only side that can run git here. */
export interface SessionCwdUpdate {
  sessionId: string
  /** The resolved worktree root (not the raw cwd). */
  cwd: string
  kind: WorktreeKind
  /** Branch checked out there; only looked up for a real worktree. */
  branch?: string
  repoRoot?: string
  /** The agent DECLARED this worktree (`podium worktree`) rather than being observed
   *  wandering into it. */
  explicit?: boolean
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
  /** The cwd the SERVER launched this session in (spawn / reattach) — podium's own
   *  decision, known before the agent has run a single hook. A session launched in a
   *  real worktree is BORN pinned to it (POD-665): it never waits for a hook to learn
   *  its workspace, and no amount of later `cd` wandering can re-home it.
   *
   *  A launch in a MAIN checkout deliberately does NOT pin. Main is never a workspace
   *  [spec:SP-4ef9], so there is nothing to pin to — and leaving such a session free
   *  to follow its hooks is exactly what lets podium adopt a worktree the harness
   *  later creates for itself (POD-664).
   *
   *  Never sends: the server picked this cwd, so it already has it. */
  setLaunchCwd(sessionId: string, cwd: string): Promise<void>
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
  /** Branch lookup for a resolved worktree root. Injectable for tests; defaults to
   *  the real (uncached) git call. */
  branch?: (root: string) => Promise<string | null>
  send: (update: SessionCwdUpdate) => void
}): SessionCwdTracker {
  const lastRawCwd = new Map<string, string>()
  const lastSentRoot = new Map<string, string>()
  const seq = new Map<string, number>()
  // Sessions pinned to their worktree: by birth (setLaunchCwd) or by declaration
  // (`podium worktree`). A pin means hook-observed wandering can no longer re-home
  // the session — see setLaunchCwd / setExplicit docs.
  const pinned = new Set<string>()
  const lookupBranch = opts.branch ?? gitBranch

  /** Build the send for a resolved root. Only a real worktree gets a branch: main is
   *  never adopted as a workspace, and a non-git directory has no branch to read. */
  const update = async (
    sessionId: string,
    info: WorktreeInfo,
    explicit?: boolean,
  ): Promise<SessionCwdUpdate> => {
    const branch =
      info.kind === 'worktree' ? await lookupBranch(info.root).catch(() => null) : null
    return {
      sessionId,
      cwd: info.root,
      kind: info.kind,
      ...(branch ? { branch } : {}),
      ...(info.repoRoot ? { repoRoot: info.repoRoot } : {}),
      ...(explicit ? { explicit: true } : {}),
    }
  }

  return {
    async onHookCwd(sessionId, cwd) {
      if (pinned.has(sessionId)) return
      if (lastRawCwd.get(sessionId) === cwd) return
      lastRawCwd.set(sessionId, cwd)
      const mySeq = (seq.get(sessionId) ?? 0) + 1
      seq.set(sessionId, mySeq)
      const info = await opts.resolver.resolve(cwd)
      if (seq.get(sessionId) !== mySeq) return // a newer cwd superseded this one
      // A repo's MAIN checkout NEVER captures a session [spec:SP-4ef9]: a cd into it
      // is transient command-running by definition (`cd <main> && git merge …`), so
      // re-homing there would move the session out of the workspace it is actually
      // working in — and hand every unattached session to whatever issue happens to
      // own main [spec:SP-595b]. The raw-cwd dedup above still holds, so a session
      // parked in main doesn't re-resolve on every hook.
      if (info.kind === 'main') return
      if (lastSentRoot.get(sessionId) === info.root) return
      const next = await update(sessionId, info)
      if (seq.get(sessionId) !== mySeq) return // the branch lookup is another await
      lastSentRoot.set(sessionId, info.root)
      opts.send(next)
    },
    async setExplicit(sessionId, path) {
      // Bump the sequence so an in-flight hook resolution can't overwrite this,
      // and reset the raw-cwd dedup so the NEXT hook cwd is re-evaluated (a hook
      // resolving to the same root then stays quiet via the root dedup below).
      const mySeq = (seq.get(sessionId) ?? 0) + 1
      seq.set(sessionId, mySeq)
      lastRawCwd.delete(sessionId)
      pinned.add(sessionId)
      const info = await opts.resolver.resolve(path)
      // Explicit declarations ALWAYS send (no root dedup): beyond regrouping,
      // the server stamps the worktree onto the session's attached issue — which
      // must happen even when the session is already grouped under this root.
      const next = await update(sessionId, info, true)
      // …unless a NEWER declaration already superseded this one while we resolved:
      // sending now would land the two out of order and leave the server on the
      // stale one. The newer declaration does the stamping. Still return the root —
      // the caller asked what `path` resolves to, and that answer is unchanged.
      if (seq.get(sessionId) !== mySeq) return info.root
      lastSentRoot.set(sessionId, info.root)
      opts.send(next)
      return info.root
    },
    async setLaunchCwd(sessionId, cwd) {
      const mySeq = (seq.get(sessionId) ?? 0) + 1
      seq.set(sessionId, mySeq)
      const info = await opts.resolver.resolve(cwd)
      // Exited while we resolved: clear() dropped this session's state, so adding a
      // pin now would resurrect it — an entry no clear() will ever come back for.
      // A racing hook only BUMPS the sequence, so this tells the two apart.
      if (!seq.has(sessionId)) return
      // Pin even if a hook raced ahead of this resolution: where podium launched the
      // session outranks whatever directory its first hook happened to observe.
      if (info.kind === 'worktree') pinned.add(sessionId)
      // Record what the server already knows, so a hook arriving from this same
      // worktree stays quiet — but never clobber a newer root that won the race.
      if (seq.get(sessionId) === mySeq) lastSentRoot.set(sessionId, info.root)
    },
    clear(sessionId) {
      lastRawCwd.delete(sessionId)
      lastSentRoot.delete(sessionId)
      seq.delete(sessionId)
      pinned.delete(sessionId)
    },
  }
}
