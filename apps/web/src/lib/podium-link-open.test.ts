import type { IssueId, SessionId } from '@podium/model/browser'
import { describe, expect, it, vi } from 'vitest'
import { type LinkIssueLike, resolvePodiumTarget } from './podium-link-open'

const issue = (over: Partial<LinkIssueLike> = {}): LinkIssueLike => ({
  id: 'iss_abc' as IssueId,
  prefix: 'POD',
  seq: 1606,
  displayRef: 'POD-1606',
  worktreePath: '/w/1606',
  panel: {
    artifacts: [
      {
        path: 'docs/proof.html',
        artifactId: 'art1',
        entry: 'proof.html',
        files: [
          { path: 'proof.html', size: 100 },
          { path: 'shots/a.png', size: 200 },
        ],
      },
    ],
  },
  ...over,
})

const issues = [issue()]
const sessions = [{ sessionId: 'sess_1' as SessionId, displayRef: 'POD-1606-A' }]
function namedContext(rows: readonly LinkIssueLike[] = issues) {
  const namedIssues = new Map(rows.flatMap(row => [
    [row.id, row], [row.displayRef ?? `${row.prefix}-${row.seq}`, row],
  ] as const))
  const namedSessions = new Map(sessions.flatMap(row => [[row.sessionId, row], [row.displayRef, row]] as const))
  return {
    issue: (identifier: string) => namedIssues.get(identifier) ?? namedIssues.get(identifier.trim()),
    session: (identifier: string) => namedSessions.get(identifier) ?? namedSessions.get(identifier.trim()),
  }
}
const context = namedContext()

describe('resolvePodiumTarget', () => {
  it('does not demand data for files, views or unsupported details', () => {
    const named = { issue: vi.fn(), session: vi.fn() }
    resolvePodiumTarget({ kind: 'file', path: 'a.ts', root: '/w' }, named)
    resolvePodiumTarget({ kind: 'view', path: '/usage', search: '', hash: '' }, named)
    resolvePodiumTarget({ kind: 'issue', issue: 'POD-1', hash: '#detail' }, named)
    resolvePodiumTarget({ kind: 'session', session: 'POD-1-A', search: '?server=elsewhere' }, named)
    expect(named.issue).not.toHaveBeenCalled()
    expect(named.session).not.toHaveBeenCalled()
  })
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

  it('hands a short session id it does not hold to navigateToSession, which asks the server (POD-4637)', () => {
    expect(resolvePodiumTarget({ kind: 'session', session: '214a3887' }, context)).toEqual({
      kind: 'session',
      sessionIdOrRef: '214a3887',
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

  it('opens a secondary file named by the bundle manifest', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: 'shots/a.png' },
        context,
      ),
    ).toMatchObject({ path: 'shots/a.png' })
  })

  it('refuses a missing entry even when the artifact id is real', () => {
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: 'missing.html' },
        context,
      ),
    ).toBeNull()
  })

  it('opens a legacy snapshot primary entry when files metadata is absent', () => {
    const legacy = [
      issue({
        panel: {
          artifacts: [{ path: 'docs/source.md', artifactId: 'art1', entry: 'index.html' }],
        },
      }),
    ]
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: 'index.html' },
        namedContext(legacy),
      ),
    ).toMatchObject({ path: 'index.html' })
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: 'source.md' },
        namedContext(legacy),
      ),
    ).toBeNull()
  })

  it('falls back to the artifact path basename when the panel has no entry', () => {
    const rows = [
      issue({ panel: { artifacts: [{ path: 'docs/proof.html', artifactId: 'art1' }] } }),
    ]
    expect(
      resolvePodiumTarget(
        { kind: 'artifact', issue: 'POD-1606', artifactId: 'art1', entry: null },
        namedContext(rows),
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
