import type { RepoOp } from '@podium/protocol'

export type RepoOpCommand = { bin: 'git' | 'gh'; argv: string[] } | { error: string }

export function repoOpCommand(op: RepoOp, args: Record<string, string> = {}): RepoOpCommand {
  switch (op) {
    case 'status':
      return { bin: 'git', argv: ['status', '--porcelain=v1', '-b'] }
    case 'log':
      return { bin: 'git', argv: ['log', '--oneline', '-20'] }
    case 'branches':
      return { bin: 'git', argv: ['branch', '-a', '-v'] }
    case 'worktreeAdd': {
      const { path, branch, startPoint } = args
      if (!path || !branch) return { error: 'missing args' }
      return { bin: 'git', argv: ['worktree', 'add', path, '-b', branch, ...(startPoint ? [startPoint] : [])] }
    }
    case 'rebase': {
      const { parentBranch } = args
      if (!parentBranch) return { error: 'missing args' }
      return { bin: 'git', argv: ['rebase', parentBranch] }
    }
    case 'mergeFfOnly': {
      const { branch } = args
      if (!branch) return { error: 'missing args' }
      return { bin: 'git', argv: ['merge', '--ff-only', branch] }
    }
    case 'worktreeRemove': {
      // NO --force, ever: git refuses to remove a dirty/locked worktree and we
      // surface its message instead of overriding it.
      const { path } = args
      if (!path) return { error: 'missing args' }
      return { bin: 'git', argv: ['worktree', 'remove', path] }
    }
    case 'branchDelete': {
      // Lowercase -d only (never -D): git refuses to delete an unmerged branch.
      const { branch } = args
      if (!branch) return { error: 'missing args' }
      return { bin: 'git', argv: ['branch', '-d', branch] }
    }
    case 'isMergedInto': {
      // Read-only ancestry test: exit 0 (ok) = branch is fully contained in
      // parentBranch; exit 1 surfaces as ok:false with empty output.
      const { branch, parentBranch } = args
      if (!branch || !parentBranch) return { error: 'missing args' }
      return { bin: 'git', argv: ['merge-base', '--is-ancestor', branch, parentBranch] }
    }
    case 'prCreate': {
      const { branch, parentBranch } = args
      if (!branch || !parentBranch) return { error: 'missing args' }
      return { bin: 'gh', argv: ['pr', 'create', '--base', parentBranch, '--head', branch, '--fill'] }
    }
  }
}
