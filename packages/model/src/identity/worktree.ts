/** The worktree that CONTAINS `cwd`: the longest root with `cwd === root` or
 *  `cwd` under `root/`. Longest-match matters because a repo root contains its
 *  own `.worktrees/*` checkouts — a session in one belongs to the worktree, not
 *  the parent repo. Null when no root contains the cwd.
 *
 *  LINEAR SCAN. Resolving many cwds against the same root list — the sidebar's
 *  ownership index does exactly that, once per session over a root list that
 *  grows with the issue count — must build the roots ONCE with
 *  {@link buildWorktreeRootIndex} and call {@link worktreeForCwdIndexed}, which
 *  is O(path depth) instead of O(roots). POD-1641 measured this scan at 54% of
 *  main-thread SELF time across a multi-minute UI freeze. */
export function worktreeForCwd(cwd: string, worktreePaths: string[]): string | null {
  let best: string | null = null
  for (const root of worktreePaths) {
    if (cwd !== root && !cwd.startsWith(root.endsWith('/') ? root : `${root}/`)) continue
    if (best === null || root.length > best.length) best = root
  }
  return best
}

/**
 * One entry per root PATH, carrying the spellings that path was given.
 *
 * `a` and `a/` name one directory but are not interchangeable to the scan: for
 * a cwd of exactly `a`, the root `a/` does NOT match (`'a'.startsWith('a/')` is
 * false), while for anything under it both spellings match and the longer
 * string wins the scan's length comparison. Keeping both is what lets the
 * lookup reproduce the scan rather than approximate it.
 */
export interface WorktreeRootEntry {
  /** The root as spelled WITHOUT a trailing slash, if it was given that way. */
  readonly plain?: string
  /** The spelling to return for anything strictly INSIDE this root: the longest
   *  given, matching the scan's tie-break. */
  readonly inside: string
}

export type WorktreeRootIndex = ReadonlyMap<string, WorktreeRootEntry>

/** Strip one trailing slash so `a` and `a/` share an index key. `/` is
 *  preserved: it is a real (if pathological) root and `''` is not one. */
function normalizeRoot(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * Build the lookup {@link worktreeForCwdIndexed} reads. O(roots), once.
 *
 * CONTRACT: paths carry no empty segments (`/a//b`). Real cwds and `git
 * worktree list` output never do; a path that did would resolve to null here
 * where the scan found a root — an unattached session, never a misattributed
 * one.
 */
export function buildWorktreeRootIndex(worktreePaths: Iterable<string>): WorktreeRootIndex {
  const index = new Map<string, WorktreeRootEntry>()
  for (const root of worktreePaths) {
    const key = normalizeRoot(root)
    const existing = index.get(key)
    const plain = root === key ? root : existing?.plain
    const inside =
      existing === undefined || root.length > existing.inside.length ? root : existing.inside
    index.set(key, plain === undefined ? { inside } : { plain, inside })
  }
  return index
}

/** {@link worktreeForCwd} as a lookup: walk `cwd`'s ancestors longest-first and
 *  return the first that is a root. Identical answers, O(path depth) per call.
 *  The FIRST hit is the longest match, so no length comparison is needed. */
export function worktreeForCwdIndexed(cwd: string, roots: WorktreeRootIndex): string | null {
  let prefix = normalizeRoot(cwd)
  // The cwd's own directory is the only probe where spelling matters: a cwd
  // written without its trailing slash can only match a root written the same
  // way. Every ancestor below is a STRICT container, where both spellings
  // match and the longer one wins.
  const self = roots.get(prefix)
  if (self !== undefined) {
    const hit = cwd === prefix ? self.plain : self.inside
    if (hit !== undefined) return hit
  }
  while (prefix.length > 1) {
    const slash = prefix.lastIndexOf('/')
    if (slash < 0) return null
    // A cwd under the filesystem root ('/x') has '/' as its last ancestor.
    prefix = slash === 0 ? '/' : prefix.slice(0, slash)
    const entry = roots.get(prefix)
    if (entry !== undefined) return entry.inside
  }
  return null
}

/** Where `cwd` sits inside the worktree `root` that contains it — `''` at the
 *  root itself, else a relative path (`apps/web`). Containment is the caller's
 *  to establish (`worktreeForCwd`); an uncontained cwd reads as the root. */
export function worktreeSubpath(root: string, cwd: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return cwd.startsWith(prefix) ? cwd.slice(prefix.length) : ''
}
