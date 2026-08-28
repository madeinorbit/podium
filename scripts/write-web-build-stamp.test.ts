// scripts/write-web-build-stamp.test.ts
//
// Product version is one string: PODIUM_APP_VERSION or dev+<sha>.
// The chunk hash stays on the stamp as bundleVersion and in a <meta> so the
// page can read the product string without treating the hash as `v`.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import type { BuildStamp } from '@podium/protocol'
import { bundleVersionFromEntrySrc, bundleVersionFromHtml } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_BUILD_MANIFEST_FILE,
  type ClientBuildManifest,
  injectProductVersionMeta,
  injectSourceDigestMeta,
  resolveWebSourceSha,
  rewriteServiceWorkerIndexRevision,
  webBuildStamp,
  writeWebBuildStamp,
} from './write-web-build-stamp'

const BUILT_INDEX =
  '<!doctype html><html><head>' +
  '<script type="module" crossorigin src="/assets/index-DHMkD0wf.js"></script>' +
  '<link rel="stylesheet" href="/assets/index-11111111.css">' +
  '</head><body><div id="root"></div></body></html>'

/** What `expo export -p web` writes, patched by apps/mobile/scripts/patch-web-html.ts. */
const EXPORTED_PHONE_INDEX =
  '<!DOCTYPE html><html lang="en"><head>' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />' +
  '<title>Podium</title>' +
  '<link rel="manifest" href="/mobile/manifest.webmanifest" />' +
  '</head><body><div id="root"></div>' +
  '<script src="/mobile/_expo/static/js/web/entry-a074e4f437a1ee92fdb168054dc07da9.js" defer></script>' +
  '</body></html>'

describe('webBuildStamp', () => {
  it('stamps the product version, not the chunk hash, as appVersion', () => {
    const stamp: BuildStamp = webBuildStamp(BUILT_INDEX, '47a01e3')
    expect(stamp.appVersion).toBe('dev+47a01e3')
    expect(stamp.sourceSha).toBe('47a01e3')
    expect(stamp.bundleVersion).toBe('bundle+DHMkD0wf')
    expect(stamp.bundleVersion).toBe(bundleVersionFromHtml(BUILT_INDEX))
    expect(stamp.bundleVersion).toBe(bundleVersionFromEntrySrc('/assets/index-DHMkD0wf.js'))
  })

  it('uses the packaged channel version when one is declared', () => {
    const stamp = webBuildStamp(BUILT_INDEX, '47a01e3', '0.4.2')
    expect(stamp.appVersion).toBe('0.4.2')
    expect(stamp.sourceSha).toBe('47a01e3')
    expect(stamp.bundleVersion).toBe('bundle+DHMkD0wf')
  })

  it('leaves the wire-schema stamp it already carried intact', () => {
    const stamp = webBuildStamp(BUILT_INDEX, '47a01e3')
    expect(stamp.wireSchemaDigest).toEqual(expect.any(String))
    expect(stamp.wireSchemaDigest).not.toBe('')
    expect(stamp.wireVersion).toEqual(expect.any(Number))
    expect('builtAt' in stamp).toBe(false)
  })

  it('gives two bundles two forensic identities without changing the product version', () => {
    const first = webBuildStamp(BUILT_INDEX, '47a01e3')
    const second = webBuildStamp(
      BUILT_INDEX.replace('index-DHMkD0wf.js', 'index-99999999.js'),
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
    expect(() => writeWebBuildStamp(dir, '47a01e3')).toThrow(/no hashed entry/)
  })

  // The phone shell is `expo export -p web`, not vite: a classic script tag and
  // a hex-32 chunk hash. It must earn the SAME stamp — Update compares one
  // `sourceSha` for the whole website (POD-1980).
  it('stamps the phone export with the same checkout the desktop dist carries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-phone-'))
    writeFileSync(join(dir, 'index.html'), EXPORTED_PHONE_INDEX)
    const stamp = writeWebBuildStamp(dir, '47a01e3')
    expect(stamp.appVersion).toBe('dev+47a01e3')
    expect(stamp.sourceSha).toBe('47a01e3')
    expect(stamp.bundleVersion).toBe('bundle+a074e4f437a1ee92fdb168054dc07da9')
    const written = JSON.parse(readFileSync(join(dir, 'podium-build.json'), 'utf8')) as BuildStamp
    expect(written.sourceSha).toBe('47a01e3')
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(
      '<meta name="podium-version" content="dev+47a01e3">',
    )
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(
      '<meta name="podium-source-digest" content="47a01e3">',
    )
  })

  it('writes the product version into the stamp and the html together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-'))
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
    const stamp = writeWebBuildStamp(dir, '47a01e3', '0.4.2')
    expect(stamp.appVersion).toBe('0.4.2')
    const written = JSON.parse(readFileSync(join(dir, 'podium-build.json'), 'utf8')) as BuildStamp
    expect(written.appVersion).toBe('0.4.2')
    expect(written.bundleVersion).toBe('bundle+DHMkD0wf')
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(
      '<meta name="podium-version" content="0.4.2">',
    )
  })

  it('manifests the exact completed files, stamp, source commit and count — and nothing per-run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-manifest-'))
    const asset = 'console.log("built client")\n'
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
    writeFileSync(join(dir, 'asset.txt'), asset)

    const stamp = writeWebBuildStamp(dir, '47a01e3', '0.4.2')
    const manifest = JSON.parse(
      readFileSync(join(dir, CLIENT_BUILD_MANIFEST_FILE), 'utf8'),
    ) as ClientBuildManifest

    expect(manifest.manifestVersion).toBe(2)
    expect(manifest.sourceCommit).toBe('47a01e3')
    expect(manifest.buildStamp).toEqual(stamp)
    expect('builtAt' in manifest.buildStamp).toBe(false)
    expect('buildInvocation' in manifest).toBe(false)
    expect(manifest.fileCount).toBe(3)
    expect(Object.keys(manifest.files).sort()).toEqual(
      ['asset.txt', 'index.html', 'podium-build.json'].sort(),
    )
    for (const [name, digest] of Object.entries(manifest.files)) {
      expect(digest).toBe(
        createHash('sha256')
          .update(readFileSync(join(dir, name)))
          .digest('hex'),
      )
    }
  })

  // Nothing per-run may reach the bytes: this is what lets a build system reuse a
  // dist it built earlier (spec 2026-08-28-cached-release-build-design §4.3).
  it('writes byte-identical output for the same input, run twice', () => {
    const build = (): string[] => {
      const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-det-'))
      writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
      writeFileSync(join(dir, 'asset.txt'), 'x\n')
      writeWebBuildStamp(dir, '47a01e3', '0.4.2')
      return ['index.html', 'asset.txt', 'podium-build.json', CLIENT_BUILD_MANIFEST_FILE].map((f) =>
        readFileSync(join(dir, f), 'utf8'),
      )
    }
    expect(build()).toEqual(build())
  })

  /**
   * RE-STAMPING A RESTORED DIST IS THE SAME AS BUILDING IT HERE (POD-3072).
   *
   * The client build is cached on its inputs, and the commit is in no part of that key,
   * so a HIT hands back a dist stamped with whichever commit first built those inputs.
   * scripts/build-clients.ts fixes that by running this script again afterwards. What
   * makes that sound rather than a way around M1's provenance check is that the manifest
   * SKIPS the two stamp files when it inventories the dist: rewriting them invalidates
   * no hashed file, and the inventory is recomputed from the bytes on disk either way.
   *
   * Asserted as byte equality against a dist stamped at the new commit from the start —
   * an assertion that only read `sourceCommit` back would pass while index.html carried
   * two version metas, or the inventory still described the pre-stamp page.
   */
  it('re-stamped after a restore, is byte-identical to a first build at that commit', () => {
    const files = ['index.html', 'asset.txt', 'podium-build.json', CLIENT_BUILD_MANIFEST_FILE]
    const dist = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-restore-'))
      writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
      writeFileSync(join(dir, 'asset.txt'), 'x\n')
      return dir
    }

    // What the cache holds: this dist, stamped for the commit that filled it.
    const restored = dist()
    writeWebBuildStamp(restored, '47a01e3', '0.4.2')
    // What the lane does after the restore, with the commit actually being released.
    writeWebBuildStamp(restored, 'b00b135', '0.4.2')

    const fresh = dist()
    writeWebBuildStamp(fresh, 'b00b135', '0.4.2')

    for (const name of files) {
      expect(readFileSync(join(restored, name), 'utf8'), name).toBe(
        readFileSync(join(fresh, name), 'utf8'),
      )
    }
    const manifest = JSON.parse(
      readFileSync(join(restored, CLIENT_BUILD_MANIFEST_FILE), 'utf8'),
    ) as ClientBuildManifest
    expect(manifest.sourceCommit).toBe('b00b135')
    // The inventory still describes the bytes on disk exactly — including the page the
    // re-stamp just rewrote, which is the file a carried-over inventory would misname.
    for (const [name, digest] of Object.entries(manifest.files)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(restored, name)))
          .digest('hex'),
        name,
      ).toBe(digest)
    }
  })

  it('refuses to certify a dist whose source commit is unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-manifest-'))
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
    expect(() => writeWebBuildStamp(dir)).toThrow(/without a source commit/)
    expect(existsSync(join(dir, CLIENT_BUILD_MANIFEST_FILE))).toBe(false)
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

    writeWebBuildStamp(dir, '47a01e3', '0.4.2')

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

    writeWebBuildStamp(dir, '47a01e3')

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
//
// BOTH WEBSITES ARE HELD TO IT (POD-1991). The phone shell is served by the same
// `serveFile` that prefers a build-time `.br`/`.gz` sibling, so an export without
// them makes the LIVE server compress 6.7 MB on demand, at the server's own
// interactive tier, every time the export is rebuilt — which is now every commit.
// Pre-compressing it moves that cost into the batch-tier build scope where the
// rest of the build already runs.
//
// A step MAY follow the stamp if it writes nothing into dist. `web-bundle-budget
// --check` is the only such step (POD-3053: it moved into `build` when `build:dist`
// was deleted); it reads dist and either passes or fails the command. The
// allow-list is deliberately literal — a new trailing step has to be justified
// here, in front of the reason, rather than slipped in behind a loose pattern.
const READS_ONLY = /web-bundle-budget\.ts .*--check\s*$/

describe.each([
  { pkg: 'apps/web', scripts: ['build', 'build:dev'] },
  { pkg: 'apps/mobile', scripts: ['build'] },
])('$pkg build script ordering', ({ pkg, scripts: names }) => {
  const scripts = (
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../${pkg}/package.json`, import.meta.url)), 'utf8'),
    ) as { scripts: Record<string, string | undefined> }
  ).scripts

  /** The `&&`-separated steps of a build script. Throws — a renamed script must fail
   *  the guard loudly, not silently stop guarding anything. */
  const stepsOf = (name: string): string[] => {
    const script = scripts[name]
    if (!script) throw new Error(`${pkg} has no \`${name}\` script to check the order of`)
    return script.split('&&').map((step) => step.trim())
  }

  for (const name of names) {
    it(`writes the build stamp after the last writing step of \`${name}\``, () => {
      const steps = stepsOf(name)
      const stamp = steps.findIndex((step) => step.includes('write-web-build-stamp.ts'))
      expect(stamp).toBeGreaterThanOrEqual(0)
      expect(steps.filter((step) => step.includes('write-web-build-stamp.ts'))).toHaveLength(1)
      for (const step of steps.slice(stamp + 1)) expect(step).toMatch(READS_ONLY)
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

/**
 * THE SERVICE WORKER HAS TO NAME THE PAGE THAT SHIPPED (POD-3083).
 *
 * With PODIUM_APP_VERSION out of the build, a version-only release changes no JS, so
 * workbox's generated `sw.js` is byte-identical — and `registration.update()` is a byte
 * diff of the worker script. An installed PWA would install nothing, never produce a
 * waiting worker, and keep serving the PRECACHED index.html of the previous release
 * through `navigateFallback`, while the update panel reported it behind and offered a
 * Reload that could not clear itself. The stamp therefore rewrites the precache
 * revision, which both moves the worker's bytes and — for the first time — makes that
 * revision TRUE: workbox recorded the md5 of the PRE-stamp page.
 */
describe('rewriteServiceWorkerIndexRevision', () => {
  const swWith = (...entries: string[]): string =>
    `self.__WB_MANIFEST;const e=[${entries.join(',')}];precacheAndRoute(e);`
  const INDEX_ENTRY = '{url:"index.html",revision:"856b900ae6d209eaaa37d643e2d6bb76"}'
  const CHUNK_ENTRY = '{url:"assets/index-DHMkD0wf.js",revision:null}'

  it('rewrites the entry to the md5 of the bytes actually shipped', () => {
    const stamped = injectProductVersionMeta(BUILT_INDEX, '0.4.2')
    const out = rewriteServiceWorkerIndexRevision(swWith(CHUNK_ENTRY, INDEX_ENTRY), stamped)
    const md5 = createHash('md5').update(stamped).digest('hex')
    expect(out).toContain(`{url:"index.html",revision:"${md5}"}`)
    // The content-hashed chunks carry their revision in the filename; nothing else moves.
    expect(out).toContain(CHUNK_ENTRY)
  })

  /**
   * THE INSTRUMENT MUST BE ABLE TO SAY NO. A pattern matcher that silently no-ops when
   * workbox changes its output shape is exactly the gate that cannot fire: the build
   * stays green and the failure only ever shows up as an installed app that will not
   * come current. So both directions of "the shape moved" are refusals.
   */
  it('refuses a service worker with no index.html precache entry', () => {
    expect(() => rewriteServiceWorkerIndexRevision(swWith(CHUNK_ENTRY), BUILT_INDEX)).toThrow(
      /has 0 index\.html precache entries/,
    )
  })

  it('refuses a service worker with more than one index.html precache entry', () => {
    expect(() =>
      rewriteServiceWorkerIndexRevision(swWith(INDEX_ENTRY, CHUNK_ENTRY, INDEX_ENTRY), BUILT_INDEX),
    ).toThrow(/has 2 index\.html precache entries/)
  })
})

describe('writeWebBuildStamp and the generated service worker', () => {
  const SW = 'const e=[{url:"assets/index-DHMkD0wf.js",revision:null},{url:"index.html",revision:"856b900ae6d209eaaa37d643e2d6bb76"}];'
  const distWithSw = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-sw-'))
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
    writeFileSync(join(dir, 'sw.js'), SW)
    return dir
  }

  /**
   * THE TRIPWIRE. Written as "the revision equals the md5 of the page on disk" rather
   * than "the revision changed", because that is the property the browser depends on and
   * the one an ordering mistake breaks: inject the metas AFTER this rewrite and the
   * worker names a page that was never served.
   */
  it('leaves the precache revision equal to the md5 of the stamped index.html', () => {
    const dir = distWithSw()
    writeWebBuildStamp(dir, '47a01e3', '0.4.2')

    const html = readFileSync(join(dir, 'index.html'))
    expect(html.toString('utf8')).toContain('<meta name="podium-version" content="0.4.2">')
    const sw = readFileSync(join(dir, 'sw.js'), 'utf8')
    expect(sw).toContain(
      `{url:"index.html",revision:"${createHash('md5').update(html).digest('hex')}"}`,
    )
  })

  /** The point of the exercise: a version-only re-stamp must MOVE the worker's bytes. */
  it('changes the worker across a version change, so an installed app updates', () => {
    const a = distWithSw()
    writeWebBuildStamp(a, '47a01e3', '0.0.0-swtest.a')
    const b = distWithSw()
    writeWebBuildStamp(b, '47a01e3', '0.0.0-swtest.b')

    expect(readFileSync(join(b, 'sw.js'), 'utf8')).not.toBe(readFileSync(join(a, 'sw.js'), 'utf8'))
  })

  // static-web.ts prefers these off disk, so a stale sibling hands the browser the
  // very worker this rewrite exists to replace.
  it('refreshes the .br and .gz siblings of the worker it rewrote', () => {
    const dir = distWithSw()
    writeFileSync(join(dir, 'sw.js.br'), brotliCompressSync(Buffer.from(SW)))
    writeFileSync(join(dir, 'sw.js.gz'), gzipSync(Buffer.from(SW)))

    writeWebBuildStamp(dir, '47a01e3', '0.4.2')

    const sw = readFileSync(join(dir, 'sw.js'), 'utf8')
    expect(sw).not.toBe(SW)
    expect(brotliDecompressSync(readFileSync(join(dir, 'sw.js.br'))).toString('utf8')).toBe(sw)
    expect(gunzipSync(readFileSync(join(dir, 'sw.js.gz'))).toString('utf8')).toBe(sw)
  })

  // The phone export ships no service worker at all (checked: apps/mobile registers
  // none and its export emits none), and the same script stamps both dists.
  it('stamps a dist that has no service worker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-nosw-'))
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
    expect(() => writeWebBuildStamp(dir, '47a01e3', '0.4.2')).not.toThrow()
    expect(existsSync(join(dir, 'sw.js'))).toBe(false)
  })

  // A restore is re-stamped (POD-3072); the worker must land on the same bytes a fresh
  // build at that version would have written, or the manifest describes a dist nobody
  // else can reproduce.
  it('re-stamped after a restore, writes the worker a first build would have', () => {
    const restored = distWithSw()
    writeWebBuildStamp(restored, '47a01e3', '0.4.2')
    writeWebBuildStamp(restored, 'b00b135', '0.5.0')
    const fresh = distWithSw()
    writeWebBuildStamp(fresh, 'b00b135', '0.5.0')

    expect(readFileSync(join(restored, 'sw.js'), 'utf8')).toBe(
      readFileSync(join(fresh, 'sw.js'), 'utf8'),
    )
    // And the inventory names the worker as it now stands, not as it was restored.
    const manifest = JSON.parse(
      readFileSync(join(restored, CLIENT_BUILD_MANIFEST_FILE), 'utf8'),
    ) as ClientBuildManifest
    expect(manifest.files['sw.js']).toBe(
      createHash('sha256').update(readFileSync(join(restored, 'sw.js'))).digest('hex'),
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

describe('injectSourceDigestMeta', () => {
  it('adds the source identity independently of the product label', () => {
    const html = injectSourceDigestMeta(BUILT_INDEX, '47a01e3')
    expect(html).toContain('<meta name="podium-source-digest" content="47a01e3">')
  })

  it('replaces an existing identity rather than adding a second one', () => {
    const once = injectSourceDigestMeta(BUILT_INDEX, 'aaaaaaa')
    const twice = injectSourceDigestMeta(once, 'bbbbbbb')
    expect(twice.match(/podium-source-digest/g)).toHaveLength(1)
    expect(twice).toContain('content="bbbbbbb"')
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
