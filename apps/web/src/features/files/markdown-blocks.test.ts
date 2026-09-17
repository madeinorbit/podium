// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { setKnownPodiumOrigins } from '@/lib/podium-link'
import { assembleMarkdownBlocksUnsafe, renderMarkdownBlocks } from './markdown-blocks'

const HOME = 'http://127.0.0.1:8787'

afterEach(() => {
  setKnownPodiumOrigins([])
  document.body.innerHTML = ''
})

describe('assembleMarkdownBlocksUnsafe', () => {
  it('wraps each top-level block with its 1-based source line', () => {
    const md = '# Title\n\nPara one.\n\n- a\n- b\n'
    const html = assembleMarkdownBlocksUnsafe(md)
    expect(html).toContain('data-source-line="1"') // heading on line 1
    expect(html).toContain('data-source-line="3"') // paragraph on line 3
    expect(html).toContain('data-source-line="5"') // list starts line 5
    expect(html).toContain('<h1')
    expect(html).toContain('<ul')
  })

  it('rewrites relative image src via resolveAsset and leaves absolute/data alone', () => {
    const md = '![x](./img/a.png)\n\n![y](https://h/b.png)\n'
    const html = assembleMarkdownBlocksUnsafe(md, { resolveAsset: (s) => `ASSET:${s}` })
    expect(html).toContain('src="ASSET:./img/a.png"')
    expect(html).toContain('src="https://h/b.png"')
  })

  it('still colourizes diff code blocks (shared marked config)', () => {
    const html = assembleMarkdownBlocksUnsafe('```diff\n@@ -1 +1 @@\n+a\n-b\n```')
    expect(html).toContain('class="diff-add"')
    expect(html).toContain('class="diff-del"')
  })
})

describe('renderMarkdownBlocks', () => {
  it('keeps every source-line anchor through sanitization, including the first block', () => {
    const html = renderMarkdownBlocks('# a\n\nsecond para\n\nthird para\n')
    expect(html).toContain('data-source-line="1"')
    expect(html).toContain('data-source-line="3"')
    expect(html).toContain('data-source-line="5"')
  })

  it('strips executable markup while retaining safe images and source anchors', () => {
    const html = renderMarkdownBlocks(
      '# safe\n\n<img src="x" onerror="alert(1)"><script>alert(1)</script>',
    )
    expect(html).toContain('data-source-line="1"')
    expect(html).toContain('<img src="x">')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<script')
  })

  it('renders benign markdown structure', () => {
    const html = renderMarkdownBlocks('# ok\n\nParagraph content.\n')
    expect(html).toContain('<h1')
    expect(html).toContain('Paragraph content')
  })

  it('renders hostless Podium links against the active server', () => {
    setKnownPodiumOrigins([HOME])
    const html = renderMarkdownBlocks('[issue](/issues/POD-1606)')
    expect(html).toContain(`href="${HOME}/issues/POD-1606"`)
    expect(html).toContain('data-podium-link')
  })

  it('keeps a custom-scheme file href and exact fallback bytes in previews', () => {
    setKnownPodiumOrigins([HOME])
    const href =
      'podium://file?label=hello%20world&&root=%2fw&path=%2fw%2fa.ts&path=%2Fduplicate&signature=a%2Fb%3D#x%2fy'
    document.body.innerHTML = renderMarkdownBlocks(`[file](${href})`)
    const link = document.querySelector('a') as HTMLAnchorElement
    expect(link.getAttribute('data-podium-link-source')).toBe(href)
    expect(link.getAttribute('href')).toBe(
      `${HOME}/file?label=hello%20world&&root=%2fw&path=%2fw%2fa.ts&path=%2Fduplicate&signature=a%2Fb%3D#x%2fy`,
    )
  })

  it('derives resolver markers from the href even when raw HTML contains a quoted >', () => {
    setKnownPodiumOrigins([HOME])
    document.body.innerHTML = renderMarkdownBlocks(
      '<a title=">" href="https://example.com/guide" data-podium-link-source="/issues/POD-1606" data-podium-link-candidate data-podium-link>guide</a>',
    )
    const link = document.querySelector('a') as HTMLAnchorElement
    expect(link.getAttribute('data-podium-link-source')).toBe('https://example.com/guide')
    expect(link.hasAttribute('data-podium-link-candidate')).toBe(true)
    expect(link.hasAttribute('data-podium-link')).toBe(false)
  })
})
