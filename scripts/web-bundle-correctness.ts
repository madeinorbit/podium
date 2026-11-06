#!/usr/bin/env bun

/**
 * THE BUNDLE CORRECTNESS CHECK, and why it runs LAST, after the stamp.
 *
 * It fails the web build only for a bundle that would BREAK in a browser:
 *   - a host-only source in any browser chunk, which throws when the chunk
 *     evaluates, so its routes are gone (POD-2176);
 *   - a singleton package (CodeMirror, Lezer, React) bundled from two
 *     installations, which breaks `instanceof` inside it (POD-2469).
 * It sets no size limit and checks no module's placement: the build stopped
 * limiting bundle size in POD-6423.
 *
 * This script only READS `dist`; it writes nothing. So it must not stand between
 * the build and the stamp that names it: with a check in front of the stamp, a
 * complaint left a perfectly good build with no `podium-build.json`, and the
 * server read the website as "not for this commit" forever (POD-2002). A breach
 * still fails the build command, so landings and CI still stop.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { browserHostileSources } from '../apps/web/test/web-bundle-boundaries'
import { splitSingletons } from './web-bundle-duplicates'

const dist = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'apps/web/dist')
const assets = join(dist, 'assets')

/** Every bundled source of every browser chunk, as recorded by its map. */
const chunkSources = readdirSync(assets)
  .filter((file) => file.endsWith('.js') && statSync(join(assets, file)).isFile())
  .map((file) => {
    const map = join(assets, `${file}.map`)
    if (!existsSync(map)) return [] as string[]
    return (JSON.parse(readFileSync(map, 'utf8')) as { sources: readonly string[] }).sources
  })

/** `@xterm/xterm/lib/xterm.js`, not the `../../../../node_modules/.bun/…`
 *  spelling a source map records relative to wherever the build ran. */
function readableSource(source: string): string {
  const at = source.lastIndexOf('/node_modules/')
  return at >= 0 ? source.slice(at + '/node_modules/'.length) : source.replace(/^(\.\.\/)+/, '')
}

const errors: string[] = []

// Sources in a chunk map are relative to the map, and every map sits in
// dist/assets: the absolute form is what tells two installations apart.
const split = splitSingletons(chunkSources.flat().map((source) => resolve(assets, source)))
if (split.length > 0) {
  errors.push(
    `${split.map(({ package: pkg }) => pkg).join(', ')} ` +
      `is bundled from more than one installation. These packages recognise their own ` +
      `objects with instanceof, so a split BREAKS them: POD-2469 was EditorState.create ` +
      `throwing "Unrecognized extension value in extension set", and a split @lezer/highlight ` +
      `silently stops colouring code. .worktrees/ sits inside the main checkout, so a worktree ` +
      `missing apps/web/node_modules walks up into the main one. Pin the specifier in ` +
      `resolve.dedupe in apps/web/vite.config.ts. Installations: ` +
      `${split.flatMap(({ installations }) => installations).join(', ')}`,
  )
}

const hostile = browserHostileSources(chunkSources.flat())
if (hostile.length > 0) {
  errors.push(
    `${hostile.length} host-only source(s) are in a browser chunk. These evaluate ` +
      `createRequire at module scope, so the chunk THROWS on evaluation and its routes are ` +
      `gone in any built bundle (POD-2176). Import the browser half instead ` +
      `(@podium/harness/browser), or move the dependency behind a port the composition root ` +
      `injects: ${hostile.slice(0, 5).map(readableSource).join(', ')}` +
      (hostile.length > 5 ? `, and ${hostile.length - 5} more` : ''),
  )
}

for (const error of errors) console.error(`[web-bundle-correctness] ${error}`)
if (errors.length > 0) process.exitCode = 1
else
  console.log(`[web-bundle-correctness] ${chunkSources.length} browser chunks: no breaking source`)
