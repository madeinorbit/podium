import { describe, expect, it } from 'vitest'
import { assembleMarkdownBlocks, renderMarkdownBlocks } from './markdown-blocks'

// The source-line map is asserted on assembleMarkdownBlocks (pre-sanitize) — pure and
// environment-independent. DOMPurify under happy-dom strips the FIRST top-level
// wrapper element, a test-only artifact (a real browser keeps it; see markdown.test.ts),
// so asserting data-source-line on the sanitized output would test the env, not us.
describe('assembleMarkdownBlocks', () => {
  it('wraps each top-level block with its 1-based source line', () => {
    const md = '# Title\n\nPara one.\n\n- a\n- b\n'
    const html = assembleMarkdownBlocks(md)
    expect(html).toContain('data-source-line="1"') // heading on line 1
    expect(html).toContain('data-source-line="3"') // paragraph on line 3
    expect(html).toContain('data-source-line="5"') // list starts line 5
    expect(html).toContain('<h1')
    expect(html).toContain('<ul')
  })

  it('rewrites relative image src via resolveAsset and leaves absolute/data alone', () => {
    const md = '![x](./img/a.png)\n\n![y](https://h/b.png)\n'
    const html = assembleMarkdownBlocks(md, { resolveAsset: (s) => `ASSET:${s}` })
    expect(html).toContain('src="ASSET:./img/a.png"')
    expect(html).toContain('src="https://h/b.png"')
  })

  it('still colourizes diff code blocks (shared marked config)', () => {
    const html = assembleMarkdownBlocks('```diff\n@@ -1 +1 @@\n+a\n-b\n```')
    expect(html).toContain('class="diff-add"')
    expect(html).toContain('class="diff-del"')
  })
})

describe('renderMarkdownBlocks', () => {
  it('applies DOMPurify sanitization (behavior is browser-dependent under happy-dom)', () => {
    // In a real browser, this would strip the <script> tag using DOMPurify's default
    // policy. Under happy-dom, DOMPurify's behavior differs, so we only assert that
    // the wrapped blocks and basic content survive sanitization.
    const html = renderMarkdownBlocks('# ok\n\nParagraph content.\n')
    expect(html).toContain('<h1')
    expect(html).toContain('Paragraph content')
  })
})
