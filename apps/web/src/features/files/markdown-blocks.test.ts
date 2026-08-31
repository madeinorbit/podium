import { afterEach, describe, expect, it } from 'vitest'
import { setKnownPodiumOrigins } from '@/lib/podium-link'
import { assembleMarkdownBlocksUnsafe, renderMarkdownBlocks } from './markdown-blocks'

const HOME = 'http://127.0.0.1:8787'

afterEach(() => {
  setKnownPodiumOrigins([])
  document.body.innerHTML = ''
})

// The source-line map is asserted on assembleMarkdownBlocksUnsafe (pre-sanitize) — pure
// and environment-independent. DOMPurify under happy-dom strips the FIRST top-level
// wrapper element (a test-only artifact — a real browser keeps it; see markdown.test.ts),
// so asserting data-source-line on the FIRST sanitized block would test the env, not us.
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
  // Guards the feature-critical invariant: data-source-line anchors must survive
  // sanitization (scroll-sync depends on them). happy-dom strips only the FIRST
  // top-level wrapper, so assert on later blocks, which survive.
  it('keeps data-source-line anchors through sanitization (non-first blocks)', () => {
    const html = renderMarkdownBlocks('# a\n\nsecond para\n\nthird para\n')
    expect(html).toContain('data-source-line="3"')
    expect(html).toContain('data-source-line="5"')
  })

  // NOTE: dangerous-markup removal (e.g. <script> stripping) is DOMPurify's job but is
  // NOT verifiable here — DOMPurify is effectively a no-op under happy-dom in this env.
  // It works in a real browser (same default policy as markdown.ts). Sanitization is
  // therefore gated by the runtime/Playwright check in the plan's Task 9, not a unit test.
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
})
