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
    case 'prCreate': {
      const { branch, parentBranch } = args
      if (!branch || !parentBranch) return { error: 'missing args' }
      return { bin: 'gh', argv: ['pr', 'create', '--base', parentBranch, '--head', branch, '--fill'] }
    }
  }
}
