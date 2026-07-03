import { describe, expect, it } from 'vitest'
import { repoOpCommand } from './repo-op'

describe('repoOpCommand', () => {
  it('builds read ops', () => {
    expect(repoOpCommand('status')).toEqual({ bin: 'git', argv: ['status', '--porcelain=v1', '-b'] })
    expect(repoOpCommand('log')).toEqual({ bin: 'git', argv: ['log', '--oneline', '-20'] })
  })
  it('worktreeAdd with and without start point', () => {
    expect(repoOpCommand('worktreeAdd', { path: '/r/wt', branch: 'issue/1-x' }))
      .toEqual({ bin: 'git', argv: ['worktree', 'add', '/r/wt', '-b', 'issue/1-x'] })
    expect(repoOpCommand('worktreeAdd', { path: '/r/wt', branch: 'issue/1-x', startPoint: 'main' }))
      .toEqual({ bin: 'git', argv: ['worktree', 'add', '/r/wt', '-b', 'issue/1-x', 'main'] })
  })
  it('rebase / mergeFfOnly / prCreate', () => {
    expect(repoOpCommand('rebase', { parentBranch: 'main' })).toEqual({ bin: 'git', argv: ['rebase', 'main'] })
    expect(repoOpCommand('mergeFfOnly', { branch: 'issue/1-x' })).toEqual({ bin: 'git', argv: ['merge', '--ff-only', 'issue/1-x'] })
    expect(repoOpCommand('prCreate', { branch: 'issue/1-x', parentBranch: 'main' }))
      .toEqual({ bin: 'gh', argv: ['pr', 'create', '--base', 'main', '--head', 'issue/1-x', '--fill'] })
  })
  it('cleanup ops: worktreeRemove / branchDelete / isMergedInto (never --force / -D)', () => {
    expect(repoOpCommand('worktreeRemove', { path: '/r/.worktrees/issue-1-x' }))
      .toEqual({ bin: 'git', argv: ['worktree', 'remove', '/r/.worktrees/issue-1-x'] })
    expect(repoOpCommand('branchDelete', { branch: 'issue/1-x' }))
      .toEqual({ bin: 'git', argv: ['branch', '-d', 'issue/1-x'] })
    expect(repoOpCommand('isMergedInto', { branch: 'issue/1-x', parentBranch: 'main' }))
      .toEqual({ bin: 'git', argv: ['merge-base', '--is-ancestor', 'issue/1-x', 'main'] })
  })
  it('reports missing args', () => {
    expect(repoOpCommand('worktreeAdd', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('rebase', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('worktreeRemove', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('branchDelete', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('isMergedInto', { branch: 'issue/1-x' })).toEqual({ error: 'missing args' })
  })
})
