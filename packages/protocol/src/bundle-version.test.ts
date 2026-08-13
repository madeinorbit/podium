import { describe, expect, it } from 'vitest'
import { bundleVersionFromEntrySrc, bundleVersionFromHtml } from './bundle-version'

describe('bundleVersionFromEntrySrc', () => {
  it('names the build by the entry chunk hash a crash stack also names', () => {
    expect(bundleVersionFromEntrySrc('/assets/index-DHMkD0wf.js')).toBe('bundle+DHMkD0wf')
  })

  it('reads the hash through an absolute URL with a query string', () => {
    expect(bundleVersionFromEntrySrc('https://host:55555/assets/index-a1B2c3D4.js?v=1')).toBe(
      'bundle+a1B2c3D4',
    )
  })

  it('distinguishes two builds, which is the whole point', () => {
    expect(bundleVersionFromEntrySrc('/assets/index-AAAAAAAA.js')).not.toBe(
      bundleVersionFromEntrySrc('/assets/index-BBBBBBBB.js'),
    )
  })

  it("names a Metro entry by the hash in the phone export's filename", () => {
    expect(
      bundleVersionFromEntrySrc(
        '/mobile/_expo/static/js/web/entry-a074e4f437a1ee92fdb168054dc07da9.js',
      ),
    ).toBe('bundle+a074e4f437a1ee92fdb168054dc07da9')
  })

  it('distinguishes two phone exports', () => {
    expect(bundleVersionFromEntrySrc(`/x/entry-${'a'.repeat(32)}.js`)).not.toBe(
      bundleVersionFromEntrySrc(`/x/entry-${'b'.repeat(32)}.js`),
    )
  })

  it.each([
    ['the vite dev server serving source', '/src/main.tsx'],
    ['an unhashed filename', '/assets/index.js'],
    ['a hash of the wrong length', '/assets/index-ABC.js'],
    ['a hash between the two known lengths', `/x/entry-${'a'.repeat(20)}.js`],
    ['a non-script src', '/assets/index-DHMkD0wf.css'],
    ['nothing at all', ''],
  ])('has no build identity to report for %s', (_name, src) => {
    expect(bundleVersionFromEntrySrc(src)).toBeUndefined()
  })
})

describe('bundleVersionFromHtml', () => {
  const html = (body: string) => `<!doctype html><html><head>${body}</head><body></body></html>`

  it('reads the module entry vite emitted', () => {
    expect(
      bundleVersionFromHtml(
        html('<script type="module" crossorigin src="/assets/index-Zz09_-ab.js"></script>'),
      ),
    ).toBe('bundle+Zz09_-ab')
  })

  it('ignores a modulepreload of a lazy chunk and takes the entry', () => {
    expect(
      bundleVersionFromHtml(
        html(
          '<link rel="modulepreload" href="/assets/vendor-11111111.js">' +
            '<script type="module" src="/assets/index-22222222.js"></script>',
        ),
      ),
    ).toBe('bundle+22222222')
  })

  it('reports nothing when the html carries no hashed module entry', () => {
    expect(
      bundleVersionFromHtml(html('<script type="module" src="/src/main.tsx"></script>')),
    ).toBeUndefined()
  })

  it('reads the classic entry Metro emits for the phone export', () => {
    expect(
      bundleVersionFromHtml(
        html(
          '<script src="/mobile/_expo/static/js/web/entry-a074e4f437a1ee92fdb168054dc07da9.js" defer></script>',
        ),
      ),
    ).toBe('bundle+a074e4f437a1ee92fdb168054dc07da9')
  })

  it('still prefers the module entry when a hashed classic script precedes it', () => {
    expect(
      bundleVersionFromHtml(
        html(
          '<script src="/assets/polyfill-11111111.js"></script>' +
            '<script type="module" src="/assets/index-22222222.js"></script>',
        ),
      ),
    ).toBe('bundle+22222222')
  })
})
