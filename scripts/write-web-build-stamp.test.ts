// scripts/write-web-build-stamp.test.ts
//
// Product version is one string: PODIUM_APP_VERSION or dest+<sha>.
// The chunk hash stays on the stamp as bundleVersion and in a <meta> so the
// page can read the product string without treating the hash as `v`.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildStamp } from '@podium/protocol'
import { bundleVersionFromEntrySrc, bundleVersionFromHtml } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  injectProductVersionMeta,
  resolveWebSourceSha,
  webBuildStamp,
  writeWebBuildStamp,
} from './write-web-build-stamp'

const BUILT_INDEX =
  '<!doctype html><html><head>' +
  '<script type="module" crossorigin src="/assets/index-DHMkD0wf.js"></script>' +
  '<link rel="stylesheet" href="/assets/index-11111111.css">' +
  '</head><body><div id="root"></div></body></html>'

describe('webBuildStamp', () => {
  it('stamps the product version, not the chunk hash, as appVersion', () => {
    const stamp: BuildStamp = webBuildStamp(BUILT_INDEX, new Date(), '47a01e3')
    expect(stamp.appVersion).toBe('dev+47a01e3')
    expect(stamp.sourceSha).toBe('47a01e3')
    expect(stamp.bundleVersion).toBe('bundle+DHMkD0wf')
    expect(stamp.bundleVersion).toBe(bundleVersionFromHtml(BUILT_INDEX))
    expect(stamp.bundleVersion).toBe(bundleVersionFromEntrySrc('/assets/index-DHMkD0wf.js'))
  })

  it('uses the packaged channel version when one is declared', () => {
    const stamp = webBuildStamp(BUILT_INDEX, new Date(), '47a01e3', '0.4.2')
    expect(stamp.appVersion).toBe('0.4.2')
    expect(stamp.sourceSha).toBe('47a01e3')
    expect(stamp.bundleVersion).toBe('bundle+DHMkD0wf')
  })

  it('leaves the wire-schema stamp it already carried intact', () => {
    const stamp = webBuildStamp(BUILT_INDEX, new Date('2026-08-13T00:00:00.000Z'), '47a01e3')
    expect(stamp.wireSchemaDigest).toEqual(expect.any(String))
    expect(stamp.wireSchemaDigest).not.toBe('')
    expect(stamp.wireVersion).toEqual(expect.any(Number))
    expect(stamp.builtAt).toBe('2026-08-13T00:00:00.000Z')
  })

  it('gives two bundles two forensic identities without changing the product version', () => {
    const first = webBuildStamp(BUILT_INDEX, new Date(), '47a01e3')
    const second = webBuildStamp(
      BUILT_INDEX.replace('index-DHMkD0wf.js', 'index-99999999.js'),
      new Date(),
      '47a01e3',
    )
    expect(first.appVersion).toBe(second.appVersion)
    expect(first.bundleVersion).not.toBe(second.bundleVersion)
  })

  it('omits sourceSha when git cannot name HEAD and falls back to dest', () => {
    const stamp = webBuildStamp(BUILT_INDEX)
    expect(stamp.sourceSha).toBeUndefined()
    expect(stamp.appVersion).toBe('dev')
    expect(stamp.bundleVersion).toBe('bundle+DHMkD0wf')
  })

  it('records no bundleVersion when the html has no hashed entry', () => {
    const stamp = webBuildStamp(
      '<!doctype html><html><head><script type="module" src="/src/main.tsx"></script></head></html>',
      new Date(),
      '47a01e3',
    )
    expect(stamp.appVersion).toBe('dev+47a01e3')
    expect(stamp.bundleVersion).toBeUndefined()
  })

  it('fails the write rather than stamping a vite dist it cannot identify', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-'))
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><head><script type="module" src="/src/main.tsx"></script></head></html>',
    )
    expect(() => writeWebBuildStamp(dir, new Date(), '47a01e3')).toThrow(/no hashed module entry/)
  })

  it('writes the product version into the stamp and the html together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-'))
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
    const stamp = writeWebBuildStamp(dir, new Date('2026-08-13T00:00:00.000Z'), '47a01e3', '0.4.2')
    expect(stamp.appVersion).toBe('0.4.2')
    const written = JSON.parse(readFileSync(join(dir, 'podium-build.json'), 'utf8')) as BuildStamp
    expect(written.appVersion).toBe('0.4.2')
    expect(written.bundleVersion).toBe('bundle+DHMkD0wf')
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(
      '<meta name="podium-version" content="0.4.2">',
    )
  })
})

describe('injectProductVersionMeta', () => {
  it('writes the product version where the page will read it', () => {
    const html = injectProductVersionMeta(BUILT_INDEX, 'dev+47a01e3')
    expect(html).toContain('<meta name="podium-version" content="dev+47a01e3">')
  })

  it('replaces a previous product version rather than stacking tags', () => {
    const once = injectProductVersionMeta(BUILT_INDEX, 'dev+aaaaaaa')
    const twice = injectProductVersionMeta(once, '0.4.2')
    expect(twice.match(/podium-version/g)).toHaveLength(1)
    expect(twice).toContain('content="0.4.2"')
    expect(twice).not.toContain('dev+aaaaaaa')
  })
})

describe('resolveWebSourceSha', () => {
  it('uses the seven-character HEAD as sourceSha', () => {
    expect(resolveWebSourceSha('/repo', () => '47A01E3deadbeef\n')).toBe('47a01e3')
  })

  it('omits sourceSha when git is unavailable', () => {
    expect(
      resolveWebSourceSha('/repo', () => {
        throw new Error('not a repository')
      }),
    ).toBeUndefined()
  })
})
