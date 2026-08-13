// scripts/write-web-build-stamp.test.ts
//
// Product version is one string: PODIUM_APP_VERSION or dev+<sha>.
// The chunk hash stays on the stamp as bundleVersion and in a <meta> so the
// page can read the product string without treating the hash as `v`.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
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

  it('omits sourceSha when git cannot name HEAD and falls back to dev', () => {
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

// The stamp is the LAST thing a web build writes, so `podium-build.json` means "this
// dist is complete" (POD-1986). Precompression therefore runs BEFORE it, and the stamp
// rewrites an index.html that already has .br/.gz siblings — which it must refresh, or
// the server serves a compressed page carrying the previous build's version meta.
describe('writeWebBuildStamp and pre-compressed index.html', () => {
  it('refreshes the .br and .gz siblings it invalidated by rewriting index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-'))
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
    // What precompress-dist.ts wrote: the page BEFORE the version meta went in.
    writeFileSync(join(dir, 'index.html.br'), brotliCompressSync(Buffer.from(BUILT_INDEX)))
    writeFileSync(join(dir, 'index.html.gz'), gzipSync(Buffer.from(BUILT_INDEX)))

    writeWebBuildStamp(dir, new Date(), '47a01e3', '0.4.2')

    const html = readFileSync(join(dir, 'index.html'), 'utf8')
    expect(html).toContain('<meta name="podium-version" content="0.4.2">')
    expect(brotliDecompressSync(readFileSync(join(dir, 'index.html.br'))).toString('utf8')).toBe(
      html,
    )
    expect(gunzipSync(readFileSync(join(dir, 'index.html.gz'))).toString('utf8')).toBe(html)
  })

  it('invents no sibling precompression deliberately did not write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-'))
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX)

    writeWebBuildStamp(dir, new Date(), '47a01e3')

    expect(existsSync(join(dir, 'index.html.br'))).toBe(false)
    expect(existsSync(join(dir, 'index.html.gz'))).toBe(false)
  })
})

// The bug this guards: the stamp used to be written THIRD from last, so a reader that
// took `podium-build.json` as "the dist is done" could copy a dist two steps from
// finished. A headless bundle built in that window shipped without the .br/.gz files
// POD-1655 added, and assertWebDirMatches (scripts/build-bun.ts) can fail a good build
// when precompress writes during the copy. Asserted against the real package.json
// because the ordering IS the fix — nothing else can hold it.
describe('apps/web build script ordering', () => {
  const scripts = (
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../apps/web/package.json', import.meta.url)), 'utf8'),
    ) as { scripts: Record<string, string | undefined> }
  ).scripts

  /** The `&&`-separated steps of a build script. Throws — a renamed script must fail
   *  the guard loudly, not silently stop guarding anything. */
  const stepsOf = (name: string): string[] => {
    const script = scripts[name]
    if (!script) throw new Error(`apps/web has no \`${name}\` script to check the order of`)
    return script.split('&&').map((step) => step.trim())
  }

  for (const name of ['build', 'build:dev']) {
    it(`writes the build stamp as the last step of \`${name}\``, () => {
      const steps = stepsOf(name)
      expect(steps.at(-1)).toContain('write-web-build-stamp.ts')
      expect(steps.filter((step) => step.includes('write-web-build-stamp.ts'))).toHaveLength(1)
    })

    it(`pre-compresses \`${name}\` before stamping it complete`, () => {
      const steps = stepsOf(name)
      const precompress = steps.findIndex((step) => step.includes('precompress-dist.ts'))
      const stamp = steps.findIndex((step) => step.includes('write-web-build-stamp.ts'))
      expect(precompress).toBeGreaterThanOrEqual(0)
      expect(precompress).toBeLessThan(stamp)
    })
  }
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
