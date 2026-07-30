import { describe, expect, it } from 'vitest'
import { findCapabilitySnapshotKeys } from '../annotations/capability-snapshot'
import { IssueIdentity, IssueWorkspace } from '../fields/issue'
import {
  SessionIdentity,
  SessionNaming,
  SessionPlacement,
  SessionResume,
} from '../fields/session'
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

  // POD-643's first acceptance criterion, asserted by IDENTITY rather than by
  // shape. A fresh `z.string()` restatement is structurally equal on the wire and
  // passes every golden fixture — mutation testing confirmed that replacing a
  // composed field with one reds THIS test and nothing else, out of 185. So
  // reference equality is the only instrument that sees the POD-302 drift class.
  //
  // WHAT THIS TEST DOES NOT CLAIM, because a mutant proved it does not: writing
  // `sessionId: SessionIdField` — importing the underlying brand directly instead
  // of reaching through the group — is observationally IDENTICAL and passes,
  // since the group holds that same instance. That mutant is an equivalent
  // composition rather than a defect: it still follows the shared brand. It is
  // nonetheless weaker, because it would NOT follow if POD-365 re-typed the
  // group's field, which is why the schema reaches through the group. The test
  // name says "IS the shared instance" and not "was written as a group
  // reference", because the former is what it can actually distinguish.
  it('takes every session and issue field as the shared schema instance, never a restatement', () => {
    expect(HandoffManifest.shape.sessionId).toBe(SessionIdentity.shape.sessionId)
    // Tightened by `.unwrap()`: the shared field is optional/nullable because a
    // LIVE session may lack it. A bundle may not — see the schema's docs.
    expect(HandoffManifest.shape.resume).toBe(SessionResume.shape.resume.unwrap())
    expect(HandoffManifest.shape.repoId).toBe(IssueIdentity.shape.repoId.unwrap())
    expect(HandoffManifest.shape.branch).toBe(IssueWorkspace.shape.branch.unwrap())
    // Loosened: the manifest's own optionality wraps the shared inner schema.
    expect(HandoffManifest.shape.title.unwrap()).toBe(SessionNaming.shape.title)
    expect(HandoffManifest.shape.issueId.unwrap()).toBe(
      SessionPlacement.shape.issueId.unwrap(),
    )
  })

  // `agentKind` is the ONE deliberate exception, so it needs the counterfactual
  // in the fixture: asserting "the manifest has two arms" proves nothing unless
  // the shared union it departs from is shown to have more.
  it('narrows agentKind below the shared AgentKind, deliberately', () => {
    expect(HandoffManifest.shape.agentKind.options).toEqual(['claude-code', 'codex'])
    expect(SessionIdentity.shape.agentKind.options.length).toBeGreaterThan(2)
    expect(SessionIdentity.shape.agentKind.options).toContain('shell')
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
