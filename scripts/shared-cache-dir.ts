/**
 * One durable cache root per repository per host, shared by every sibling worktree.
 *
 * Two caches need this identity for the same reason (POD-1378, POD-3162): a cache
 * that lives inside the checkout is empty whenever the checkout is fresh, and the
 * builds that most need it — a release packaging from a detached /tmp worktree —
 * are exactly the ones that get a fresh checkout every time.
 *
 * The key is the COMMON GIT DIRECTORY, so linked worktrees of one repository land
 * in the same place and a result produced in one is readable from the next; that
 * sharing is the whole return on the cache. Two things used to threaten it. TMPDIR
 * is reminted per agent session and per test file in this repository, so an
 * XDG-less host silently gave every session its own cache and its own cold start;
 * and /tmp does not survive a reboot. $HOME/.cache — the XDG default — is stable
 * for both, so it is preferred over the temporary directory, which now only
 * catches a host with no usable home.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** realpath, but a path that does not exist is still a usable identity, not a crash. */
function stableRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function projectCacheIdentity(root: string): string {
  const dotGit = join(root, '.git')
  if (!existsSync(dotGit)) return stableRealpath(root)
  const stat = statSync(dotGit)
  const statTarget = stat.isFile() ? readFileSync(dotGit, 'utf8') : ''
  const match = statTarget.match(/^gitdir: (.+)$/m)
  const gitDir = match ? (match[1] ?? '') : dotGit
  const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(root, gitDir)
  // A linked worktree's gitfile points at <common-git-dir>/worktrees/<name>.
  // Resolve this structurally instead of looking for a literal `worktrees` path segment:
  // bare repositories and Windows path separators are both legitimate.
  const worktreesParent = resolve(absoluteGitDir, '..', '..')
  if (
    stat.isFile() &&
    absoluteGitDir !== worktreesParent &&
    resolve(absoluteGitDir, '..').endsWith(`${sep}worktrees`)
  ) {
    return stableRealpath(worktreesParent)
  }
  return stableRealpath(absoluteGitDir)
}

/** 16 hex chars of the common git dir — the per-repository, per-host cache identity. */
export function projectCacheKey(root: string): string {
  return createHash('sha256').update(projectCacheIdentity(root)).digest('hex').slice(0, 16)
}

/**
 * `<cache base>/podium/<kind>/<projectKey>` for one cache family (`turbo`, `abduco`).
 *
 * Each base candidate is only valid when absolute. A relative value is treated as
 * unset: resolving it against each worktree would silently produce separate caches.
 */
export function sharedCacheDir(
  kind: string,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const cacheBase =
    [env.XDG_CACHE_HOME, home && join(home, '.cache')].find(
      (candidate): candidate is string => !!candidate && isAbsolute(candidate),
    ) ?? join(tmpdir(), 'podium-cache')
  return join(cacheBase, 'podium', kind, projectCacheKey(root))
}
