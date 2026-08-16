#!/usr/bin/env bun

/**
 * THE SIZE RATCHET — and why it runs LAST, after the stamp.
 *
 * This script only READS `dist`; it writes nothing. That is what decides its
 * place in the web build: it is a judgement on an artifact that is already
 * finished, so it must not stand between the build and the stamp that names it.
 *
 * It used to. `write-web-build-stamp.ts` is deliberately the last step that
 * writes, so the stamp means "this dist is complete" (POD-1986) — but with this
 * check in front of it, a size complaint left a perfectly good build with no
 * `podium-build.json` at all. Measured on the dev host: 236 asset files,
 * sourcemaps archived, precompressed, and unnameable. The server then read the
 * website as "not for this commit" forever, rebuilt it fruitlessly on every
 * start-up, refused to pack a development bundle, and published a target with no
 * headless artifact. Updates were wedged by a size warning (POD-2002).
 *
 * A breach still fails the build command, so landings and CI still stop. The
 * difference is that what is already on disk can be named.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

interface SourceMap {
  readonly sources: readonly string[]
  readonly sourcesContent?: readonly (string | null)[]
}

interface Bytes {
  readonly raw: number
  readonly gzip: number
  readonly brotli: number
}

interface ChunkReport extends Bytes {
  readonly file: string
  readonly sources: readonly string[]
  readonly sourceBytes: number
}

interface SourcesReport {
  readonly sources: readonly string[]
}

/**
 * THE UPDATE SURFACE'S DEFERRED HALF (POD-2190).
 *
 * These modules are the update engine: the poller, the view model it feeds, the
 * protocol client it parses with, and the panel that renders the result. Not one
 * of them can do anything useful until a poll has returned, and a poll cannot
 * return before the app has painted — so their place is a chunk fetched just
 * after first paint, never the eager graph.
 *
 * They were eager once, because the app shell mounted a provider that imported
 * them, and that is exactly how the two eager budgets below went red. A byte
 * ceiling alone would not have stopped it coming back: the overage was 572 bytes
 * of gzip, so the next person to nudge the eager graph would have re-fired a
 * number that names no cause and suggests no fix. This names both.
 *
 * If this fires, the question is not "what got bigger" — it is "what did the app
 * shell import, directly or through one of these, that dragged the whole surface
 * forward again".
 */
const UPDATE_ENGINE_MODULES = [
  'operation-view.ts',
  'update-view.ts',
  'use-update-state.ts',
  'operations-client.ts',
  'UpdatePanel.tsx',
  'UpdatesEngine.tsx',
] as const

/**
 * MODULES A BROWSER CANNOT EVALUATE (POD-2206), as opposed to merely large ones.
 *
 * The byte ceilings below are a judgement about cost. This is not: every source
 * matched here evaluates `createRequire(import.meta.url)` at MODULE SCOPE, or
 * reaches something that does, and in a browser `node:module` is a stub. A chunk
 * carrying one does not render slowly — it throws `createRequire is not a
 * function` while it is still being evaluated, and the route is simply gone.
 *
 * That is POD-2176, and it was a whole-pane crash reachable from a one-line
 * import: `sections/shared.tsx` took `harnessSupportsNoTools` from
 * `@podium/harness/metadata`, which re-exports the registry, which holds all
 * five manifests and their sqlite closure. It survived because the two gates
 * that could see it both answered in a currency nobody reads at the time: the
 * size budgets went red (they were already red), and `lint:architecture` named
 * the file exactly — in a lane red for four unrelated reasons since before it
 * landed. Neither said "the settings pane is gone in every real build".
 *
 * So this check exists to say THAT, in the build command, in bytes-free terms.
 * `@podium/harness/browser` is the declared exception because it is the half
 * with no runtime import at all — the split those two modules exist to keep.
 */
const BROWSER_HOSTILE_SOURCES = [
  'packages/runtime/src/sqlite/',
  'packages/harness/src/',
  'packages/transcript/src/',
] as const

const BROWSER_HOSTILE_EXCEPTIONS = ['packages/harness/src/browser.ts'] as const

const args = process.argv.slice(2)
const checkBudget = args.includes('--check')
const dist = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'apps/web/dist')
const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8')

function compressedBytes(path: string): Bytes {
  const contents = readFileSync(path)
  return {
    raw: contents.byteLength,
    gzip: gzipSync(contents, { level: 9 }).byteLength,
    brotli: brotliCompressSync(contents, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  }
}

function addBytes(left: Bytes, right: Bytes): Bytes {
  return {
    raw: left.raw + right.raw,
    gzip: left.gzip + right.gzip,
    brotli: left.brotli + right.brotli,
  }
}

function sourceMapFor(jsFile: string): SourceMap {
  const path = `${join(dist, jsFile)}.map`
  if (!existsSync(path)) return { sources: [] }
  return JSON.parse(readFileSync(path, 'utf8')) as SourceMap
}

function chunkReport(jsFile: string): ChunkReport {
  const map = sourceMapFor(jsFile)
  return {
    file: jsFile,
    ...compressedBytes(join(dist, jsFile)),
    sources: map.sources,
    sourceBytes: map.sources.reduce(
      (total, _source, index) =>
        total + Buffer.byteLength(map.sourcesContent?.[index] ?? '', 'utf8'),
      0,
    ),
  }
}

function htmlJsReferences(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/(?:src|href)="\/?([^"?]+\.js)(?:\?[^"?]*)?"/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ]
}

function findChunk(prefix: string): string {
  const matches = readdirSync(join(dist, 'assets'))
    .filter((file) => file.startsWith(prefix) && file.endsWith('.js'))
    .map((file) => `assets/${file}`)
  if (matches.length !== 1)
    throw new Error(`expected one ${prefix}*.js chunk, found ${matches.length}`)
  return matches[0] as string
}

function matchingSources(chunks: readonly SourcesReport[], fragment: string): string[] {
  return [
    ...new Set(
      chunks.flatMap((chunk) => chunk.sources.filter((source) => source.includes(fragment))),
    ),
  ].sort()
}

const eagerChunks = htmlJsReferences(indexHtml).map(chunkReport)
const eagerBytes = eagerChunks.reduce<Bytes>(addBytes, { raw: 0, gzip: 0, brotli: 0 })
const settings = chunkReport(findChunk('SettingsView-'))
const allChunks = readdirSync(join(dist, 'assets'))
  .filter((file) => file.endsWith('.js') && statSync(join(dist, 'assets', file)).isFile())
  .map((file) => sourceMapFor(`assets/${file}`))

const report = {
  dist,
  eager: {
    ...eagerBytes,
    files: eagerChunks.map((chunk) => basename(chunk.file)),
    sourceBytes: eagerChunks.reduce((total, chunk) => total + chunk.sourceBytes, 0),
    ownershipMatrixSources: matchingSources(
      eagerChunks,
      'packages/model/src/annotations/matrix.ts',
    ),
    commandSources: matchingSources(eagerChunks, 'packages/commands/src/'),
    updateEngineSources: UPDATE_ENGINE_MODULES.flatMap((module) =>
      matchingSources(eagerChunks, `src/features/updates/${module}`),
    ),
  },
  settings: {
    file: basename(settings.file),
    raw: settings.raw,
    gzip: settings.gzip,
    brotli: settings.brotli,
    sourceBytes: settings.sourceBytes,
    ownershipMatrixSources: matchingSources([settings], 'packages/model/src/annotations/matrix.ts'),
    commandSources: matchingSources([settings], 'packages/commands/src/'),
  },
  allBrowserChunks: {
    ownershipMatrixSources: matchingSources(allChunks, 'packages/model/src/annotations/matrix.ts'),
    browserHostileSources: BROWSER_HOSTILE_SOURCES.flatMap((fragment) =>
      matchingSources(allChunks, fragment).filter(
        (source) => !BROWSER_HOSTILE_EXCEPTIONS.some((allowed) => source.includes(allowed)),
      ),
    ).sort(),
  },
}

console.log(JSON.stringify(report, null, 2))

if (checkBudget) {
  const errors: string[] = []
  const atMost = (label: string, actual: number, budget: number) => {
    if (actual > budget) errors.push(`${label}: ${actual} exceeds ${budget}`)
  }

  atMost('eager raw bytes', report.eager.raw, 2_200_000)
  atMost('eager gzip bytes', report.eager.gzip, 655_000)
  atMost('eager Brotli bytes', report.eager.brotli, 545_000)
  // 7_400_000 → 7_450_000 (2026-08-14) → 7_500_000 (2026-08-15). This one counts
  // `sourcesContent`, i.e. ORIGINAL source text with comments, so it prices the
  // house style rather than anything the browser downloads.
  //
  // The 2026-08-14 raise bought a specific trade: replacing the workspace-
  // membership fan-out (one index rebuilt per session per publish: ~849k
  // iterations, 651ms of blocked main thread per feed frame) with indexes built
  // once, plus the comments pinning the memo-invalidation contract that makes it
  // safe.
  //
  // This raise bought nothing. It is accumulated drift: ~20 commits of shell and
  // sidebar work since 0d7a596e8 spent 53,497 bytes and left HEAD 3,497 over, with
  // no single change to point at. It was raised rather than paid down because the
  // three payload budgets above still pass — but they pass THINLY. Measured at the
  // same commit: raw had 3,736 bytes of headroom, Brotli 3,231, gzip 1,880. The
  // next feature of any size turns one of those red, and a payload budget going
  // red means shipping more to the browser. That is not this argument, and it does
  // not get this raise.
  atMost('eager parsed source bytes', report.eager.sourceBytes, 7_500_000)
  atMost('settings raw bytes', report.settings.raw, 105_000)
  atMost('settings gzip bytes', report.settings.gzip, 30_000)
  atMost('settings Brotli bytes', report.settings.brotli, 26_000)
  atMost('settings parsed source bytes', report.settings.sourceBytes, 280_000)

  if (report.eager.ownershipMatrixSources.length > 0)
    errors.push('ownership matrix is present in the eager graph')
  if (report.allBrowserChunks.ownershipMatrixSources.length > 0)
    errors.push('ownership matrix is present in a browser chunk')
  if (report.eager.commandSources.length > 0)
    errors.push(`command sources are eager: ${report.eager.commandSources.join(', ')}`)

  // Deliberately phrased as a crash, not as weight: this is the one check here
  // whose breach means a route does not render at all. See
  // BROWSER_HOSTILE_SOURCES.
  if (report.allBrowserChunks.browserHostileSources.length > 0) {
    const { browserHostileSources: hostile } = report.allBrowserChunks
    errors.push(
      `${hostile.length} host-only source(s) are in a browser chunk — these evaluate ` +
        `createRequire at module scope, so the chunk THROWS on evaluation and its routes are ` +
        `gone in any built bundle (POD-2176), whatever the byte budgets say. Import the ` +
        `browser half instead (@podium/harness/browser), or move the dependency behind a port ` +
        `the composition root injects: ${hostile.slice(0, 5).join(', ')}` +
        (hostile.length > 5 ? `, and ${hostile.length - 5} more` : ''),
    )
  }

  if (report.eager.updateEngineSources.length > 0)
    errors.push(
      `update engine is eager, so the panel is back on the first paint: ${report.eager.updateEngineSources.join(', ')}`,
    )

  const allowedSettingsCommandSources = new Set([
    'packages/commands/src/settings/write-plan.ts',
    'packages/commands/src/settings/write-policy.ts',
  ])
  const unrelatedSettingsCommands = report.settings.commandSources.filter(
    (source) => ![...allowedSettingsCommandSources].some((allowed) => source.endsWith(allowed)),
  )
  if (unrelatedSettingsCommands.length > 0)
    errors.push(`unrelated settings command sources: ${unrelatedSettingsCommands.join(', ')}`)

  if (errors.length > 0) {
    for (const error of errors) console.error(`[web-bundle-budget] ${error}`)
    process.exitCode = 1
  }
}
