import type { GitRepositoryWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { isHiddenRepoPath, rankRepoCandidates } from '../src/ranking'

function repo(path: string, extra: Partial<GitRepositoryWire> = {}): GitRepositoryWire {
  return { path, kind: 'repository', worktrees: [], ...extra }
}

describe('isHiddenRepoPath', () => {
  it('flags paths with a dot-segment', () => {
    expect(isHiddenRepoPath('/home/u/.claude/skills/gstack')).toBe(true)
    expect(isHiddenRepoPath('/home/u/.config/nvim')).toBe(true)
  })
  it('does not flag ordinary project paths', () => {
    expect(isHiddenRepoPath('/home/u/src/podium')).toBe(false)
    expect(isHiddenRepoPath('/home/u/code/app')).toBe(false)
  })
})

describe('rankRepoCandidates', () => {
  it('drops worktree entries so only repo roots are selectable', () => {
    const ranked = rankRepoCandidates([
      repo('/home/u/src/app'),
      { path: '/home/u/src/app-wt', kind: 'worktree', worktrees: [] },
    ])
    expect(ranked.map((c) => c.path)).toEqual(['/home/u/src/app'])
  })

  it('sorts hidden repos last and defaults them unselected', () => {
    const ranked = rankRepoCandidates([
      repo('/home/u/.claude/skills/gstack'),
      repo('/home/u/src/app'),
    ])
    expect(ranked.map((c) => c.path)).toEqual(['/home/u/src/app', '/home/u/.claude/skills/gstack'])
    expect(ranked.map((c) => c.defaultSelected)).toEqual([true, false])
    expect(ranked.map((c) => c.hidden)).toEqual([false, true])
  })

  it('orders visible repos by has-origin, then shallower depth, then alpha', () => {
    const ranked = rankRepoCandidates([
      repo('/home/u/src/z-no-origin'),
      repo('/home/u/work/deep/nested/app', { originUrl: 'git@github.com:o/app.git' }),
      repo('/home/u/a-origin', { originUrl: 'git@github.com:o/a.git' }),
    ])
    expect(ranked.map((c) => c.path)).toEqual([
      '/home/u/a-origin',
      '/home/u/work/deep/nested/app',
      '/home/u/src/z-no-origin',
    ])
  })

  it('derives name, branch, origin and worktree count', () => {
    const [c] = rankRepoCandidates([
      repo('/home/u/src/app', {
        branch: 'main',
        originUrl: 'git@github.com:o/app.git',
        worktrees: [{ path: '/home/u/src/app-wt' }],
      }),
    ])
    expect(c).toMatchObject({
      name: 'app',
      branch: 'main',
      hasOrigin: true,
      worktreeCount: 1,
      hidden: false,
      defaultSelected: true,
    })
  })
})
