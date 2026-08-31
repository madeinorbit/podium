import type { IssueId, SessionId } from '@podium/model/browser'
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
const sessions = [{ sessionId: 'sess_1' as SessionId, displayRef: 'POD-1606-A' }]
const context = { issues, sessions }

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
    expect(resolvePodiumTarget({ kind: 'issue', issue: 'POD-1606' }, context)).toEqual({
      kind: 'issue',
      issueId: 'iss_abc',
    })
  })

  it('resolves a known session before handing it to navigateToSession', () => {
    expect(resolvePodiumTarget({ kind: 'session', session: 'POD-1606-A' }, context)).toEqual({
      kind: 'session',
      sessionIdOrRef: 'sess_1',
    })
  })

  it('does not claim an unknown session that navigateToSession would ignore', () => {
    expect(resolvePodiumTarget({ kind: 'session', session: 'POD-9999-A' }, context)).toBeNull()
  })

  it('opens an artifact by its panel entry when the address names no file', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: null },
        context,
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
        context,
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
        { issues: rows, sessions },
      ),
    ).toMatchObject({ path: 'proof.html' })
  })

  it('refuses an artifact id that is not on the issue', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'nope', entry: null },
        context,
      ),
    ).toBeNull()
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'nope', entry: 'index.html' },
        context,
      ),
    ).toBeNull()
  })

  it('declines a file fragment this client cannot deliver to the editor', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'file', path: '/w/src/a.ts', root: '/w', machineId: 'm1', hash: '#L42' },
        context,
      ),
    ).toBeNull()
    expect(
      resolvePodiumTarget(
        { kind: 'file', path: '/w/src/a.ts', root: '/w', machineId: 'm1' },
        context,
      ),
    ).toEqual({ kind: 'file', path: '/w/src/a.ts', root: '/w', machineId: 'm1' })
    expect(
      resolvePodiumTarget(
        {
          kind: 'file',
          path: '/w/src/a.ts',
          root: '/w',
          machineId: 'm1',
          search: '?line=42',
        },
        context,
      ),
    ).toBeNull()
  })

  it('refuses a file with no worktree rather than guessing one', () => {
    // A file tab is worktree-scoped; a guess opens the wrong checkout silently.
    expect(
      resolvePodiumTarget(
        { kind: 'file', path: '/w/src/a.ts', root: null, machineId: null },
        {
          ...context,
        },
      ),
    ).toBeNull()
  })

  it('passes a lossless top-level page through', () => {
    expect(
      resolvePodiumTarget({ kind: 'view', path: '/usage', search: '', hash: '' }, context),
    ).toEqual({ kind: 'view', path: '/usage', search: '', hash: '' })
  })

  it('declines typed detail and lossy plain views', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'view', path: '/settings/general', search: '', hash: '#advanced' },
        context,
      ),
    ).toBeNull()
    expect(
      resolvePodiumTarget(
        { kind: 'issue', issue: 'POD-1606', search: '?tab=activity', hash: '#latest' },
        context,
      ),
    ).toBeNull()
    expect(
      resolvePodiumTarget(
        { kind: 'view', path: '/workspace', search: '?wt=%2Fw', hash: '' },
        context,
      ),
    ).toBeNull()
  })

  it('declines a server selector presented to the live resolver', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'session', session: 'POD-1606-A', search: '?server=wss%3A%2F%2FB' },
        context,
      ),
    ).toBeNull()
  })

  it('resolves nothing for an issue this replica has not seen', () => {
    // Null is what makes the anchor fall through to a real navigation instead of
    // becoming a dead click.
    expect(resolvePodiumTarget({ kind: 'issue', issue: 'POD-9999' }, context)).toBeNull()
  })
})
