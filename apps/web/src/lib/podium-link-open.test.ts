import type { IssueId } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import { findLinkedIssue, type LinkIssueLike, resolvePodiumTarget } from './podium-link-open'

const issue = (over: Partial<LinkIssueLike> = {}): LinkIssueLike => ({
  id: 'iss_abc' as IssueId,
  prefix: 'POD',
  seq: 1606,
  displayRef: 'POD-1606',
  worktreePath: '/w/1606',
  panel: { artifacts: [{ path: 'docs/proof.html', artifactId: 'art1', entry: 'proof.html' }] },
  ...over,
})

const issues = [issue()]

describe('findLinkedIssue', () => {
  it('takes the internal id the app writes into its own URLs', () => {
    expect(findLinkedIssue('iss_abc', issues)?.id).toBe('iss_abc')
  })

  it('takes the ref a person actually has in their hand', () => {
    expect(findLinkedIssue('POD-1606', issues)?.id).toBe('iss_abc')
  })

  it('matches prefix + seq when the row predates displayRef', () => {
    expect(findLinkedIssue('POD-1606', [issue({ displayRef: undefined })])?.id).toBe('iss_abc')
  })

  it('does not invent an issue this replica has not seen', () => {
    expect(findLinkedIssue('POD-9999', issues)).toBeUndefined()
  })
})

describe('resolvePodiumTarget', () => {
  it('opens an issue as a view', () => {
    expect(resolvePodiumTarget({ kind: 'issue', issue: 'POD-1606' }, { issues })).toEqual({
      kind: 'issue',
      issueId: 'iss_abc',
    })
  })

  it('hands a session identifier straight to navigateToSession', () => {
    // Deliberately NOT resolved here: the store action already accepts an id or
    // a birth ref, and a second lookup is a second thing to drift.
    expect(resolvePodiumTarget({ kind: 'session', session: 'POD-1606-A' }, { issues })).toEqual({
      kind: 'session',
      sessionIdOrRef: 'POD-1606-A',
    })
  })

  it('opens an artifact by its panel entry when the address names no file', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: null },
        { issues },
      ),
    ).toEqual({
      kind: 'artifact',
      issueId: 'iss_abc',
      artifactId: 'art1',
      path: 'proof.html',
      worktreePath: '/w/1606',
    })
  })

  it('prefers the file the address names inside the bundle', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: 'shots/a.png' },
        { issues },
      ),
    ).toMatchObject({ path: 'shots/a.png' })
  })

  it('falls back to the artifact path basename when the panel has no entry', () => {
    const rows = [
      issue({ panel: { artifacts: [{ path: 'docs/proof.html', artifactId: 'art1' }] } }),
    ]
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: null },
        { issues: rows },
      ),
    ).toMatchObject({ path: 'proof.html' })
  })

  it('refuses an artifact id that is not on the issue', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'nope', entry: null },
        { issues },
      ),
    ).toBeNull()
  })

  it('opens a file against the worktree the address names', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'file', path: '/w/src/a.ts', root: '/w', machineId: 'm1' },
        { issues },
      ),
    ).toEqual({ kind: 'file', path: '/w/src/a.ts', root: '/w', machineId: 'm1' })
  })

  it('refuses a file with no worktree rather than guessing one', () => {
    // A file tab is worktree-scoped; a guess opens the wrong checkout silently.
    expect(
      resolvePodiumTarget(
        { kind: 'file', path: '/w/src/a.ts', root: null, machineId: null },
        {
          issues,
        },
      ),
    ).toBeNull()
  })

  it('passes a plain page through', () => {
    expect(
      resolvePodiumTarget({ kind: 'view', path: '/settings/general', search: '' }, { issues }),
    ).toEqual({ kind: 'view', path: '/settings/general', search: '' })
  })

  it('resolves nothing for an issue this replica has not seen', () => {
    // Null is what makes the anchor fall through to a real navigation instead of
    // becoming a dead click.
    expect(resolvePodiumTarget({ kind: 'issue', issue: 'POD-9999' }, { issues })).toBeNull()
  })
})
