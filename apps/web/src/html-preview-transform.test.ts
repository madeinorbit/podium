// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildStaticHtmlPreview, rewriteCssUrls } from './html-preview-transform'

const resolveAsset = (baseDir: string, value: string): string =>
  `/files/asset?base=${encodeURIComponent(baseDir)}&src=${encodeURIComponent(value)}`

describe('rewriteCssUrls', () => {
  it('rewrites relative url() values and leaves remote/data URLs untouched', () => {
    expect(
      rewriteCssUrls(
        `body{background:url("./bg.png")} .x{mask:url(data:image/png;base64,abc)} .y{background:url(https://x/y.png)}`,
        '/repo/site',
        resolveAsset,
      ),
    ).toContain('/files/asset?base=%2Frepo%2Fsite&src=.%2Fbg.png')
  })
})

describe('buildStaticHtmlPreview', () => {
  it('strips scripts and inline event handlers', () => {
    const html = buildStaticHtmlPreview({
      html: '<button onclick="alert(1)">Hi</button><script>alert(2)</script>',
      fileDir: '/repo',
      resolveAsset,
      readTextAsset: () => undefined,
    })

    expect(html).toContain('<button>Hi</button>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<script')
  })

  it('rewrites relative image assets', () => {
    const html = buildStaticHtmlPreview({
      html: '<img src="./hero.png"><img src="https://example.com/logo.png">',
      fileDir: '/repo/docs',
      resolveAsset,
      readTextAsset: () => undefined,
    })

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const images = Array.from(doc.querySelectorAll('img'))
    expect(images[0]?.getAttribute('src')).toBe('/files/asset?base=%2Frepo%2Fdocs&src=.%2Fhero.png')
    expect(images[1]?.getAttribute('src')).toBe('https://example.com/logo.png')
  })

  it('inlines a linked stylesheet when content is available and rewrites css urls relative to the css file', () => {
    const html = buildStaticHtmlPreview({
      html: '<link rel="stylesheet" href="./style/site.css"><h1>Doc</h1>',
      fileDir: '/repo/docs',
      resolveAsset,
      readTextAsset: (absPath) =>
        absPath === '/repo/docs/style/site.css'
          ? '.hero{background:url("../img/hero.png")}'
          : undefined,
    })

    expect(html).not.toContain('<link')
    expect(html).toContain('data-podium-inlined-href="./style/site.css"')
    expect(html).toContain('/files/asset?base=%2Frepo%2Fdocs%2Fstyle&src=..%2Fimg%2Fhero.png')
  })
})
