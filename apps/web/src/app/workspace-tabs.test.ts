import type { IssueWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { FileTab } from './store'
import { fileTabsForWorkspace } from './workspace-tabs'

const issue = (over: Partial<IssueWire>): IssueWire =>
  ({ id: 'i1', seq: 1, worktreePath: undefined, ...over }) as IssueWire

const tab = (over: Partial<FileTab>): FileTab =>
  ({
    id: 't',
    scope: { kind: 'session', sessionId: 's' },
    path: 'p',
    worktreePath: '',
    ...over,
  }) as FileTab

describe('fileTabsForWorkspace (strict issue scoping, POD-149)', () => {
  it('shows an owned artifact tab for a worktree-LESS issue (POD-502 regression)', () => {
    const artifact = tab({
      id: 'a',
      issueId: 'i1',
      worktreePath: '/repo',
      scope: { kind: 'artifact', issueId: 'i1', artifactId: 'x' },
    })
    const out = fileTabsForWorkspace([artifact], {
      issue: issue({ worktreePath: undefined }),
      worktreePath: undefined,
    })
    expect(out).toEqual([artifact])
  })

  it('matches a tab to its issue by issueId, not another issue', () => {
    const artifact = tab({ id: 'a', issueId: 'i2', worktreePath: '/repo' })
    const out = fileTabsForWorkspace([artifact], {
      issue: issue({ id: 'i1' }),
      worktreePath: undefined,
    })
    expect(out).toEqual([])
  })

  it("does NOT leak another issue's (or an unowned) tab in via a shared checkout path", () => {
    // Pre-POD-149: any tab whose worktreePath matched the issue's worktree or
    // effective root rode along into every issue sharing the checkout.
    const foreign = tab({ id: 'x', issueId: 'i2', worktreePath: '/main' })
    const unowned = tab({ id: 'y', worktreePath: '/main' })
    const out = fileTabsForWorkspace([foreign, unowned], {
      issue: issue({ id: 'i1', worktreePath: '/main' }),
      worktreePath: '/main',
    })
    expect(out).toEqual([])
  })

  it('shows a worktree-scoped file tab under the issue that owns it', () => {
    const file = tab({
      id: 'w',
      issueId: 'i1',
      worktreePath: '/wt',
      scope: { kind: 'worktree', root: '/wt' },
    })
    const out = fileTabsForWorkspace([file], {
      issue: issue({ worktreePath: '/wt' }),
      worktreePath: undefined,
    })
    expect(out).toEqual([file])
  })

  it('falls back to worktree-path matching only when no issue is selected', () => {
    const file = tab({ id: 'w', worktreePath: '/wt' })
    const owned = tab({ id: 'o', issueId: 'i1', worktreePath: '/wt' })
    expect(fileTabsForWorkspace([file, owned], { issue: null, worktreePath: '/wt' })).toEqual([
      file,
      owned,
    ])
    expect(fileTabsForWorkspace([file], { issue: null, worktreePath: undefined })).toEqual([])
  })
})
