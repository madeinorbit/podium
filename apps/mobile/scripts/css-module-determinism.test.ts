/**
 * THE PHONE BUNDLE MUST BE A PURE FUNCTION OF ITS SOURCE (POD-3775).
 *
 * `lightningcss` returns a CSS module's class-name map as a Rust `HashMap`, and a
 * `HashMap` has no order — each one is seeded afresh, so the same stylesheet comes
 * back with its keys in a different order on every call, in the same process as
 * readily as on another machine. `@expo/metro-config`'s
 * `convertLightningCssToReactNativeWebStyleSheet` copies that order straight into
 * the module it emits, and `JSON.stringify` preserves it, so the emitted module's
 * BYTES differ per build.
 *
 * Metro hashes the entry chunk's content into its filename, so one reordered object
 * literal — seven keys, in the one CSS module the phone graph pulls in
 * (`expo-router/assets/native-tabs.module.css`) — renamed the entry chunk, rewrote
 * index.html and its `.br`/`.gz` siblings, and changed every digest in
 * `podium-build-manifest.json`. That is what the release A/B
 * (`scripts/ab-headless-cross-vs-native.sh`) caught: two runners packing the same
 * commit produced two different phone websites while the desktop one matched byte
 * for byte.
 *
 * The fix is `patches/@expo/metro-config@57.0.12.patch` — iterate the map in sorted
 * key order. Nothing can depend on the old order, because there was no old order.
 *
 * This test calls the real transform on the real stylesheet twice and requires the
 * same bytes. Unpatched it fails on essentially every run (7 keys, 5039 orderings
 * that are not the first one); patched it cannot fail for a reason other than a
 * regression, because the randomness it guards against is re-rolled on every call.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Expo's CSS-module transform worker, as `expo export -p web` loads it. */
const { transformCssModuleWeb } = require('@expo/metro-config/build/transform-worker/css-modules') as {
  transformCssModuleWeb: (props: {
    filename: string
    src: string
    options: { projectRoot: string; dev: boolean; minify: boolean; sourceMap: boolean }
  }) => Promise<{ output: string }>
}

/**
 * The only CSS module the phone's web graph reaches. Resolved rather than spelled,
 * so an expo-router upgrade that moves or drops it fails here loudly instead of
 * leaving this test asserting nothing about the bundle that ships.
 */
const CSS_MODULE = require.resolve('expo-router/assets/native-tabs.module.css')

/** Enough calls that a surviving random order would have to win 5039-to-1 twelve times. */
const CALLS = 12

describe('phone CSS module transform', () => {
  it('emits the same bytes for the same stylesheet on every call', async () => {
    const src = readFileSync(CSS_MODULE, 'utf8')
    const options = { projectRoot, dev: false, minify: true, sourceMap: false }

    const outputs = new Set<string>()
    for (let call = 0; call < CALLS; call += 1) {
      outputs.add((await transformCssModuleWeb({ filename: CSS_MODULE, src, options })).output)
    }

    expect([...outputs]).toHaveLength(1)
  })

  it('orders the emitted class-name map by key, so the order is stated rather than observed', async () => {
    const src = readFileSync(CSS_MODULE, 'utf8')
    const { output } = await transformCssModuleWeb({
      filename: CSS_MODULE,
      src,
      options: { projectRoot, dev: false, minify: true, sourceMap: false },
    })

    const classNames = [...output.matchAll(/"([A-Za-z][\w-]*)":"/g)].map(([, key]) => key as string)
    expect(classNames.length).toBeGreaterThan(1)
    expect(classNames).toStrictEqual([...classNames].sort())
  })
})
