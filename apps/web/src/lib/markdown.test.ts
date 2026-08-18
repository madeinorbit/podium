import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IssueReferenceModel } from '@podium/client-core/viewmodels'
import { afterEach, describe, expect, it } from 'vitest'
import {
  linkifyCodePaths,
  linkifyRefs,
  renderMarkdown,
  sanitizeRenderedMarkdown,
  setKnownRefPrefixes,
} from './markdown'

const stylesPath = ['src/styles.css', 'apps/web/src/styles.css']
  .map((path) => resolve(process.cwd(), path))
  .find(existsSync)
const styles = readFileSync(stylesPath ?? 'src/styles.css', 'utf8')

describe('renderMarkdown', () => {
  it('colourizes add/del/hunk lines in a diff code block', () => {
    const html = renderMarkdown('```diff\n@@ -1 +1 @@\n+added line\n-removed line\n unchanged\n```')
    // The line-level colour rides these span classes (the <pre class="chat-diff">
    // wrapper is stripped by happy-dom's sanitize here, but kept in the browser).
    expect(html).toContain('class="diff-add"')
    expect(html).toContain('class="diff-del"')
    expect(html).toContain('class="diff-hunk"')
  })

  it('detects an unlabelled block that is clearly a unified diff', () => {
    const html = renderMarkdown('```\n@@ -1 +1 @@\n+x\n-y\n```')
    expect(html).toContain('class="diff-add"')
  })

  it('does not flag +++/--- file headers as add/del content', () => {
    const html = renderMarkdown('```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+y\n```')
    // The header lines are escaped text, not coloured content spans.
    expect(html).not.toContain('class="diff-add">+++')
    expect(html).not.toContain('class="diff-del">---')
  })

  it('escapes HTML inside a plain code block', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('still renders ordinary markdown (bold, links)', () => {
    const html = renderMarkdown('**hi** [x](https://e.com)')
    expect(html).toContain('<strong>hi</strong>')
    expect(html).toContain('href="https://e.com"')
  })

  it('opens external links in a new tab with a safe rel', () => {
    const html = renderMarkdown('[x](https://e.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toMatch(/rel="[^"]*noopener[^"]*"/)
    expect(html).toMatch(/rel="[^"]*noreferrer[^"]*"/)
  })

  it('does not add a new-tab target to in-app file-link anchors', () => {
    // file-link anchors carry data-path and no href — they open the file in the
    // deck via a click handler, so they must stay in the same window.
    const html = renderMarkdown('see `apps/web/src/derive.ts` now')
    expect(html).toContain('class="file-link"')
    const fileAnchor = html.slice(html.indexOf('<a class="file-link'))
    expect(fileAnchor.slice(0, fileAnchor.indexOf('>'))).not.toContain('target=')
  })

  it('keeps ref-link fallback anchors in the current window', () => {
    setKnownRefPrefixes(['POD'])
    const html = renderMarkdown('see POD-13')
    const refAnchor = html.slice(html.indexOf('<a class="ref-link'))
    expect(refAnchor.slice(0, refAnchor.indexOf('>'))).not.toContain('target=')
  })

  it('sanitizes unsafe worker HTML before it reaches the DOM', () => {
    const html = sanitizeRenderedMarkdown('<img src="x" onerror="alert(1)"><p>safe</p>')
    expect(html).not.toContain('onerror')
    expect(html).toContain('safe')
  })
})

describe('linkifyCodePaths', () => {
  it('links a path-like token inside a code span', () => {
    const out = linkifyCodePaths('see <code>apps/web/src/derive.ts</code> now')
    expect(out).toContain('class="file-link"')
    expect(out).toContain('data-path="apps/web/src/derive.ts"')
  })

  it('leaves non-path code spans alone', () => {
    const out = linkifyCodePaths('<code>bun test</code>')
    expect(out).not.toContain('file-link')
  })

  it('does not touch text outside code spans', () => {
    const out = linkifyCodePaths('apps/web/src/derive.ts')
    expect(out).not.toContain('file-link')
  })
})

describe('linkifyRefs (#474)', () => {
  afterEach(() => setKnownRefPrefixes([]))

  it('keeps reference chrome independent of the open issue colour', () => {
    const selector = 'a.ref-link {'
    const start = styles.indexOf(selector)
    const end = styles.indexOf('\n}', start)
    const rule = styles.slice(start, end)

    expect(start, `${selector} not found in styles.css`).toBeGreaterThan(-1)
    expect(rule).toContain('--ref-accent: var(--info)')
    expect(rule).not.toContain('var(--issue')
  })

  it('is a no-op with no registered prefixes', () => {
    setKnownRefPrefixes([])
    expect(linkifyRefs('see POD-13')).toBe('see POD-13')
  })

  it('linkifies issue, session and draft refs for registered prefixes', () => {
    setKnownRefPrefixes(['POD'])
    const out = linkifyRefs('POD-13 and POD-13-A and POD-DRAFT-3')
    expect(out).toContain(
      '<a class="ref-link ref-link--issue" href="#POD-13" data-ref="POD-13">POD-13</a>',
    )
    expect(out).toContain(
      '<a class="ref-link ref-link--session" href="#POD-13-A" data-ref="POD-13-A">POD-13-A</a>',
    )
    expect(out).toContain(
      '<a class="ref-link ref-link--session" href="#POD-DRAFT-3" data-ref="POD-DRAFT-3">POD-DRAFT-3</a>',
    )
  })

  it('leaves unknown prefixes as plain text (avoids UTF-8 false positives)', () => {
    setKnownRefPrefixes(['POD'])
    expect(linkifyRefs('encoded as UTF-8 here')).toBe('encoded as UTF-8 here')
    expect(linkifyRefs('ZZZ-9 unknown')).toBe('ZZZ-9 unknown')
  })

  it('never links inside an existing anchor', () => {
    setKnownRefPrefixes(['POD'])
    expect(linkifyRefs('<a href="x">POD-13</a>')).toBe('<a href="x">POD-13</a>')
  })

  it('unwraps a code span that is nothing but a ref', () => {
    setKnownRefPrefixes(['POD'])
    expect(linkifyRefs('filed as <code>POD-13</code> today')).toBe(
      'filed as <a class="ref-link ref-link--issue" href="#POD-13" data-ref="POD-13">POD-13</a> today',
    )
  })

  it('leaves a ref quoted inside a longer code span literal', () => {
    setKnownRefPrefixes(['POD'])
    const cmd = '<code>podium issue close POD-13</code>'
    expect(linkifyRefs(cmd)).toBe(cmd)
  })

  it('leaves an unregistered prefix wrapped in its code span', () => {
    setKnownRefPrefixes(['POD'])
    expect(linkifyRefs('<code>ZZZ-9</code>')).toBe('<code>ZZZ-9</code>')
  })

  it('never touches a fenced block, even one holding only a ref', () => {
    setKnownRefPrefixes(['POD'])
    const block = '<pre><code>POD-13</code></pre>'
    expect(linkifyRefs(block)).toBe(block)
    const langBlock = '<pre><code class="language-ts">POD-13 here</code></pre>'
    expect(linkifyRefs(langBlock)).toBe(langBlock)
  })

  it('keeps linkifying prose after an unwrapped code span', () => {
    setKnownRefPrefixes(['POD'])
    const out = linkifyRefs('<code>POD-13</code> blocks POD-14')
    expect(out).toContain('data-ref="POD-13"')
    expect(out).toContain('data-ref="POD-14"')
    expect(out).not.toContain('<code>')
  })

  it('carries live stage attributes onto an unwrapped code span', () => {
    setKnownRefPrefixes(['POD'])
    const model: IssueReferenceModel = {
      ref: 'POD-13',
      issueId: null,
      title: 'Ref chips',
      stage: 'in_progress',
      availability: 'present',
      accessibleLabel: 'POD-13 in progress',
    }
    const out = linkifyRefs('<code>POD-13</code>', new Map([['POD-13', model]]))
    expect(out).toContain('data-issue-stage="in_progress"')
    expect(out).toContain('aria-label="POD-13 in progress"')
  })

  it('renderMarkdown linkifies a backticked ref', () => {
    setKnownRefPrefixes(['POD'])
    const html = renderMarkdown('filed as `POD-13` with an edge')
    expect(html).toContain('data-ref="POD-13"')
    expect(html).not.toContain('<code>')
  })

  it('renderMarkdown wires the ref pass end-to-end', () => {
    setKnownRefPrefixes(['POD'])
    const html = renderMarkdown('fixed in POD-13')
    expect(html).toContain('class="ref-link ref-link--issue"')
    expect(html).toContain('data-ref="POD-13"')
  })
})
