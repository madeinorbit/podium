import { describe, expect, it } from 'vitest'
import { findCapabilitySnapshotKeys } from '../annotations/capability-snapshot'
import { HandoffManifest, HandoffRefusalReason } from './handoff'

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

  // ADR 9 D5 A1 / POD-643 acceptance: the load-bearing constraint on a PORTABLE
  // representation. A bundle leaves the live system, so a serialized authority
  // field in it would authorize on the far side from payload — exactly what
  // ADR 3 D7 forbids. The audit fires on any spelling; see
  // `annotations/capability-snapshot.test.ts` for proof it fires at all.
  it('carries no serialized capability, effective-rights or scope snapshot', () => {
    expect(findCapabilitySnapshotKeys(HandoffManifest)).toEqual([])
  })

  // The key set is LOCKED, in wire order. The golden fixtures pin the encoding
  // of a value, which an added OPTIONAL field slips past unchanged; this pins
  // the vocabulary itself, so growing the manifest is a deliberate, reviewed
  // act rather than a silent one.
  it('has exactly the locked v1 key set, in wire order', () => {
    expect(Object.keys(HandoffManifest.shape)).toEqual([
      'format',
      'sessionId',
      'agentKind',
      'resume',
      'transcriptFilename',
      'transcriptRelativeDir',
      'repoId',
      'branch',
      'headSha',
      'snapshotSha',
      'snapshotFlattened',
      'worktreeName',
      'worktreeRelativePath',
      'cwdSubpath',
      'bundleBase',
      'title',
      'issueId',
      'sourceMachineId',
      'exportedAt',
    ])
  })
})

describe('HandoffRefusalReason', () => {
  // ADR 9 D6 M5 / ADR 1 Am1 D13.7: a denied handoff must not collapse into a
  // generic failure, because "denied" and "offline" otherwise produce the same
  // empty list. Enforcement is POD-1079 / POD-323's; the VOCABULARY is this
  // issue's, and a closed union is what stops the enforcement from inventing
  // free-text reasons per call site.
  it('distinguishes unauthorized from unreachable, and nothing else', () => {
    expect(HandoffRefusalReason.options).toEqual(['unauthorized', 'unreachable', 'unknown-target'])
  })

  it('rejects a reason outside the closed set', () => {
    expect(() => HandoffRefusalReason.parse('denied')).toThrow()
  })
})
