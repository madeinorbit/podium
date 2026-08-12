// scripts/archive-web-sourcemaps.test.ts
//
// POD-1957 — the retained-build window for `apps/web`'s hidden source maps.
//
// Two properties carry the feature and both are asserted here against real files
// rather than against the shape of the code:
//
//   1. `dist` IS NOT TOUCHED. The step reads the build and writes only to the
//      store, which is what makes it safe on a release build. `fingerprint()` is
//      itself tested for armedness first — a comparison that cannot fail is not
//      evidence, and this one is the load-bearing assertion.
//
//   2. A PRUNED BUILD FAILS LOUDLY. The resolver is spawned for real against a
//      store this test wrote, so a crash naming an aged-out bundle exits non-zero
//      instead of resolving against some other build's map. Spawning also pins
//      the on-disk format: the writer here and the reader there cannot drift.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  archiveSkipReason,
  archiveSourcemaps,
  digestOf,
  entryBundle,
  mapFilesIn,
  readStore,
} from './archive-web-sourcemaps'

const RESOLVER = join(__dirname, '..', 'docs', 'agents', 'pod-1954', 'resolve-stack.mjs')

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pod1957-${prefix}-`))
}

/**
 * A minimal but genuinely valid source map. One segment on generated line 1:
 * column 10 maps to `sources[0]` line 5, column 2, name `crashHere`. `flavour`
 * varies `sourcesContent` so two maps can differ in bytes while describing the
 * same generated output — the case that forces content-addressing.
 */
function sourceMap(source: string, flavour = 'a'): string {
  return JSON.stringify({
    version: 3,
    file: 'bundle.js',
    sources: [source],
    sourcesContent: [`// ${flavour}\nexport function crashHere() {}\n`],
    names: ['crashHere'],
    mappings: 'UAIEA',
  })
}

/** Build a fake dist. `chunks` maps a bundle filename to its map's flavour. */
function makeDist(entry: string, chunks: Record<string, string>): string {
  const dist = tmp('dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html><html><head><script type="module" crossorigin src="/assets/${entry}"></script></head><body></body></html>`,
  )
  for (const [bundle, flavour] of Object.entries(chunks)) {
    writeFileSync(join(dist, 'assets', bundle), `//# ${bundle}\nconsole.log(1)\n`)
    writeFileSync(join(dist, 'assets', `${bundle}.map`), sourceMap(`src/${bundle}.ts`, flavour))
  }
  return dist
}

/** Every file under `dir`, by relative path, with a hash of its bytes. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(dir)
  return out
}

function storedMapFiles(store: string): string[] {
  return readdirSync(join(store, 'maps')).sort()
}

/** Run one build's worth of archiving. `at` keeps timestamps distinguishable. */
function archive(dist: string, store: string, at: number, keep?: number) {
  return archiveSourcemaps({ distDir: dist, storeDir: store, keep, now: () => at })
}

function resolveStack(store: string, target: string, frame = '1:10') {
  return spawnSync(process.execPath, [RESOLVER, target, frame], {
    encoding: 'utf8',
    env: { ...process.env, PODIUM_SOURCEMAP_STORE: store },
  })
}

describe('fingerprint (the dist-untouched assertion must be able to fail)', () => {
  it('reports a difference for an added, changed, or removed file', () => {
    const dir = tmp('fp')
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'a.js'), 'one')
    const before = fingerprint(dir)
    expect(fingerprint(dir)).toEqual(before)

    writeFileSync(join(dir, 'assets', 'b.js'), 'two')
    expect(fingerprint(dir)).not.toEqual(before)
    rmSync(join(dir, 'assets', 'b.js'))
    expect(fingerprint(dir)).toEqual(before)

    writeFileSync(join(dir, 'assets', 'a.js'), 'ONE')
    expect(fingerprint(dir)).not.toEqual(before)
    writeFileSync(join(dir, 'assets', 'a.js'), 'one')
    expect(fingerprint(dir)).toEqual(before)

    rmSync(join(dir, 'assets', 'a.js'))
    expect(fingerprint(dir)).not.toEqual(before)
  })
})

describe('archiveSourcemaps', () => {
  it('leaves dist byte-identical — every file, by name and content', () => {
    const dist = makeDist('index-AAA.js', { 'index-AAA.js': 'a', 'vendor-V1.js': 'v' })
    const store = tmp('store')
    const before = fingerprint(dist)

    archive(dist, store, 1_000)

    const after = fingerprint(dist)
    expect(after).toEqual(before)
    // Named explicitly, so a step that started writing next to the chunks — a
    // `.map.gz` in dist, say — fails on the name and not only on the count.
    expect(Object.keys(after).sort()).toEqual([
      join('assets', 'index-AAA.js'),
      join('assets', 'index-AAA.js.map'),
      join('assets', 'vendor-V1.js'),
      join('assets', 'vendor-V1.js.map'),
      'index.html',
    ])
  })

  it('stores every map of the build, keyed by content, and records the entry', () => {
    const dist = makeDist('index-AAA.js', { 'index-AAA.js': 'a', 'vendor-V1.js': 'v' })
    const store = tmp('store')

    const result = archive(dist, store, 1_000)

    expect(result.build.entry).toBe('index-AAA.js')
    expect(result.build.maps.map((m) => m.bundle).sort()).toEqual(['index-AAA.js', 'vendor-V1.js'])
    expect(result.added).toHaveLength(2)
    expect(storedMapFiles(store)).toHaveLength(2)
    expect(result.bytes).toBeGreaterThan(0)

    const stored = result.build.maps.find((m) => m.bundle === 'index-AAA.js')
    expect(stored?.digest).toBe(digestOf(readFileSync(join(dist, 'assets', 'index-AAA.js.map'))))
  })

  it('keeps the last 10 BUILDS and prunes oldest-first', () => {
    const store = tmp('store')
    for (let i = 1; i <= 12; i++) {
      archive(makeDist(`index-B${i}.js`, { [`index-B${i}.js`]: `b${i}` }), store, i * 1_000)
    }

    const builds = readStore(store).builds
    expect(builds).toHaveLength(10)
    // Newest first, and the two oldest are gone rather than the two newest.
    expect(builds.map((b) => b.entry)).toEqual([
      'index-B12.js',
      'index-B11.js',
      'index-B10.js',
      'index-B9.js',
      'index-B8.js',
      'index-B7.js',
      'index-B6.js',
      'index-B5.js',
      'index-B4.js',
      'index-B3.js',
    ])
    expect(storedMapFiles(store)).toHaveLength(10)
  })

  it('keeps a shared chunk alive after the build that introduced it is pruned', () => {
    const store = tmp('store')
    // Build 1 introduces vendor-V1; every later build still ships the same chunk,
    // so its map must outlive build 1 falling out of a 3-build window.
    const first = archive(
      makeDist('index-B1.js', { 'index-B1.js': 'b1', 'vendor-V1.js': 'v' }),
      store,
      1_000,
      3,
    )
    const vendorDigest = first.build.maps.find((m) => m.bundle === 'vendor-V1.js')?.digest
    const firstIndexDigest = first.build.maps.find((m) => m.bundle === 'index-B1.js')?.digest
    expect(vendorDigest).toBeDefined()

    for (let i = 2; i <= 4; i++) {
      archive(
        makeDist(`index-B${i}.js`, { [`index-B${i}.js`]: `b${i}`, 'vendor-V1.js': 'v' }),
        store,
        i * 1_000,
        3,
      )
    }

    const builds = readStore(store).builds
    expect(builds.map((b) => b.entry)).toEqual(['index-B4.js', 'index-B3.js', 'index-B2.js'])
    // The pruned build's own chunk is gone…
    expect(storedMapFiles(store)).not.toContain(`${firstIndexDigest}.map.gz`)
    // …but the chunk three surviving builds still reference is not.
    expect(storedMapFiles(store)).toContain(`${vendorDigest}.map.gz`)
    // And it is still resolvable, which is the point of keeping the bytes.
    expect(resolveStack(store, 'vendor-V1.js').status).toBe(0)
  })

  it('writes one stored file when consecutive builds share a chunk', () => {
    const store = tmp('store')
    archive(makeDist('index-B1.js', { 'index-B1.js': 'b1', 'vendor-V1.js': 'v' }), store, 1_000)
    const second = archive(
      makeDist('index-B2.js', { 'index-B2.js': 'b2', 'vendor-V1.js': 'v' }),
      store,
      2_000,
    )

    // Only the changed chunk cost anything; the vendor map was already stored.
    expect(second.added).toHaveLength(1)
    expect(storedMapFiles(store)).toHaveLength(3)
  })

  it('refreshes rather than consumes a slot when a rebuild emits nothing new', () => {
    const store = tmp('store')
    archive(makeDist('index-B1.js', { 'index-B1.js': 'b1' }), store, 1_000)
    // A backend-only change: the web build runs again and emits an identical dist.
    const again = archive(makeDist('index-B1.js', { 'index-B1.js': 'b1' }), store, 5_000)

    expect(again.refreshedExisting).toBe(true)
    const builds = readStore(store).builds
    expect(builds).toHaveLength(1)
    expect(builds[0]?.at).toBe(new Date(5_000).toISOString())
  })

  it('survives a corrupt builds.json instead of breaking the build', () => {
    const store = tmp('store')
    archive(makeDist('index-B1.js', { 'index-B1.js': 'b1' }), store, 1_000)
    writeFileSync(join(store, 'builds.json'), '{"version":1,"builds":[{"at"')

    expect(() =>
      archive(makeDist('index-B2.js', { 'index-B2.js': 'b2' }), store, 2_000),
    ).not.toThrow()
    expect(readStore(store).builds.map((b) => b.entry)).toEqual(['index-B2.js'])
  })
})

describe('mapFilesIn / entryBundle', () => {
  it('finds every .map in the dist and the entry chunk index.html loads', () => {
    const dist = makeDist('index-AAA.js', { 'index-AAA.js': 'a', 'vendor-V1.js': 'v' })
    expect(mapFilesIn(dist).map((m) => m.bundle)).toEqual(['index-AAA.js', 'vendor-V1.js'])
    expect(entryBundle(dist)).toBe('index-AAA.js')
  })

  it('is empty, not throwing, for a dist that does not exist', () => {
    expect(mapFilesIn(join(tmp('gone'), 'nope'))).toEqual([])
  })
})

describe('archiveSkipReason (retention is a dev affordance)', () => {
  it('skips in CI, where a release is built', () => {
    expect(archiveSkipReason({ CI: 'true' })).toMatch(/CI/)
  })

  it('skips when switched off explicitly', () => {
    expect(archiveSkipReason({ PODIUM_SOURCEMAP_ARCHIVE: '0' })).toMatch(/PODIUM_SOURCEMAP_ARCHIVE/)
  })

  it('archives an ordinary local build, and lets =1 override CI', () => {
    expect(archiveSkipReason({})).toBeUndefined()
    expect(archiveSkipReason({ CI: 'true', PODIUM_SOURCEMAP_ARCHIVE: '1' })).toBeUndefined()
  })
})

describe('resolve-stack.mjs against the retained window', () => {
  it('resolves a frame in a retained bundle by the name the crash stack carries', () => {
    const store = tmp('store')
    archive(makeDist('index-AAA.js', { 'index-AAA.js': 'a' }), store, 1_000)

    const bare = resolveStack(store, 'index-AAA.js')
    expect(bare.status).toBe(0)
    expect(bare.stdout).toContain('src/index-AAA.js.ts:5:2')
    expect(bare.stdout).toContain('crashHere')

    // A crash stack carries the whole URL; that must work without hand-editing.
    const fromUrl = resolveStack(store, 'https://box:55555/assets/index-AAA.js')
    expect(fromUrl.status).toBe(0)
    expect(fromUrl.stdout).toContain('src/index-AAA.js.ts:5:2')
  })

  it('EXITS NON-ZERO for a bundle whose build has been pruned, and resolves nothing', () => {
    const store = tmp('store')
    // The crashing build, then enough rebuilds to push it out of a 3-build window.
    archive(makeDist('index-OLD.js', { 'index-OLD.js': 'old' }), store, 1_000, 3)
    for (let i = 2; i <= 5; i++) {
      archive(makeDist(`index-N${i}.js`, { [`index-N${i}.js`]: `n${i}` }), store, i * 1_000, 3)
    }

    const pruned = resolveStack(store, 'index-OLD.js')
    expect(pruned.status).not.toBe(0)
    expect(pruned.stdout).toBe('')
    expect(pruned.stderr).toContain('NO RETAINED MAP for index-OLD.js')
    // It must name what IS retained, so the reader can tell pruned from never-built.
    expect(pruned.stderr).toContain('index-N5.js')
    // And it must not merely fail — it must say why guessing is wrong.
    expect(pruned.stderr).toMatch(/Do NOT resolve it against another build/)

    // A bundle still in the window resolves, so the failure above is the window
    // doing its job rather than the resolver being broken.
    expect(resolveStack(store, 'index-N5.js').status).toBe(0)
  })

  it('exits non-zero against an empty store rather than reporting nothing wrong', () => {
    const empty = resolveStack(tmp('store'), 'index-AAA.js')
    expect(empty.status).not.toBe(0)
    expect(empty.stderr).toContain('no build has been archived here')
  })

  it('refuses to guess when one bundle name has two maps in the window', () => {
    const store = tmp('store')
    // Same output chunk name, different original sources — the case that makes a
    // name-keyed store silently report wrong line numbers.
    archive(makeDist('index-SAME.js', { 'index-SAME.js': 'first' }), store, 1_000)
    archive(makeDist('index-SAME.js', { 'index-SAME.js': 'second' }), store, 2_000)

    const ambiguous = resolveStack(store, 'index-SAME.js')
    expect(ambiguous.status).not.toBe(0)
    expect(ambiguous.stdout).toBe('')
    expect(ambiguous.stderr).toContain('AMBIGUOUS')
  })

  it('still accepts a .map path directly, for a map you have in hand', () => {
    const dist = makeDist('index-AAA.js', { 'index-AAA.js': 'a' })
    const direct = spawnSync(
      process.execPath,
      [RESOLVER, join(dist, 'assets', 'index-AAA.js.map'), '1:10'],
      { encoding: 'utf8', env: { ...process.env, PODIUM_SOURCEMAP_STORE: tmp('store') } },
    )
    expect(direct.status).toBe(0)
    expect(direct.stdout).toContain('src/index-AAA.js.ts:5:2')
  })
})
