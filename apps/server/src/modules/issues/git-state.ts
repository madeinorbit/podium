import type { IssueGitState } from '@podium/protocol'

/**
 * Git-state probe [POD-98] — the pure half of the "has this task committed,
 * and on which branch?" feature. Composes read-only RepoOps (statusProbe /
 * revListCount / logHead / isMergedInto — all lock-free or exit-status-only)
 * into one IssueGitState. Attribution inputs (commit shas the harness captured
 * for the task's sessions, the task's touched-file set) are passed in; this
 * module never guesses them from checkout state.
 */

export interface GitProbeIo {
  repoOp(
    op: string,
    cwd: string,
    args?: Record<string, string>,
    machineId?: string,
  ): Promise<{ ok: boolean; output: string }>
}

export interface GitProbeTarget {
  /** Checkout to probe: the issue worktree, or the session cwd on shared work. */
  cwd: string
  /** True = multi-task checkout (no issue-owned worktree): merge axis off. */
  shared: boolean
  /** Issue's parent branch — the merge-axis base (private worktrees only). */
  parentBranch: string
  /** Issue's own branch, for the merged check. Null on shared checkouts. */
  branch: string | null
  machineId?: string
  /** Harness-attributed commit shas for this task's sessions. */
  commits?: string[]
  /** Harness-observed files this task's sessions touched (repo-relative). */
  touched?: ReadonlySet<string>
  /** ERE matching the issue's commit-message markers ([POD-98] subject tag /
   *  Podium-Issue trailer) — the restart-proof attribution source on shared
   *  checkouts: history remembers what the in-memory ledger forgets. */
  refsPattern?: string
}

/** Build the message-marker pattern for `logIssueCommits` from an issue's
 *  human ref (e.g. `POD-98` or `#98`). ERE special chars in the ref are
 *  escaped so `[POD-98]` matches literally. */
export function issueRefsPattern(ref: string): string {
  const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `Podium-Issue: ${esc}|\\[${esc}\\]`
}

/** Parse `git status --porcelain=v1 -b`: header `## branch...upstream` +
 *  one line per dirty path. Detached HEAD / unborn branches → branch null. */
export function parsePorcelainStatus(output: string): {
  branch: string | null
  dirtyPaths: string[]
} {
  const lines = output.split('\n').filter((l) => l.trim() !== '')
  const header = lines.find((l) => l.startsWith('## '))
  let branch: string | null = null
  if (header) {
    const name = header.slice(3).split('...')[0]?.trim() ?? ''
    // `## HEAD (no branch)` = detached; `## No commits yet on x` = unborn x.
    if (name.startsWith('No commits yet on ')) branch = name.slice('No commits yet on '.length)
    else if (name !== '' && !name.startsWith('HEAD')) branch = name
  }
  const dirtyPaths = lines
    .filter((l) => !l.startsWith('## '))
    .map((l) => {
      // Porcelain v1: `XY <path>` or `XY <from> -> <to>` for renames — the
      // post-rename path is the one that exists in the working tree.
      const p = l.slice(3)
      const arrow = p.indexOf(' -> ')
      return arrow >= 0 ? p.slice(arrow + 4) : p
    })
  return { branch, dirtyPaths }
}

/** Count of the task's touched files still dirty. Porcelain paths are relative
 *  to the repo root; touched paths may be absolute (harness cwd + file_path) —
 *  match on suffix so both spellings intersect. */
export function countDirtyOwn(dirtyPaths: string[], touched: ReadonlySet<string>): number {
  if (touched.size === 0) return 0
  const suffixes = [...touched]
  return dirtyPaths.filter((p) => suffixes.some((t) => t === p || t.endsWith(`/${p}`))).length
}

export async function probeGitState(
  io: GitProbeIo,
  target: GitProbeTarget,
  nowIso: string,
): Promise<IssueGitState> {
  const op = (
    name: string,
    args?: Record<string, string>,
  ): Promise<{ ok: boolean; output: string }> =>
    io.repoOp(name, target.cwd, args, target.machineId).catch(() => ({ ok: false, output: '' }))

  const [status, head, unpushedRes, aheadRes, refCommitsRes] = await Promise.all([
    op('statusProbe'),
    op('logHead'),
    // No upstream configured → rev-list fails → counter absent, never zero-lies.
    op('revListCount', { from: '@{u}', to: 'HEAD' }),
    target.shared
      ? Promise.resolve({ ok: false, output: '' })
      : op('revListCount', { from: target.parentBranch, to: 'HEAD' }),
    target.shared && target.refsPattern
      ? op('logIssueCommits', { grep: target.refsPattern })
      : Promise.resolve({ ok: false, output: '' }),
  ])

  const { branch, dirtyPaths } = parsePorcelainStatus(status.output)
  const ahead = !target.shared && aheadRes.ok ? Number.parseInt(aheadRes.output, 10) : Number.NaN
  const unpushed = unpushedRes.ok ? Number.parseInt(unpushedRes.output, 10) : Number.NaN

  // Merge-axis "landed" check, only worth a subprocess once nothing is ahead.
  // Containment alone can't tell "landed" from "fresh branch still sitting AT
  // its start point" (both are ancestors of the parent), so also require the
  // tip to have moved off the branch's creation point — the oldest reflog
  // entry. No reflog (unlikely on locally-created worktrees) → fall back to
  // the containment answer rather than never reporting merged.
  let merged = false
  if (!target.shared && ahead === 0 && target.branch !== null) {
    const res = await op('isMergedInto', {
      branch: target.branch,
      parentBranch: target.parentBranch,
    })
    if (res.ok) {
      const reflog = await op('branchReflog', { branch: target.branch })
      const shas = reflog.output.split('\n').filter(Boolean)
      const creationSha = shas[shas.length - 1]
      const tipSha = head.ok ? head.output.split('\t')[0]?.trim() : undefined
      merged = !reflog.ok || !creationSha || !tipSha || tipSha !== creationSha
    }
  }

  const lastCommitAt = head.ok ? head.output.split('\t')[1]?.trim() : undefined
  // Task-axis commits: the live ledger unioned with message-marker matches from
  // history (dedup preserves ledger-first order; marker finds are appended).
  const markerShas = refCommitsRes.ok ? refCommitsRes.output.split('\n').filter(Boolean) : []
  const commits = [...new Set([...(target.commits ?? []), ...markerShas])]
  const attributed =
    target.commits !== undefined || target.touched !== undefined || markerShas.length > 0

  return {
    updatedAt: nowIso,
    branch,
    shared: target.shared,
    dirtyFiles: dirtyPaths.length,
    ...(target.shared && target.touched !== undefined
      ? { dirtyOwn: countDirtyOwn(dirtyPaths, target.touched) }
      : {}),
    ...(target.shared && attributed ? { commits } : {}),
    ...(!target.shared && Number.isFinite(ahead) ? { ahead } : {}),
    ...(Number.isFinite(unpushed) ? { unpushed } : {}),
    ...(lastCommitAt ? { lastCommitAt } : {}),
    ...(merged ? { merged } : {}),
    ...(target.shared && !attributed ? { fallback: true } : {}),
  }
}
