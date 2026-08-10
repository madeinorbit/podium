/**
 * Lock-name rules [spec:SP-85d1], stated once for every surface that accepts a
 * lock name (the server registry's zod schema, the `merge-lock` argv sugar, the
 * agent-facing prime text).
 *
 * WHY THIS FILE EXISTS (POD-672). The lock namespace is deliberately free-form —
 * `test:heavy`, a migration number, a dev server — and that is worth keeping.
 * But free-form also meant the ONE lock with a fixed meaning had two spellings:
 * on 2026-08-10 one session held `merge` while another held `merge:main`, each
 * believing it held the main-branch merge mutex. Two independent leases, no
 * queue between them, and the second session reset away the first's landing.
 *
 * A lock that serialises nothing fails silently by construction: `acquire`
 * succeeds, `status` reports the name free, and the damage only surfaces later
 * in someone else's history. So the merge namespace is RESERVED: `merge:<branch>`
 * is the only accepted spelling and every near-miss is refused at acquire time
 * with the canonical name in the error. Refusing beats aliasing here — an alias
 * would keep working and keep teaching the wrong name.
 */

/**
 * Characters a lock name may use. Names are interpolated into agent mail and the
 * durable event log, so they stay printable, short, and free of control chars.
 * The charset covers `merge:<branch>` for real branch names (slashes, dots,
 * dashes, underscores); the first char is alphanumeric so a name can never be
 * mistaken for a flag.
 */
export const LOCK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

export const LOCK_NAME_PATTERN_MESSAGE =
  'lock names allow letters, digits and - _ : . / (starting with a letter or digit)'

export const LOCK_NAME_MAX_LENGTH = 200

/** The reserved prefix of the branch-scoped merge mutex. */
export const MERGE_LOCK_PREFIX = 'merge:'

/** Branch the `merge-lock` sugar assumes when `--branch` is not passed. */
export const DEFAULT_MERGE_LOCK_BRANCH = 'main'

/** Ref namespaces that name the same branch by another route. Keying the mutex
 *  on any of them would split it again — exactly the POD-672 failure. */
const REF_PREFIXES = ['refs/heads/', 'refs/remotes/', 'remotes/', 'heads/']

/**
 * Local branch name for a merge lock: strips the `refs/heads/` spelling so
 * `--branch refs/heads/main` and `--branch main` reach the same lease. Anything
 * else is returned untouched — `mergeLockNameProblem` is what refuses it.
 */
export function normalizeMergeLockBranch(branch: string): string {
  const trimmed = branch.trim()
  return trimmed.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed
}

/** The canonical lock name for landing on `branch`. */
export function mergeLockName(branch: string = DEFAULT_MERGE_LOCK_BRANCH): string {
  return `${MERGE_LOCK_PREFIX}${normalizeMergeLockBranch(branch)}`
}

/** Is `name` the canonical merge mutex for some branch? */
export function isMergeLockName(name: string): boolean {
  return name.startsWith(MERGE_LOCK_PREFIX) && mergeLockNameProblem(name) == null
}

const CANONICAL_HINT =
  "the merge mutex is branch-scoped and canonically named 'merge:<branch>' — use `podium merge-lock acquire --wait` (sugar for 'merge:main'), or `podium lock acquire merge:<branch>` for another branch"

/**
 * Why `name` may not be used, or null when it is fine.
 *
 * Only the `merge` namespace is constrained; every other name stays free-form.
 * The check is case-insensitive on the prefix because `Merge:main` would be a
 * third independent lease under the store's exact-match key.
 */
export function mergeLockNameProblem(name: string): string | null {
  if (!/^merge/i.test(name)) return null

  const branch = name.slice(MERGE_LOCK_PREFIX.length)
  if (!name.startsWith(MERGE_LOCK_PREFIX)) {
    return `'${name}' is a near-miss of the merge mutex but not the merge mutex: ${CANONICAL_HINT}. A near-miss takes a SECOND, independent lease and serialises against nothing.`
  }
  if (branch === '') {
    return `'${name}' names no branch: ${CANONICAL_HINT}.`
  }
  for (const prefix of REF_PREFIXES) {
    if (branch.startsWith(prefix)) {
      const local = branch.slice(prefix.length)
      return `'${name}' keys the merge mutex on a ref path rather than a branch — use '${mergeLockName(local || DEFAULT_MERGE_LOCK_BRANCH)}'.`
    }
  }
  if (branch.startsWith('origin/')) {
    return `'${name}' keys the merge mutex on a remote-tracking ref — landing moves the LOCAL branch, so use '${mergeLockName(branch.slice('origin/'.length))}'.`
  }
  return null
}

/**
 * Full validation for a lock name: charset, length, then the reserved merge
 * namespace. Returns an error message, or null when the name is acceptable.
 */
export function lockNameProblem(name: string): string | null {
  if (name.length === 0) return 'lock name is required'
  if (name.length > LOCK_NAME_MAX_LENGTH) {
    return `lock name is longer than ${LOCK_NAME_MAX_LENGTH} characters`
  }
  if (!LOCK_NAME_PATTERN.test(name)) return LOCK_NAME_PATTERN_MESSAGE
  return mergeLockNameProblem(name)
}
