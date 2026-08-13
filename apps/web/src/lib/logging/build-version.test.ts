import { describe, expect, it } from 'vitest'
import { DEV_SERVER_VERSION, pageBuildVersion } from './build-version'

function documentWith(head: string): Document {
  return new DOMParser().parseFromString(
    `<html><head>${head}</head><body></body></html>`,
    'text/html',
  )
}

describe('pageBuildVersion', () => {
  it('names the build from the entry script the page is running', () => {
    expect(
      pageBuildVersion(
        documentWith('<script type="module" crossorigin src="/assets/index-DHMkD0wf.js"></script>'),
      ),
    ).toBe('bundle+DHMkD0wf')
  })

  it('changes when the bundle changes — the property the whole issue is about', () => {
    const before = pageBuildVersion(
      documentWith('<script type="module" src="/assets/index-AAAAAAAA.js"></script>'),
    )
    const after = pageBuildVersion(
      documentWith('<script type="module" src="/assets/index-BBBBBBBB.js"></script>'),
    )
    expect(before).not.toBe(after)
  })

  it('skips a module script with no content hash to find the one that has it', () => {
    expect(
      pageBuildVersion(
        documentWith(
          '<script type="module">console.log(1)</script>' +
            '<script type="module" src="/registerSW.js"></script>' +
            '<script type="module" src="/assets/index-Zz09_-ab.js"></script>',
        ),
      ),
    ).toBe('bundle+Zz09_-ab')
  })

  it('says it is the dev server rather than leaving the record unversioned', () => {
    expect(
      pageBuildVersion(documentWith('<script type="module" src="/src/main.tsx"></script>')),
    ).toBe(DEV_SERVER_VERSION)
    expect(pageBuildVersion(documentWith(''))).toBe(DEV_SERVER_VERSION)
  })
})
