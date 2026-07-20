import type { IssueGitState } from '@podium/protocol'

/**
 * View-model for the git stamp [POD-98] — the pure half of GitStamp.tsx so the
 * state ladder is testable without DOM. One grammar, three densities:
 * `chip` (pane header: branch + dot + counters), `stamp` (sidebar line-2:
 * dot + counters only), `footer` (tray card: branch + dot + counters + age).
 *
 * Two axes, per the POD-98 proposal:
 * - merge axis (`↑N`, `merged`) — only on a PRIVATE issue worktree, where the
 *   branch is destined to merge into parentBranch;
 * - task axis (`✓N commits`, `+N yours`) — attributed counters, the only
 *   truthful ones on a shared checkout (main / long-lived branches).
 */
export type GitStampDot = 'loading' | 'none' | 'dirty' | 'clean'

export interface GitStampModel {
  /** 'hidden' = no checkout to describe; render nothing. */
  kind: 'hidden' | 'loading' | 'ready'
  /** Checkout branch (chip/footer densities show it; stamp omits it). */
  branch: string | null
  /** Commit-state dot — the one glyph every density carries. */
  dot: GitStampDot
  /** True while a probe is in flight WITH previous data still shown. */
  refreshing: boolean
  /** Issue has a private branch but the checkout dirties a shared one. */
  mismatch: boolean
  /** Merge axis: `↑N` (private worktree only, N > 0). */
  ahead?: number
  /** Task axis: attributed commit count (shared checkout, N > 0). */
  commits?: number
  /** Uncommitted count: dirtyOwn when attributed, dirtyFiles otherwise. */
  dirty?: number
  /** Dirty counter suffix: 'yours' when attributed on a shared checkout. */
  dirtyLabel: 'files' | 'yours'
  /** Some of the task's commits are not on the upstream yet. */
  unpushed: boolean
  /** Branch fully landed on parentBranch — chip relaxes to `✓ merged`. */
  merged: boolean
  /** Muted trailing note ('no commits' / 'no changes' / 'clean'). */
  note?: string
  /** Full hover title: branch, counters, fallback disclosure. */
  title: string
}

const EMPTY_TITLE = 'git status'

export function deriveGitStamp(
  issueBranch: string | null | undefined,
  git: IssueGitState | null | undefined,
): GitStampModel {
  if (!git) {
    return {
      kind: 'hidden',
      branch: null,
      dot: 'none',
      refreshing: false,
      mismatch: false,
      dirtyLabel: 'files',
      unpushed: false,
      merged: false,
      title: EMPTY_TITLE,
    }
  }
  // First probe still running: nothing truthful to show yet — shimmer.
  if (git.computing && git.updatedAt === '') {
    return {
      kind: 'loading',
      branch: git.branch,
      dot: 'loading',
      refreshing: false,
      mismatch: false,
      dirtyLabel: 'files',
      unpushed: false,
      merged: false,
      title: 'checking git status…',
    }
  }

  const attributed = !git.fallback && (git.commits !== undefined || git.dirtyOwn !== undefined)
  const commits = git.shared ? (git.commits?.length ?? 0) : 0
  const ahead = git.shared ? 0 : (git.ahead ?? 0)
  const dirty = git.shared && git.dirtyOwn !== undefined ? git.dirtyOwn : git.dirtyFiles
  const committed = git.shared ? commits > 0 : ahead > 0
  const merged = git.merged === true && !git.shared
  // Red is reserved for one anomaly: the issue HAS a private branch but its
  // checkout is dirtying a shared branch instead (POD-98 §01).
  const mismatch =
    issueBranch != null &&
    git.shared &&
    git.branch !== null &&
    git.branch !== issueBranch &&
    dirty > 0

  const dot: GitStampDot = dirty > 0 ? 'dirty' : committed || merged ? 'clean' : 'none'
  const note = merged
    ? undefined
    : !committed && dirty === 0
      ? git.shared
        ? 'no changes'
        : 'no commits'
      : dirty === 0 && !git.shared
        ? 'clean'
        : undefined

  const unpushed = (git.unpushed ?? 0) > 0

  const titleParts: string[] = []
  if (git.branch) titleParts.push(git.branch)
  if (merged) titleParts.push('merged')
  if (ahead > 0) titleParts.push(`${ahead} ahead of parent`)
  if (commits > 0) titleParts.push(`${commits} commit${commits === 1 ? '' : 's'} by this task`)
  if (dirty > 0)
    titleParts.push(
      git.shared && attributed
        ? `${dirty} of this task's files uncommitted`
        : `${dirty} uncommitted`,
    )
  if (git.shared && attributed && git.dirtyFiles > dirty)
    titleParts.push(`+${git.dirtyFiles - dirty} more from other sessions`)
  if (unpushed) titleParts.push('not pushed')
  if (git.fallback) titleParts.push('checkout-level data (no per-task attribution)')
  if (mismatch) titleParts.push(`issue branch is ${issueBranch} — changes sit on ${git.branch}`)

  return {
    kind: 'ready',
    branch: git.branch,
    dot,
    refreshing: git.computing === true,
    mismatch,
    ahead: ahead > 0 ? ahead : undefined,
    commits: commits > 0 ? commits : undefined,
    dirty: dirty > 0 ? dirty : undefined,
    dirtyLabel: git.shared && attributed ? 'yours' : 'files',
    unpushed,
    merged,
    note,
    title: titleParts.length > 0 ? titleParts.join(' · ') : EMPTY_TITLE,
  }
}
