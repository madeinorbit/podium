import { asArtifactId, asIssueId, asMachineId, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { scopeKey, tabIdFor } from './file-scope'

describe('scopeKey / tabIdFor', () => {
  it('keys the three scope kinds distinctly', () => {
    expect(scopeKey({ kind: 'session', sessionId: asSessionId('s1') })).toBe('s:s1')
    expect(scopeKey({ kind: 'worktree', root: '/wt' })).toBe('w::/wt')
    // Artifact snapshots (#441).
    expect(
      scopeKey({
        kind: 'artifact',
        issueId: asIssueId('iss_1'),
        artifactId: asArtifactId('abc123'),
      }),
    ).toBe('a:iss_1:abc123')
  })

  it('tab ids are unique per (scope, path)', () => {
    const artifact = {
      kind: 'artifact',
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc123'),
    } as const
    expect(tabIdFor(artifact, 'index.html')).toBe('file:a:iss_1:abc123:index.html')
    expect(tabIdFor(artifact, 'index.html')).not.toBe(
      tabIdFor(
        { kind: 'artifact', issueId: asIssueId('iss_1'), artifactId: asArtifactId('other') },
        'index.html',
      ),
    )
    expect(tabIdFor({ kind: 'worktree', root: '/wt' }, '/wt/a.md')).toBe('file:w::/wt:/wt/a.md')
  })

  it('separates identical worktree paths on different or unspecified machines', () => {
    const scopes = [
      { kind: 'worktree', root: '/wt', machineId: asMachineId('machine-a') },
      { kind: 'worktree', root: '/wt', machineId: asMachineId('machine-b') },
      { kind: 'worktree', root: '/wt' },
    ] as const
    expect(new Set(scopes.map(scopeKey)).size).toBe(3)
    expect(new Set(scopes.map((scope) => tabIdFor(scope, '/wt/a.md'))).size).toBe(3)
    expect(scopeKey(scopes[0])).toBe('w:machine-a:/wt')
    expect(tabIdFor({ ...scopes[0] }, '/wt/a.md')).toBe(tabIdFor(scopes[0], '/wt/a.md'))
  })

  it('keeps the machine delimiter distinct from root path characters', () => {
    expect(scopeKey({ kind: 'worktree', machineId: asMachineId('a:b'), root: '/wt' })).not.toBe(
      scopeKey({ kind: 'worktree', machineId: asMachineId('a'), root: 'b:/wt' }),
    )
  })
})
