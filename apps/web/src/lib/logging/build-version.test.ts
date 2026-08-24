import { describe, expect, it } from 'vitest'
import { pageBuildDigest, pageBuildVersion, pageBundleVersion } from './build-version'

function documentWith(head: string): Document {
  return new DOMParser().parseFromString(
    `<html><head>${head}</head><body></body></html>`,
    'text/html',
  )
}

describe('pageBuildVersion', () => {
  it('reads the product version the stamp wrote into the page', () => {
    expect(
      pageBuildVersion(
        documentWith('<meta name="podium-version" content="dev+47a01e3">'),
        'dev-server',
      ),
    ).toBe('dev+47a01e3')
  })

  it('prefers the packaged channel version on the page over a dev+sha define', () => {
    expect(
      pageBuildVersion(documentWith('<meta name="podium-version" content="0.4.2">'), 'dev+47a01e3'),
    ).toBe('0.4.2')
  })

  it('uses the dest-server define when the page has no stamp meta', () => {
    expect(
      pageBuildVersion(
        documentWith('<script type="module" src="/src/main.tsx"></script>'),
        'dev+47a01e3',
      ),
    ).toBe('dev+47a01e3')
  })

  it('does not treat the entry chunk hash as the product version', () => {
    expect(
      pageBuildVersion(
        documentWith('<script type="module" src="/assets/index-DHMkD0wf.js"></script>'),
        undefined,
      ),
    ).toBe('dev')
  })

  it('falls back to dev when neither the page nor the define names a version', () => {
    expect(pageBuildVersion(documentWith(''), undefined)).toBe('dev')
    expect(pageBuildVersion(documentWith(''), '')).toBe('dev')
  })
})

describe('pageBuildDigest', () => {
  it('reads the source identity embedded in the loaded page', () => {
    expect(
      pageBuildDigest(documentWith('<meta name="podium-source-digest" content="47A01E3deadbeef">')),
    ).toBe('47a01e3')
  })

  it('uses the development define when source is served without stamped HTML', () => {
    expect(pageBuildDigest(documentWith(''), '47a01e3')).toBe('47a01e3')
  })

  it('does not invent an identity when neither source can name one', () => {
    expect(pageBuildDigest(documentWith(''), undefined)).toBeUndefined()
  })
})

/**
 * WHICH BYTES ARE RUNNING (POD-2721).
 *
 * Read off the entry `<script>` the browser actually loaded rather than out of a
 * stamped meta, because that URL is the one thing about this page that cannot be
 * stamped wrong: it IS the request that produced the running code. The same URL
 * appears in every crash stack.
 */
describe('pageBundleVersion', () => {
  it('names the entry chunk the page was loaded from', () => {
    expect(
      pageBundleVersion(documentWith('<script type="module" src="/assets/index-Bw5YMffE.js"></script>')),
    ).toBe('bundle+Bw5YMffE')
  })

  it('prefers the module entry over a hashed classic script beside it', () => {
    expect(
      pageBundleVersion(
        documentWith(
          '<script src="/assets/analytics-DEADBEEF.js"></script>' +
            '<script type="module" src="/assets/index-Bw5YMffE.js"></script>',
        ),
      ),
    ).toBe('bundle+Bw5YMffE')
  })

  it('reads the phone export, whose entry is a plain script', () => {
    expect(
      pageBundleVersion(
        documentWith(
          '<script src="/mobile/_expo/static/js/web/entry-a833d1a61f7a6d85a8c7fe49922500f0.js"></script>',
        ),
      ),
    ).toBe('bundle+a833d1a61f7a6d85a8c7fe49922500f0')
  })

  /**
   * CAN SAY NO. Vite serving source has no hashed entry, and a page that cannot
   * name its own bundle must report that rather than a stand-in — an invented
   * name here is a reload offered on evidence nobody has.
   */
  it('names nothing when the entry carries no content hash', () => {
    expect(pageBundleVersion(documentWith('<script type="module" src="/src/main.tsx"></script>'))).toBeUndefined()
  })

  it('names nothing when the page has no entry script at all', () => {
    expect(pageBundleVersion(documentWith(''))).toBeUndefined()
  })
})
