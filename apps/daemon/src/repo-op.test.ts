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
  it('integrate ops: worktreeAddReset / checkoutReset / checkout / rebaseAbort (issue #70)', () => {
    expect(repoOpCommand('worktreeAddReset', { path: '/r/.worktrees/integrate-9-e', branch: 'integrate/9-e', startPoint: 'main' }))
      .toEqual({ bin: 'git', argv: ['worktree', 'add', '/r/.worktrees/integrate-9-e', '-B', 'integrate/9-e', 'main'] })
    expect(repoOpCommand('checkoutReset', { branch: 'integrate/9-e', startPoint: 'main' }))
      .toEqual({ bin: 'git', argv: ['checkout', '-B', 'integrate/9-e', 'main'] })
    expect(repoOpCommand('checkout', { branch: 'integrate/9-e' }))
      .toEqual({ bin: 'git', argv: ['checkout', 'integrate/9-e'] })
    expect(repoOpCommand('rebaseAbort')).toEqual({ bin: 'git', argv: ['rebase', '--abort'] })
  })
  it('branchDeleteForce only inside the integrate-tmp/ namespace', () => {
    expect(repoOpCommand('branchDeleteForce', { branch: 'integrate-tmp/3' }))
      .toEqual({ bin: 'git', argv: ['branch', '-D', 'integrate-tmp/3'] })
    expect(repoOpCommand('branchDeleteForce', { branch: 'issue/3-x' }))
      .toEqual({ error: 'branchDeleteForce is restricted to integrate-tmp/* refs' })
    expect(repoOpCommand('branchDeleteForce', { branch: 'main' }))
      .toEqual({ error: 'branchDeleteForce is restricted to integrate-tmp/* refs' })
  })
  it('reports missing args', () => {
    expect(repoOpCommand('worktreeAddReset', { path: '/r/wt', branch: 'integrate/1-x' })).toEqual({ error: 'missing args' })
    expect(repoOpCommand('checkoutReset', { branch: 'integrate/1-x' })).toEqual({ error: 'missing args' })
    expect(repoOpCommand('checkout', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('branchDeleteForce', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('worktreeAdd', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('rebase', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('worktreeRemove', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('branchDelete', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('isMergedInto', { branch: 'issue/1-x' })).toEqual({ error: 'missing args' })
  })
})
