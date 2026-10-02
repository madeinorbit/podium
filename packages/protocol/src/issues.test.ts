import { ISSUE_STAGES, IssuePanelArtifact, IssueStage } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { RepoOp } from './messages'

describe('issue protocol types', () => {
  it('has the five ordered stages', () => {
    expect(ISSUE_STAGES).toEqual([
      'proposed',
      'backlog',
      'planning',
      'in_progress',
      'review',
      'done',
    ])
    expect(IssueStage.parse('proposed')).toBe('proposed')
    expect(IssueStage.parse('review')).toBe('review')
    expect(IssueStage.safeParse('verifying').success).toBe(false)
  })

  it('carries additive artifact ownership and Git tracking evidence', () => {
    const legacy = IssuePanelArtifact.parse({ path: 'shots/a.png', addedAt: 't' })
    expect(legacy.tracking).toBeUndefined()
    expect(
      IssuePanelArtifact.parse({
        path: 'shots/a.png',
        addedAt: 't',
        sourcePaths: ['shots/a.png'],
        tracking: 'untracked',
        untrackedPaths: ['shots/a.png'],
      }),
    ).toMatchObject({
      sourcePaths: ['shots/a.png'],
      tracking: 'untracked',
      untrackedPaths: ['shots/a.png'],
    })
  })

  // POD-797: readAt remains durable, while replica-derived unread is stripped.

  // Issue colour [spec:SP-b4d1]: an additive optional slot NAME ('rose' … 'lime',
  // never a hex). Absent = no colour; an unknown value from a newer peer degrades
  // to unset instead of failing the whole issue.

  // #175: comment bodies left the wire. `comments` is a deprecated optional
  // (old payloads/hubs may still send it); `commentCount` is the additive
  // replacement, also optional so pre-#175 payloads keep parsing (wire v1).

  it('accepts the new write RepoOps', () => {
    expect(RepoOp.parse('clone')).toBe('clone')
    expect(RepoOp.parse('rebase')).toBe('rebase')
    expect(RepoOp.parse('mergeFfOnly')).toBe('mergeFfOnly')
    expect(RepoOp.parse('prCreate')).toBe('prCreate')
  })

  it('accepts the cleanup RepoOps (issue #71)', () => {
    expect(RepoOp.parse('worktreeRemove')).toBe('worktreeRemove')
    expect(RepoOp.parse('branchDelete')).toBe('branchDelete')
    expect(RepoOp.parse('isMergedInto')).toBe('isMergedInto')
  })

  it('accepts worktreeAddExisting for stop→resume [spec:SP-9904]', () => {
    expect(RepoOp.parse('worktreeAddExisting')).toBe('worktreeAddExisting')
  })
})
