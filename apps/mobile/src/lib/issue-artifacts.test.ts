import { asArtifactId, asIssueId, type IssuePanelArtifact, type IssueWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { issueArtifactHref, issueArtifactPreview } from './issue-artifacts'

function issue(overrides: Partial<IssueWire> = {}): IssueWire {
  return {
    id: asIssueId('iss_art'),
    seq: 1,
    title: 'Task',
    repoPath: '/repo',
    worktreePath: '/repo/.worktrees/POD-1',
    ...overrides,
  } as IssueWire
}

const shot: IssuePanelArtifact = {
  path: '/repo/.worktrees/POD-1/shot.png',
  title: 'Shot',
  addedAt: '2026-08-13T00:00:00.000Z',
  artifactId: asArtifactId('art_1'),
}

describe('issueArtifactHref', () => {
  it('prefers the permanent store when the artifact has an id', () => {
    const href = issueArtifactHref(issue(), shot, 'https://podium.local')
    expect(href).toContain('/files/artifact/')
    expect(href).toContain(encodeURIComponent('iss_art'))
    expect(href).toContain(encodeURIComponent('art_1'))
  })

  it('falls back to the live worktree route for a path-only entry', () => {
    const href = issueArtifactHref(
      issue(),
      { path: '/repo/.worktrees/POD-1/notes.md', addedAt: shot.addedAt },
      'https://podium.local',
    )
    expect(href).toContain('/files/asset?')
    expect(href).toContain('notes.md')
  })
})

describe('issueArtifactPreview', () => {
  it('classifies images, html concepts, and markdown for in-app viewing', () => {
    expect(issueArtifactPreview('a.png')).toBe('image')
    expect(issueArtifactPreview('deck.html')).toBe('html')
    expect(issueArtifactPreview('notes.md')).toBe('markdown')
    expect(issueArtifactPreview('log.txt')).toBe('text')
    expect(issueArtifactPreview('blob.bin')).toBe('file')
  })
})
