// scripts/write-web-build-stamp.test.ts
//
// POD-1965 — the web half of "which build produced this log line?".
//
// The defect this guards was not a wrong value: the stamp wrote keys nobody read
// (`wireSchemaDigest`, `wireVersion`, `builtAt`) while the page read `appVersion`,
// and so every web record shipped with no `v` at all. No unit test of either side
// could see that, because each side was internally consistent.
//
// What is asserted here is therefore the CONTRACT, from both ends: the key the
// page reads is present, and its value is what the page derives for itself from
// the same html — the same function, called from both places.
//
// The absent case is the load-bearing half. Silent absence is exactly how this
// shipped, so an index.html with no hashed entry must fail the build rather than
// write a stamp without `appVersion`.

import type { BuildStamp } from '@podium/protocol'
import { bundleVersionFromEntrySrc, bundleVersionFromHtml } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { webBuildStamp } from './write-web-build-stamp'

const BUILT_INDEX =
  '<!doctype html><html><head>' +
  '<script type="module" crossorigin src="/assets/index-DHMkD0wf.js"></script>' +
  '<link rel="stylesheet" href="/assets/index-11111111.css">' +
  '</head><body><div id="root"></div></body></html>'

describe('webBuildStamp', () => {
  it('stamps the build identity under the key the page reads', () => {
    const stamp: BuildStamp = webBuildStamp(BUILT_INDEX)
    expect(stamp.appVersion).toBe('bundle+DHMkD0wf')
    // The two ends agree because they run the same derivation: this is the
    // assertion that would have failed when the writer wrote no `appVersion`.
    expect(stamp.appVersion).toBe(bundleVersionFromHtml(BUILT_INDEX))
    // And it agrees with what the running PAGE computes from its own entry
    // script tag — the third end of the same contract (apps/web/src/lib/logging).
    expect(stamp.appVersion).toBe(bundleVersionFromEntrySrc('/assets/index-DHMkD0wf.js'))
  })

  it('leaves the wire-schema stamp it already carried intact', () => {
    const stamp = webBuildStamp(BUILT_INDEX, new Date('2026-08-13T00:00:00.000Z'))
    expect(stamp.wireSchemaDigest).toEqual(expect.any(String))
    expect(stamp.wireSchemaDigest).not.toBe('')
    expect(stamp.wireVersion).toEqual(expect.any(Number))
    expect(stamp.builtAt).toBe('2026-08-13T00:00:00.000Z')
  })

  it('gives two builds two identities', () => {
    expect(webBuildStamp(BUILT_INDEX).appVersion).not.toBe(
      webBuildStamp(BUILT_INDEX.replace('index-DHMkD0wf.js', 'index-99999999.js')).appVersion,
    )
  })

  it('fails the build rather than stamping a bundle it cannot identify', () => {
    expect(() =>
      webBuildStamp(
        '<!doctype html><html><head><script type="module" src="/src/main.tsx"></script></head></html>',
      ),
    ).toThrow(/no hashed module entry/)
  })
})
