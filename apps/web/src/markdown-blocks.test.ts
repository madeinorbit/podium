import { describe, expect, it } from 'vitest'
import { renderMarkdownBlocks } from './markdown-blocks'

describe('renderMarkdownBlocks', () => {
  it('wraps each top-level block with its 1-based source line', () => {
    const md = '# Title\n\nPara one.\n\n- a\n- b\n'
    const html = renderMarkdownBlocks(md)
    expect(html).toContain('data-source-line="1"') // heading on line 1
    expect(html).toContain('data-source-line="3"') // paragraph on line 3
    expect(html).toContain('data-source-line="5"') // list starts line 5
    expect(html).toContain('<h1')
    expect(html).toContain('<ul')
  })

  it('rewrites relative image src via resolveAsset and leaves absolute/data alone', () => {
    const md = '![x](./img/a.png)\n\n![y](https://h/b.png)\n'
    const html = renderMarkdownBlocks(md, { resolveAsset: (s) => `ASSET:${s}` })
    expect(html).toContain('src="ASSET:./img/a.png"')
    expect(html).toContain('src="https://h/b.png"')
  })

  it('still colourizes diff code blocks (shared marked config)', () => {
    const html = renderMarkdownBlocks('```diff\n@@ -1 +1 @@\n+a\n-b\n```')
    expect(html).toContain('class="diff-add"')
    expect(html).toContain('class="diff-del"')
  })
})
