import { describe, expect, it } from 'vitest'
import { pageBuildVersion } from './build-version'

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
      pageBuildVersion(
        documentWith('<meta name="podium-version" content="0.4.2">'),
        'dev+47a01e3',
      ),
    ).toBe('0.4.2')
  })

  it('uses the dest-server define when the page has no stamp meta', () => {
    expect(
      pageBuildVersion(documentWith('<script type="module" src="/src/main.tsx"></script>'), 'dev+47a01e3'),
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
