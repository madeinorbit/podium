import { describe, expect, it } from 'vitest'
import { linkifyCodePaths, renderMarkdown } from './markdown'

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
