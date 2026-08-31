import { asArtifactId, asIssueId, type IssuePanelArtifact, type IssueWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  endAtTagBoundary,
  htmlDataUri,
  htmlWithBase,
  issueArtifactHref,
  issueArtifactPreview,
} from './issue-artifacts'

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

describe('htmlWithBase', () => {
  const href = 'https://podium.local/files/artifact/iss/art/deck.html'

  it('injects <base> right after <head> so relative bundle refs resolve', () => {
    const out = htmlWithBase('<html><head><title>d</title></head><body/></html>', href)
    expect(out).toContain(`<head><base href="${href}"><title>`)
  })

  it('keeps the doctype first — a tag before it would trigger quirks mode', () => {
    const out = htmlWithBase('<!DOCTYPE html><p>hi</p>', href)
    expect(out.startsWith('<!DOCTYPE html><base href=')).toBe(true)
  })

  it('prepends when the document is a bare fragment', () => {
    expect(htmlWithBase('<p>hi</p>', href)).toBe(`<base href="${href}"><p>hi</p>`)
  })

  it('respects a base the document already declares', () => {
    const doc = '<head><base href="https://elsewhere/"></head>'
    expect(htmlWithBase(doc, href)).toBe(doc)
  })

  it('escapes quotes so a hostile URL cannot break out of the attribute', () => {
    const out = htmlWithBase('<p/>', 'https://x/a"onload="alert(1)')
    expect(out).toContain('href="https://x/a&quot;onload=&quot;alert(1)"')
  })
})

describe('endAtTagBoundary', () => {
  it('drops a tag the cap cut in half', () => {
    expect(endAtTagBoundary('<p>a</p><div class="w')).toBe('<p>a</p>')
    expect(endAtTagBoundary('<p>a</p><')).toBe('<p>a</p>')
  })

  it('leaves a document that ends on a complete tag alone', () => {
    expect(endAtTagBoundary('<p>a</p>')).toBe('<p>a</p>')
    expect(endAtTagBoundary('<p>trailing text')).toBe('<p>trailing text')
    expect(endAtTagBoundary('')).toBe('')
  })

  it('is not fooled by a < inside earlier text', () => {
    expect(endAtTagBoundary('<p>a &lt; b</p><span')).toBe('<p>a &lt; b</p>')
    expect(endAtTagBoundary('<p>1 < 2</p>')).toBe('<p>1 < 2</p>')
  })
})

describe('htmlDataUri', () => {
  it('base64-encodes UTF-8 the way the platform decoders expect', () => {
    // atob sees the raw bytes; TextDecoder turns them back into the string.
    const roundtrip = (s: string) => {
      const uri = htmlDataUri(s)
      const b64 = uri.slice(uri.indexOf(',') + 1)
      return new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)))
    }
    expect(htmlDataUri('').startsWith('data:text/html;charset=utf-8;base64,')).toBe(true)
    for (const doc of ['<p>a</p>', '<p>ab</p>', '<p>abc</p>', '<h1>héllo ⣿ 日本語</h1>']) {
      expect(roundtrip(doc)).toBe(doc)
    }
  })

  it('pads to a length divisible by four', () => {
    for (const doc of ['a', 'ab', 'abc', 'abcd']) {
      const b64 = htmlDataUri(doc).split(',')[1] ?? ''
      expect(b64.length % 4).toBe(0)
    }
  })
})
