import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * WHERE HEAD WAS, so a poll with nothing to do costs nothing.
 *
 * `/version` asks the publisher to name the current identity target on every
 * read, from every client. Naming and explaining that target can read HEAD
 * several times per request.
 * Measured on the development host, `git rev-parse --short=7 HEAD` costs 7.9 ms
 * a call, so a settled repository was paying 16–31 ms of `fork()` per poll to
 * be told nothing had changed. Off the event loop since POD-2048, but a fork
 * from a server process with a large heap is never free, and it competes with
 * every agent session on the box.
 *
 * WHAT IS AND IS NOT WORTH CACHING HERE. The expensive-looking calls are the
 * two full-tree walks in `assertSourceMatchesHead` (~280 ms together), but they
 * are already rate-limited: `decideDevBuild` turns a request away as
 * `up-to-date` or `debounced` before they run, so over ten polls they execute
 * ONCE. They are also uncacheable in principle — their input is the entire
 * working tree, and the identity gate they serve must fail closed. The work
 * that actually repeats is the cheap call, and it repeats forever. So this
 * caches the sha (POD-2052).
 *
 * HOW IT KNOWS. Not a timer: the files git itself would have to change to move
 * HEAD. `<gitdir>/HEAD` names the branch, the branch tip is a loose file under
 * `refs/` or an entry in `packed-refs`, and a commit, merge, checkout, reset or
 * repack has to touch one of them. Reading those costs 0.31 ms — 25× cheaper
 * than the spawn — and is exact rather than approximate.
 *
 * It is a change DETECTOR, never a parser: the loose ref usually holds the sha
 * outright, and this deliberately does not take it. Answering from these files
 * would mean reimplementing git's ref resolution — packed refs, symref chains,
 * replace refs — and being subtly wrong about it. Git stays the source of the
 * answer; these files only say whether the answer can have changed.
 *
 * A TTL sits over the top anyway, because "exact" here means "exact if this
 * module reads git's layout correctly", and a wrong reading would otherwise
 * serve one stale sha for the lifetime of the process. The ceiling turns that
 * class of mistake into a stale answer for at most one window.
 *
 * ANY CONFUSION FALLS BACK TO ASKING GIT. Every failure below — an unreadable
 * `.git`, a layout this does not recognise, a stat that fails for a reason
 * other than absence — produces a null stamp, which is never cached and always
 * re-reads. The cache is an accelerator; it is never the source of truth.
 */

/** How long a stamped sha may be trusted before git is asked again regardless. */
export const DEFAULT_HEAD_STAMP_TTL_MS = 30_000

/** The two directories a HEAD stamp is read from. */
export interface GitRefLocations {
  /** This worktree's git dir — holds `HEAD`. */
  gitDir: string
  /** The shared dir — holds `refs/` and `packed-refs`. */
  commonDir: string
}

/**
 * Find them without spawning git.
 *
 * An ordinary checkout has a `.git` DIRECTORY that is both. A linked worktree
 * has a `.git` FILE pointing at `<repo>/.git/worktrees/<name>`, which keeps its
 * own HEAD and names the shared directory in a `commondir` file beside it —
 * so a server running from a worktree (every issue branch on this host) has to
 * stamp two different trees.
 *
 * Null for anything else, including a root that is not a checkout at all.
 */
export async function locateGitRefs(root: string): Promise<GitRefLocations | null> {
  const dotGit = join(root, '.git')
  let gitDir: string
  try {
    if ((await stat(dotGit)).isDirectory()) {
      gitDir = dotGit
    } else {
      const pointer = (await readFile(dotGit, 'utf8')).trim()
      if (!pointer.startsWith('gitdir:')) return null
      const target = pointer.slice('gitdir:'.length).trim()
      if (!target) return null
      gitDir = resolve(root, target)
    }
  } catch {
    return null
  }
  try {
    // Relative to the git dir, and absent in an ordinary checkout — where the
    // two directories are the same one.
    const common = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    if (common) return { gitDir, commonDir: resolve(gitDir, common) }
  } catch {
    // Not a linked worktree.
  }
  return { gitDir, commonDir: gitDir }
}

/**
 * A small file's CONTENTS, or `-` when it is not there.
 *
 * Contents rather than a stat, and that is not fussiness. A ref file is forty
 * hex characters plus a newline — always exactly that size — so a stat-based
 * stamp comes down to the timestamp, and the kernel updates mtime from a coarse
 * clock (a few milliseconds). Two ref writes inside one tick are therefore
 * indistinguishable by stat, which showed up here as a test that passed or
 * failed depending on whether the two writes straddled a tick. Reading the
 * forty-one bytes costs about what stat-ing them costs and cannot be fooled.
 *
 * Absence is an answer too, and a stable one: a branch that lives only in
 * `packed-refs` has no loose file, and it staying absent is information.
 */
async function fileContent(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '-'
    // Anything else is a question this cannot answer, not an answer of "gone".
    throw error
  }
}

/**
 * A large file's identity.
 *
 * `packed-refs` holds every ref in the repository and is far too big to read on
 * a poll, so this one is stat-ed. It is also rewritten wholesale and rarely —
 * by `gc`, `pack-refs`, some fetches — rather than forty bytes at a time, so
 * size and timestamp separate its versions where they could not separate a ref
 * file's. The TTL ceiling covers what is left.
 */
async function fileStamp(path: string): Promise<string> {
  try {
    const entry = await stat(path, { bigint: true })
    return `${entry.ino}:${entry.size}:${entry.mtimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '-'
    throw error
  }
}

/**
 * A string that changes whenever HEAD could have moved, or null when that
 * cannot be established.
 */
export async function readHeadStamp(where: GitRefLocations): Promise<string | null> {
  try {
    const head = (await readFile(join(where.gitDir, 'HEAD'), 'utf8')).trim()
    // Detached: HEAD holds the commit itself, so its contents ARE the stamp and
    // no ref file comes into it.
    if (!head.startsWith('ref:')) return head === '' ? null : `head=${head}`
    const ref = head.slice('ref:'.length).trim()
    // A ref path is `refs/...`; anything that could climb out of the ref store
    // is a HEAD this does not understand.
    if (!ref.startsWith('refs/') || ref.split('/').includes('..')) return null
    // Both, because a tip may live loose, or packed, or move between the two
    // under `git gc` without the branch having moved at all.
    return [
      `ref=${ref}`,
      `loose=${await fileContent(join(where.commonDir, ref))}`,
      `packed=${await fileStamp(join(where.commonDir, 'packed-refs'))}`,
    ].join('|')
  } catch {
    return null
  }
}

export interface HeadShaCache {
  /** HEAD — from the last read when nothing can have moved it since. */
  read(): Promise<string>
  /** Forget it. The next read asks git. */
  invalidate(): void
}

export function createHeadShaCache(deps: {
  /** The real read. Spawns git. */
  read: () => Promise<string>
  /** The cheap "could it have moved?" stamp. Null means "cannot tell". */
  stamp: () => Promise<string | null>
  ttlMs?: number
  now?: () => number
}): HeadShaCache {
  const ttlMs = deps.ttlMs ?? DEFAULT_HEAD_STAMP_TTL_MS
  const now = deps.now ?? Date.now
  let held: { sha: string; stamp: string; at: number } | null = null
  let inFlight: Promise<string> | null = null

  const fromGit = async (): Promise<string> => {
    // STAMP FIRST, then read — never concurrently, and never the other way
    // round. Taking the stamp after the read could pair a sha from before a
    // commit with a stamp from after it, and that pair looks valid forever.
    // This order can only make the opposite mistake: a fresh sha held under a
    // stamp that has already moved on, which the next reader simply re-reads.
    const stamp = await deps.stamp()
    const sha = await deps.read()
    // A stamp that could not be taken is not one to trust. Hold nothing, so the
    // next reader asks git again — the pre-cache behaviour, exactly.
    held = stamp === null ? null : { sha, stamp, at: now() }
    return sha
  }

  return {
    read() {
      // A second caller arriving mid-read joins it rather than forking its own
      // git. `/version` reads HEAD several times per poll.
      if (inFlight) return inFlight
      const request = (async () => {
        // The ceiling is measured from the last READ, not the last hit — a hit
        // that refreshed it would push the ceiling out forever and there would
        // be no ceiling.
        if (held !== null && now() - held.at < ttlMs) {
          const stamp = await deps.stamp()
          if (stamp !== null && stamp === held.stamp) return held.sha
        }
        return fromGit()
      })()
      inFlight = request
      void request.then(
        () => {
          inFlight = null
        },
        () => {
          inFlight = null
        },
      )
      return request
    },
    invalidate() {
      held = null
    },
  }
}

/** The cache wired to a real checkout. */
export function createGitHeadShaCache(
  root: string,
  read: () => Promise<string>,
  options: { ttlMs?: number; now?: () => number } = {},
): HeadShaCache {
  // Located once — a checkout does not move its ref store while the server
  // runs. A FAILURE is not remembered, so a root that is not readable at boot
  // does not disable the stamp for the lifetime of the process.
  let located: Promise<GitRefLocations | null> | null = null
  return createHeadShaCache({
    read,
    stamp: async () => {
      located ??= locateGitRefs(root)
      const where = await located
      if (where === null) {
        located = null
        return null
      }
      return readHeadStamp(where)
    },
    ...options,
  })
}
