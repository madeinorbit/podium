import type { IssueWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { FileTab } from './store'
import { fileTabsForWorkspace } from './workspace-tabs'

const issue = (over: Partial<IssueWire>): IssueWire =>
  ({ id: 'i1', seq: 1, worktreePath: undefined, ...over }) as IssueWire

const tab = (over: Partial<FileTab>): FileTab =>
  ({ id: 't', scope: { kind: 'session', sessionId: 's' }, path: 'p', worktreePath: '', ...over }) as FileTab

describe('fileTabsForWorkspace', () => {
  it('shows an artifact tab for a worktree-LESS issue (POD-502 regression)', () => {
    const artifact = tab({
      id: 'a',
      issueId: 'i1',
      worktreePath: '/repo',
      scope: { kind: 'artifact', issueId: 'i1', artifactId: 'x' },
    })
    const out = fileTabsForWorkspace([artifact], { issue: issue({ worktreePath: undefined }), worktreePath: undefined })
    expect(out).toEqual([artifact])
  })

  it('matches the artifact to its issue by issueId, not another issue', () => {
    const artifact = tab({ id: 'a', issueId: 'i2', worktreePath: '/repo' })
    const out = fileTabsForWorkspace([artifact], { issue: issue({ id: 'i1' }), worktreePath: undefined })
    expect(out).toEqual([])
  })

  it('still includes ordinary worktree file tabs by path', () => {
    const file = tab({ id: 'w', worktreePath: '/wt', scope: { kind: 'worktree', root: '/wt' } })
    const out = fileTabsForWorkspace([file], { issue: issue({ worktreePath: '/wt' }), worktreePath: undefined })
    expect(out).toEqual([file])
  })

  it('keeps a dock-opened file for a worktree-LESS issue via the effective root (POD-130)', () => {
    const file = tab({
      id: 'w',
      worktreePath: '/main',
      scope: { kind: 'worktree', root: '/main' },
    })
    const foreign = tab({ id: 'x', worktreePath: '/other' })
    const out = fileTabsForWorkspace([file, foreign], {
      issue: issue({ worktreePath: undefined }),
      worktreePath: '/main',
    })
    expect(out).toEqual([file])
  })

  it('falls back to worktree path when no issue is selected', () => {
    const file = tab({ id: 'w', worktreePath: '/wt' })
    expect(fileTabsForWorkspace([file], { issue: null, worktreePath: '/wt' })).toEqual([file])
    expect(fileTabsForWorkspace([file], { issue: null, worktreePath: undefined })).toEqual([])
  })
})
