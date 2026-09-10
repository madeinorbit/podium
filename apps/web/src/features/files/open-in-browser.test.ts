import type { FileScope } from '@podium/client-core/viewmodels'
import { asMachineId, asArtifactId, asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { downloadFileUrl, rawFileUrl } from './open-in-browser'

const httpOrigin = 'https://podium.test'

describe('rawFileUrl', () => {
  it('points a worktree file at the asset route', () => {
    const scope: FileScope = { kind: 'worktree', root: '/repo' }
    expect(rawFileUrl({ httpOrigin, scope, path: '/repo/.design/mock.html' })).toBe(
      'https://podium.test/files/asset?root=%2Frepo&path=%2Frepo%2F.design%2Fmock.html',
    )
  })

  it('carries the machine for a remote worktree', () => {
    const scope: FileScope = { kind: 'worktree', root: '/repo', machineId: asMachineId('m1') }
    expect(rawFileUrl({ httpOrigin, scope, path: '/repo/a.html' })).toContain('machineId=m1')
  })

  it('scopes a session file to its session', () => {
    const scope: FileScope = { kind: 'session', sessionId: asSessionId('s1') }
    expect(rawFileUrl({ httpOrigin, scope, path: '/w/notes.md' })).toBe(
      'https://podium.test/files/asset?sessionId=s1&path=%2Fw%2Fnotes.md',
    )
  })

  it('serves an artifact snapshot from its path-style route', () => {
    const scope: FileScope = {
      kind: 'artifact',
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('art_1'),
    }
    expect(rawFileUrl({ httpOrigin, scope, path: 'sub/page.html' })).toBe(
      'https://podium.test/files/artifact/iss_1/art_1/sub/page.html',
    )
  })

  it('handles an artifact entry sitting at the snapshot root', () => {
    const scope: FileScope = {
      kind: 'artifact',
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('art_1'),
    }
    expect(rawFileUrl({ httpOrigin, scope, path: 'page.html' })).toBe(
      'https://podium.test/files/artifact/iss_1/art_1/page.html',
    )
  })

  it('has no URL for a directory-shaped path', () => {
    const scope: FileScope = { kind: 'worktree', root: '/repo' }
    expect(rawFileUrl({ httpOrigin, scope, path: '/repo/dir/' })).toBeNull()
  })
})

describe('downloadFileUrl', () => {
  it('appends the download flag to a query-style asset URL and names the basename', () => {
    const scope: FileScope = { kind: 'session', sessionId: asSessionId('s1') }
    expect(downloadFileUrl({ httpOrigin, scope, path: '/w/notes.md' })).toEqual({
      url: 'https://podium.test/files/asset?sessionId=s1&path=%2Fw%2Fnotes.md&download=1',
      name: 'notes.md',
    })
  })

  it('starts the query on a path-style artifact URL', () => {
    const scope: FileScope = {
      kind: 'artifact',
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('abc'),
    }
    const out = downloadFileUrl({ httpOrigin, scope, path: 'shots/a.png' })
    expect(out?.url).toMatch(/\/files\/artifact\/.*\?download=1$/)
    expect(out?.name).toBe('a.png')
  })

  it('returns null when there is no file name', () => {
    const scope: FileScope = { kind: 'session', sessionId: asSessionId('s1') }
    expect(downloadFileUrl({ httpOrigin, scope, path: '/w/' })).toBeNull()
  })
})
