import type { RepoOp } from '@podium/protocol'

export type RepoOpCommand = { bin: 'git' | 'gh'; argv: string[] } | { error: string }

/**
 * Leading-dash guard for argv slots where the subcommand does NOT support a
 * `--` separator (or where `--` changes meaning, e.g. checkout pathspecs) and
 * for option-value slots (-b/-B/--base/--head) that a `--` cannot protect.
 * Issue-row columns are server-generated today (issue/<seq>-<slug>) so this is
 * defense-in-depth: a crafted value like '-D' or '--force' must never parse as
 * a git/gh OPTION. Returns an error string, or null when the value is safe.
 */
export function assertSafeRef(value: string, label: string): string | null {
  if (value.startsWith('-')) return `unsafe ${label}: must not start with '-' (got '${value}')`
  return null
}

export function repoOpCommand(op: RepoOp, args: Record<string, string> = {}): RepoOpCommand {
  switch (op) {
    case 'status':
      return { bin: 'git', argv: ['status', '--porcelain=v1', '-b'] }
    case 'log':
      return { bin: 'git', argv: ['log', '--oneline', '-20'] }
    case 'branches':
      return { bin: 'git', argv: ['branch', '-a', '-v'] }
    case 'revParseVerify': {
      const ref = args.ref
      if (!ref) return { error: 'missing args' }
      const bad = assertSafeRef(ref, 'ref')
      if (bad) return { error: bad }
      return { bin: 'git', argv: ['rev-parse', '--verify', ref + '^{commit}'] }
    }
    case 'worktreeAdd': {
      // Options before `--`; path + optional startPoint ride after it as
      // guaranteed positionals. The -b value is an option argument `--` cannot
      // protect, so it is validated instead (git also rejects '-…' refnames).
      const { path, branch, startPoint } = args
      if (!path || !branch) return { error: 'missing args' }
      const bad = assertSafeRef(branch, 'branch')
      if (bad) return { error: bad }
      return {
        bin: 'git',
        argv: ['worktree', 'add', '-b', branch, '--', path, ...(startPoint ? [startPoint] : [])],
      }
    }
    case 'rebase': {
      // `git rebase -- <upstream>` is supported: a '-D' upstream fails with
      // "fatal: invalid upstream '-D'" instead of parsing as an option.
      const { parentBranch } = args
      if (!parentBranch) return { error: 'missing args' }
      return { bin: 'git', argv: ['rebase', '--', parentBranch] }
    }
    case 'mergeFfOnly': {
      // `git merge --ff-only -- <branch>`: a dash value becomes
      // "merge: -D - not something we can merge", never an option.
      const { branch } = args
      if (!branch) return { error: 'missing args' }
      return { bin: 'git', argv: ['merge', '--ff-only', '--', branch] }
    }
    case 'worktreeRemove': {
      // NO --force, ever: git refuses to remove a dirty/locked worktree and we
      // surface its message instead of overriding it. `--` protects the path.
      const { path } = args
      if (!path) return { error: 'missing args' }
      return { bin: 'git', argv: ['worktree', 'remove', '--', path] }
    }
    case 'branchDelete': {
      // Lowercase -d only (never -D): git refuses to delete an unmerged branch.
      // `--` makes a dash value a (nonexistent) branch name, never a flag.
      const { branch } = args
      if (!branch) return { error: 'missing args' }
      return { bin: 'git', argv: ['branch', '-d', '--', branch] }
    }
    case 'isMergedInto': {
      // Read-only ancestry test: exit 0 (ok) = branch is fully contained in
      // parentBranch; exit 1 surfaces as ok:false with empty output.
      // merge-base supports `--`: '-D' → "fatal: Not a valid object name -D".
      const { branch, parentBranch } = args
      if (!branch || !parentBranch) return { error: 'missing args' }
      return { bin: 'git', argv: ['merge-base', '--is-ancestor', '--', branch, parentBranch] }
    }
    case 'worktreeAddReset': {
      // -B (vs worktreeAdd's -b): resets the branch to startPoint if it already
      // exists — integrate (issue #70) REBUILDS its integration branch every run.
      // Same `--` layout as worktreeAdd; the -B value is validated.
      const { path, branch, startPoint } = args
      if (!path || !branch || !startPoint) return { error: 'missing args' }
      const bad = assertSafeRef(branch, 'branch')
      if (bad) return { error: bad }
      return { bin: 'git', argv: ['worktree', 'add', '-B', branch, '--', path, startPoint] }
    }
    case 'checkoutReset': {
      // git checkout -B <branch> <startPoint>: create-or-reset and switch to it.
      // checkout's `--` starts a PATHSPEC (and breaks the start-point slot), so
      // both values are validated instead.
      const { branch, startPoint } = args
      if (!branch || !startPoint) return { error: 'missing args' }
      const bad = assertSafeRef(branch, 'branch') ?? assertSafeRef(startPoint, 'startPoint')
      if (bad) return { error: bad }
      return { bin: 'git', argv: ['checkout', '-B', branch, startPoint] }
    }
    case 'checkout': {
      // `git checkout -- <x>` means pathspec, not branch — validate instead.
      const { branch } = args
      if (!branch) return { error: 'missing args' }
      const bad = assertSafeRef(branch, 'branch')
      if (bad) return { error: bad }
      return { bin: 'git', argv: ['checkout', branch] }
    }
    case 'rebaseAbort':
      return { bin: 'git', argv: ['rebase', '--abort'] }
    case 'branchDeleteForce': {
      // -D, but ONLY inside the integrate temp-ref namespace: integrate rebases a
      // throwaway copy of each child branch and must be able to drop it even when
      // unmerged (conflict abort). Real branches keep the non-forcing branchDelete.
      // The startsWith guard already excludes leading dashes; `--` is belt+braces.
      const { branch } = args
      if (!branch) return { error: 'missing args' }
      if (!branch.startsWith('integrate-tmp/')) {
        return { error: 'branchDeleteForce is restricted to integrate-tmp/* refs' }
      }
      return { bin: 'git', argv: ['branch', '-D', '--', branch] }
    }
    case 'prCreate': {
      // gh flag-value slots (--base/--head): `--` gives no protection here, so
      // both refs are validated.
      const { branch, parentBranch } = args
      if (!branch || !parentBranch) return { error: 'missing args' }
      const bad = assertSafeRef(branch, 'branch') ?? assertSafeRef(parentBranch, 'parentBranch')
      if (bad) return { error: bad }
      return {
        bin: 'gh',
        argv: ['pr', 'create', '--base', parentBranch, '--head', branch, '--fill'],
      }
    }
  }
}
