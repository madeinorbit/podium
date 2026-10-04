import { asArtifactId, asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { scopeKey, tabIdFor } from './file-scope'

describe('scopeKey / tabIdFor', () => {
  it('keys the three scope kinds distinctly', () => {
    expect(scopeKey({ kind: 'session', sessionId: asSessionId('s1') })).toBe('s:s1')
    expect(scopeKey({ kind: 'worktree', root: '/wt' })).toBe('w:/wt')
    // Artifact snapshots ([spec:SP-0fc9] #441).
    expect(scopeKey({ kind: 'artifact', issueId: asIssueId('iss_1'), artifactId: asArtifactId('abc123') })).toBe(
      'a:iss_1:abc123',
    )
  })

  it('tab ids are unique per (scope, path)', () => {
    const artifact = { kind: 'artifact', issueId: asIssueId('iss_1'), artifactId: asArtifactId('abc123') } as const
    expect(tabIdFor(artifact, 'index.html')).toBe('file:a:iss_1:abc123:index.html')
    expect(tabIdFor(artifact, 'index.html')).not.toBe(
      tabIdFor({ kind: 'artifact', issueId: asIssueId('iss_1'), artifactId: asArtifactId('other') }, 'index.html'),
    )
    expect(tabIdFor({ kind: 'worktree', root: '/wt' }, '/wt/a.md')).toBe('file:w:/wt:/wt/a.md')
  })
})
