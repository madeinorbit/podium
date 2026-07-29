import { describe, expect, it } from 'vitest'
import { HandoffManifest } from './handoff'

describe('HandoffManifest', () => {
  it('round-trips the canonical v1 manifest', () => {
    const value = {
      format: 1 as const,
      sessionId: 's1',
      agentKind: 'codex' as const,
      resume: { kind: 'codex-thread' as const, value: 'thread-1' },
      transcriptFilename: 'rollout-keep-me.jsonl',
      transcriptRelativeDir: '2026/07/14',
      repoId: 'repo-1',
      branch: 'issue/498-handoff',
      headSha: 'a'.repeat(40),
      snapshotSha: 'b'.repeat(40),
      snapshotFlattened: true as const,
      worktreeName: 'issue-498',
      worktreeRelativePath: '.claude/worktrees/issue-498',
      bundleBase: ['c'.repeat(40)],
      title: 'Session handoff',
      issueId: '498',
      sourceMachineId: 'm1',
      exportedAt: '2026-07-14T12:00:00.000Z',
    }
    expect(HandoffManifest.parse(JSON.parse(JSON.stringify(value)))).toEqual(value)
  })

  it('rejects worktree locations that escape the repository', () => {
    const base = {
      format: 1 as const,
      sessionId: 's1',
      agentKind: 'codex' as const,
      resume: { kind: 'codex-thread' as const, value: 'thread-1' },
      transcriptFilename: 'rollout.jsonl',
      repoId: 'repo-1',
      branch: 'issue/498-handoff',
      headSha: 'a'.repeat(40),
      snapshotSha: null,
      snapshotFlattened: true as const,
      worktreeName: 'issue-498',
      bundleBase: ['a'.repeat(40)],
      sourceMachineId: 'm1',
      exportedAt: '2026-07-14T12:00:00.000Z',
    }
    expect(() => HandoffManifest.parse({ ...base, worktreeRelativePath: '../elsewhere' })).toThrow()
    expect(() =>
      HandoffManifest.parse({ ...base, worktreeRelativePath: '/tmp/elsewhere' }),
    ).toThrow()
  })
})
