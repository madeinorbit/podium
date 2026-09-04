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

/** True when `path` is a git directory: every one, common or per-worktree, carries HEAD. */
function isGitDir(path: string): boolean {
  return existsSync(join(path, 'HEAD'))
}

/**
 * The common repository for a git directory: `<common>/worktrees/<name>[/rest]` becomes
 * `<common>[/rest]`. The `rest` matters for a submodule checked out inside a linked
 * worktree, whose git directory is `<common>/worktrees/<name>/modules/<path>`; the main
 * checkout's copy of that submodule lives at `<common>/modules/<path>`, and the two are one
 * repository with one cache. The `worktrees` segment must sit directly under a git
 * directory: a checkout that merely lives in a folder called `worktrees` is left alone, and
 * bare repositories and Windows separators are both legitimate.
 */
export function commonGitDir(gitDir: string): string {
  const parts = resolve(gitDir).split(sep)
  for (let i = 1; i + 1 < parts.length; i += 1) {
    if (parts[i] !== 'worktrees') continue
    const parent = parts.slice(0, i).join(sep) || sep
    if (!isGitDir(parent)) continue
    return commonGitDir([...parts.slice(0, i), ...parts.slice(i + 2)].join(sep))
  }
  return parts.join(sep)
}

function projectCacheIdentity(root: string): string {
  const dotGit = join(root, '.git')
  if (!existsSync(dotGit)) return stableRealpath(root)
  if (!statSync(dotGit).isFile()) return stableRealpath(commonGitDir(dotGit))
  const match = readFileSync(dotGit, 'utf8').match(/^gitdir: (.+)$/m)
  const gitDir = match?.[1] ?? dotGit
  const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(root, gitDir)
  return stableRealpath(commonGitDir(absoluteGitDir))
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
