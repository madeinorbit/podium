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

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { duplicateReport } from './web-bundle-duplicates'

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
  /** `[source, bytes of original text]`, in map order. See bytesByOwner. */
  readonly sourceSizes: readonly (readonly [string, number])[]
  readonly sourceBytes: number
}

/**
 * THE PREVIOUS BUILD, ON DISK, SO A BREACH CAN SAY WHAT CHANGED (POD-2730).
 *
 * `scripts/web-bundle-baseline.json`, refreshed by hand with `--write-baseline`.
 * A committed file rather than a cache: the point is that moving the reference
 * point is a diff somebody reads, and that a CI box with no previous `dist` can
 * still answer "what grew" on the first build it ever runs.
 *
 * It is NOT a gate and nothing fails because it is out of date — the ceilings
 * below are the gate. It only decides how useful the failure is, which is why
 * `label` is recorded next to the numbers: a delta against a baseline six weeks
 * old is still worth printing, as long as the reader knows that is what it is.
 */
interface Baseline {
  readonly label: string
  readonly eager: Bytes & { readonly sourceBytes: number }
  readonly eagerBytesByOwner: Record<string, number>
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
 * SURFACES THAT ONLY EXIST AFTER A GESTURE (POD-1239).
 *
 * A right-click menu cannot be needed before a right-click, and a dialog cannot
 * be needed before the button that opens it. All three of these were eager
 * anyway — the work list's row imported the issue menu, the sidebar rail and the
 * spawn row imported the new-issue dialog — so every first paint carried the
 * whole issue-lifecycle vocabulary for a gesture nobody had made yet. Moving the
 * three behind `lazy()` is the paydown recorded at the source budget below.
 *
 * Named rather than left to the byte ceilings for the reason the update engine
 * is: the ceiling would fire on a number, and the fix is a specific import edge.
 * If this fires, some eager module imported one of these directly instead of
 * through `lazy(() => import(...))`.
 */
const INTERACTION_ONLY_MODULES = [
  'IssueContextMenu.tsx',
  'NewIssueDialog.tsx',
  'SessionContextMenu.tsx',
] as const

/**
 * Heavy leaf renderers whose callers deliberately load them after the shell.
 *
 * THE LAST THREE ARE THE PANEL BODIES (POD-2730), and they are a different size
 * of claim from the rest of this list. `AgentPanel` is the session surface —
 * the terminal and the chat view and everything they render — and it was
 * imported statically by both of its call sites, so first paint carried xterm
 * plus its WebGL addon (390,297 bytes), `marked`, `dompurify` and the whole chat
 * block vocabulary. `DockShellPanel` was the second door into xterm, static in a
 * dock whose other six panels were all already lazy. `RefMiniview` renders
 * `null` until a ref is HOVERED and brought `@base-ui/react`'s select with it.
 *
 * None of the three can paint until something arrives that first paint does not
 * have: a synced replica naming a session, a click on the shell tab, a hover.
 * Deferring them took the eager graph from 7,722,192 bytes to 6,189,048.
 *
 * If this fires, an eager module imported one of them directly instead of
 * through `lazy(() => import(...))`. For the panel bodies the shared lazy
 * binding is `src/features/terminal/AgentPanelLazy.tsx` — import from there, not
 * from `AgentPanel` itself, or two call sites become two component identities
 * and a tab moving between them remounts its terminal.
 */
const DEFERRED_FIRST_PAINT_MODULES = [
  'src/app/Workspace.tsx',
  'packages/model/src/predicates/machine-capability.ts',
  'packages/model/src/predicates/machine-handoff.ts',
  'src/app/IterationModeFrame.tsx',
  'src/lib/machine-version-skew.ts',
  'src/features/mobile-handoff/MobileHandoffQr.tsx',
  'src/features/chat/TranscriptFeed.tsx',
  'src/features/terminal/AgentPanel.tsx',
  'src/features/terminal/DockShellPanel.tsx',
  'src/components/RefMiniview.tsx',
] as const

/**
 * VENDOR CODE THAT MUST NOT BE ON THE FIRST PAINT (POD-2730) — named by PACKAGE,
 * because the module above it is not the thing that is expensive.
 *
 * The list above is a list of OUR modules, and it holds as long as nobody adds a
 * new door. These four are the doors themselves: 390,297 bytes of terminal
 * renderer that cannot draw before a PTY exists, and 144,014 bytes of markdown
 * pipeline that cannot run before there is a message to render. A guard on
 * `AgentPanel.tsx` says nothing if a NEW eager module imports `@xterm/xterm`
 * directly, and that is exactly how both of them got in: not through one
 * decision, but through a second import edge added later, under a byte ceiling
 * that could only answer in totals.
 *
 * So this is checked against the package a source was installed from rather
 * than against any file we control. Each entry names something whose whole job
 * begins AFTER the first frame.
 */
const POST_PAINT_VENDOR_PACKAGES = [
  '@xterm/xterm',
  '@xterm/addon-webgl',
  '@xterm/addon-fit',
  'dompurify',
  'marked',
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

/**
 * THE DUPLICATE CHECK LIVES NEXT DOOR, in web-bundle-duplicates.ts: the
 * packages a second copy BREAKS (SINGLETON_PACKAGES), the ones a second copy may
 * legitimately be signed off for (ACCEPTED_DUPLICATE_PACKAGES), and the pure
 * detection over source paths.
 *
 * It is a separate module because THIS file reads `apps/web/dist` at module
 * scope: importing anything from it requires a built website standing by, so a
 * check kept here could only ever be exercised by building one. That is how the
 * gate came to have no test of its own ability to refuse — the only proof was a
 * dist in a sibling worktree, which is deleted with the worktree (POD-2530).
 */
const args = process.argv.slice(2)
const checkBudget = args.includes('--check')
const writeBaseline = args.includes('--write-baseline')
const dist = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'apps/web/dist')
/** `apps/web/dist` → the checkout root, with the trailing slash ownerOf strips. */
const repoRoot = `${resolve(dist, '..', '..', '..')}/`
const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8')
const baselinePath = fileURLToPath(new URL('./web-bundle-baseline.json', import.meta.url))
const baseline: Baseline | null = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline)
  : null

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
  const sourceSizes = map.sources.map(
    (source, index) =>
      [source, Buffer.byteLength(map.sourcesContent?.[index] ?? '', 'utf8')] as const,
  )
  return {
    file: jsFile,
    ...compressedBytes(join(dist, jsFile)),
    sources: map.sources,
    sourceSizes,
    sourceBytes: sourceSizes.reduce((total, [, bytes]) => total + bytes, 0),
  }
}

/**
 * WHO OWNS A SOURCE — the unit a person can actually act on.
 *
 * A breach used to name one number, and a number names no cause and suggests no
 * fix (POD-2730: the build said `7722192 exceeds 7700000` and it took a whole
 * issue to learn that the 24,320 bytes were nine files of an unrelated reload
 * fix, with nothing in them to defer). Per-MODULE is too fine to read — the
 * eager graph is over a thousand of them — and a total is too coarse. The owner
 * is the right grain: an npm package, a workspace package, or a feature
 * directory. That is the thing you either defer or accept.
 */
function ownerOf(source: string): string {
  const absolute = resolve(join(dist, 'assets'), source)
  const at = absolute.lastIndexOf('/node_modules/')
  if (at >= 0) {
    const parts = absolute.slice(at + '/node_modules/'.length).split('/')
    return `npm:${parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]}`
  }
  const parts = absolute.replace(repoRoot, '').split('/')
  if (parts[0] === 'packages') return `pkg:${parts[1]}`
  if (parts[0] === 'apps' && parts[1] === 'web') return `web:${parts.slice(2, 5).join('/')}`
  return parts.join('/')
}

function bytesByOwner(chunks: readonly ChunkReport[]): Record<string, number> {
  const totals = new Map<string, number>()
  for (const chunk of chunks)
    for (const [source, bytes] of chunk.sourceSizes) {
      const owner = ownerOf(source)
      totals.set(owner, (totals.get(owner) ?? 0) + bytes)
    }
  return Object.fromEntries([...totals].sort((left, right) => right[1] - left[1]))
}

/** `1,493,244` — these numbers are read by people, next to each other. */
function withThousands(value: number): string {
  return value.toLocaleString('en-US')
}

function ownerLines(owners: Record<string, number>, limit: number, sign = false): string[] {
  return Object.entries(owners)
    .slice(0, limit)
    .map(([owner, bytes]) => {
      const value = (sign && bytes > 0 ? '+' : '') + withThousands(bytes)
      return `    ${value.padStart(12)}  ${owner}`
    })
}

/** `@xterm/xterm/lib/xterm.js` — a bundled source named the way a person would
 *  name it, not as the `../../../../node_modules/.bun/@xterm+xterm@5.5.0/…`
 *  spelling a source map records relative to whichever directory the build ran
 *  in. Error text is read; it is not a path anyone pastes. */
function readableSource(source: string): string {
  const at = source.lastIndexOf('/node_modules/')
  return at >= 0 ? source.slice(at + '/node_modules/'.length) : source.replace(/^(\.\.\/)+/, '')
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

/**
 * Every source in the bundle as an ABSOLUTE path. `sources` are recorded
 * relative to the map that names them, and every chunk map here sits in
 * `dist/assets`, so that is the base. The absolute form is what
 * `packageInstallations` needs: two installations of one package differ only in
 * the directory above them, and the relative spelling of the same directory
 * differs with how deep the build ran.
 */
const allChunkSourcePaths = allChunks.flatMap((chunk) =>
  chunk.sources.map((source) => resolve(join(dist, 'assets'), source)),
)

/**
 * WHAT IS IN THE BUNDLE MORE THAN ONCE — over every package, not a list
 * (POD-2527).
 *
 * SINGLETON_PACKAGES is a list of packages a second copy BREAKS. It was read as
 * if it were the list of packages a second copy MATTERS for, and the gap between
 * those two readings is the whole of POD-2527. `@dnd-kit/core` is not a
 * singleton — two copies throw nothing — but the eager source budget counts
 * `sourcesContent`, so a split put 104,325 bytes of vendor text into the total
 * twice. With `@dnd-kit/utilities` (7,960), `@trpc/server` (3,663) and `clsx`
 * (388) that is 116,336 bytes, and the build said `eager parsed source bytes:
 * 7757776 exceeds 7700000`. Read as 58KB of app growth, it sent a whole issue
 * looking for a module to lazy-load. There was none: 7,757,776 less those four
 * second copies is 7,641,440, which is what the same source measured in a
 * checkout that resolved them once.
 *
 * (The figure first recorded here was 112,673 over three packages — the same
 * measurement with `@trpc/server` missed, and 3,663 bytes short. Corrected in
 * POD-2530 by re-deriving it from the failing dist.)
 *
 * The detection itself, and the accept list beside it, are in
 * web-bundle-duplicates.ts, where they can be tested without a built website.
 */
const duplicates = duplicateReport(allChunkSourcePaths)

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
    interactionOnlySources: INTERACTION_ONLY_MODULES.flatMap((module) =>
      matchingSources(eagerChunks, module),
    ),
    deferredFirstPaintSources: DEFERRED_FIRST_PAINT_MODULES.flatMap((module) =>
      matchingSources(eagerChunks, module),
    ),
    postPaintVendorSources: POST_PAINT_VENDOR_PACKAGES.flatMap((pkg) =>
      matchingSources(eagerChunks, `node_modules/${pkg}/`),
    ),
    /** Every eager byte, attributed. See ownerOf — this is what a breach prints. */
    bytesByOwner: bytesByOwner(eagerChunks),
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
    duplicatedPackages: duplicates.duplicated,
    acceptedDuplicatePackages: duplicates.accepted,
    unusedDuplicateAcceptances: duplicates.unusedAcceptances,
    illegalDuplicateAcceptances: duplicates.illegalAcceptances,
    ownershipMatrixSources: matchingSources(allChunks, 'packages/model/src/annotations/matrix.ts'),
    browserHostileSources: BROWSER_HOSTILE_SOURCES.flatMap((fragment) =>
      matchingSources(allChunks, fragment).filter(
        (source) => !BROWSER_HOSTILE_EXCEPTIONS.some((allowed) => source.includes(allowed)),
      ),
    ).sort(),
  },
}

console.log(JSON.stringify(report, null, 2))

if (writeBaseline) {
  const next: Baseline = {
    label: process.env.PODIUM_BUNDLE_BASELINE_LABEL ?? 'unlabelled',
    eager: {
      raw: report.eager.raw,
      gzip: report.eager.gzip,
      brotli: report.eager.brotli,
      sourceBytes: report.eager.sourceBytes,
    },
    eagerBytesByOwner: report.eager.bytesByOwner,
  }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
  console.error(`[web-bundle-budget] wrote ${basename(baselinePath)} (${next.label})`)
}

if (checkBudget) {
  const errors: string[] = []
  /**
   * A BYTE BREACH PRINTS WHAT IS IN THE GRAPH, NOT JUST HOW MUCH (POD-2730).
   *
   * The failure this replaces read `eager parsed source bytes: 7722192 exceeds
   * 7700000` and stopped there. That sentence is true and useless: it blocks
   * packaging, which blocks every sandbox and every gate run, and the person it
   * blocks has no way to tell 22 KB of one deferrable module from 22 KB spread
   * over nine files of the bugfix they were landing. Both had happened in the
   * same week. Working out which cost a whole issue each time.
   *
   * So a breach now says three things. WHAT IS BIG — the largest owners in the
   * eager graph, which is where the paydown would come from. WHAT MOVED — the
   * same owners diffed against the recorded baseline, which usually names the
   * commit's own footprint in one line. And WHICH — with more than one budget
   * red, they are printed as one block rather than one line each, because they
   * are one fact about one graph.
   *
   * Only on breach. A passing build stays quiet; the full owner map is in the
   * JSON on stdout for anyone who wants it without failing first.
   */
  const breached: string[] = []
  const atMost = (label: string, actual: number, budget: number) => {
    if (actual <= budget) return
    errors.push(`${label}: ${actual} exceeds ${budget} (over by ${withThousands(actual - budget)})`)
    breached.push(label)
  }

  // THE PAYLOAD BUDGETS GO UP, AND THIS IS THE RAISE THE NOTE BELOW WARNED ABOUT
  // (2026-08-16). The 2026-08-15 raise took the source budget alone and said
  // explicitly that the three payload budgets passed THINLY — raw with 3,736
  // bytes of headroom, Brotli 3,231, gzip 1,880 — and that the next feature of
  // any size would turn one red. All three went red, and not to one feature.
  //
  // Measured, so the split is on the record rather than assumed. `origin/main`
  // at 7dad42431, built alone in a clean checkout, is ALREADY over every one of
  // the four:
  //
  //                    limit        main alone      over by
  //     raw            2,200,000     2,236,702      +36,702
  //     gzip             655,000       671,305      +16,305
  //     Brotli           545,000       559,525      +14,525
  //     source         7,500,000     7,577,217      +77,217
  //
  // POD-993 (the chat view redesign) then adds 5,960 raw / 2,864 gzip / 2,116
  // Brotli / 37,941 source on top — about a sixth of the raw overage and a third
  // of the source one. The rest is drift with no single change to point at, the
  // same diagnosis as the last two raises.
  //
  // The new ceilings sit ~17k/6k/4k/35k above HEAD. That is deliberately modest:
  // enough that the next ordinary commit does not re-red the gate while this is
  // being paid down, and not so much that the debt can be ignored. A payload
  // budget going red means the browser downloads more, which is a real cost to
  // every session on open, and three of these four are payload. This raise buys
  // nothing but room to keep working; the next one needs a paydown, not a note.
  // ALL FOUR CEILINGS COME DOWN (2026-08-24, POD-2730), and they come down
  // together because the paydown below is one move that paid all four.
  //
  //                    was          measured after      new ceiling   headroom
  //     raw            2,260,000        1,458,334         1,650,000    191,666
  //     gzip             680,000          460,501           520,000     59,499
  //     Brotli           566,000          395,176           447,000     51,824
  //     source         7,700,000        6,189,048         7,000,000    810,952
  //
  // Three payload budgets that had gone thin — the note above measured 3,736 /
  // 1,880 / 3,231 bytes of headroom in August and said the next feature of any
  // size would turn one red — now have ~13%, which is the same fraction the
  // source budget gets. One fraction rather than four judgements: they measure
  // the same graph through four lenses, so a paydown that moves one moves all
  // four, and a proportional rule means the four go red at roughly the same
  // point instead of one becoming the sentinel by accident.
  atMost('eager raw bytes', report.eager.raw, 1_650_000)
  atMost('eager gzip bytes', report.eager.gzip, 520_000)
  atMost('eager Brotli bytes', report.eager.brotli, 447_000)
  // 7_400_000 → 7_450_000 (2026-08-14) → 7_500_000 (2026-08-15) → 7_650_000
  // (2026-08-16; see the measured split above) → 7_700_000 (2026-08-17, on the
  // release line; the first 0.1.0 edge build measured 7,689,167 while every
  // payload budget still passed) → 7_800_000 (2026-08-17, edge.2 measured
  // 7,751,548, still with every payload budget passing) → 7_700_000
  // (2026-08-18, DOWN — the paydown every note here said had to come next, met
  // by the growth it was paying for; see THE PAYDOWN and THE MERGE below). This
  // one counts `sourcesContent`, i.e. ORIGINAL source text with comments, so it
  // prices the house style rather than anything the browser downloads.
  //
  // THE PAYDOWN (POD-1239). Drift took the eager graph to 7,694,486 and the gate
  // went red on `main` for every build, whatever the change. That is also how
  // the release line came to raise this ceiling twice — 7_700_000 (44ca44874, to
  // get the first 0.1.0-edge bundle out) and then 7_800_000 for edge.2 — a
  // deadline making the call the note below refused to make on the merits.
  //
  // Nothing was reverted here and no prose was deleted: three surfaces that
  // cannot be reached without a gesture stopped being eager — the issue
  // right-click menu (the work list's row imported it for every row), and the
  // new-issue dialog (the sidebar rail and the spawn row each imported it). See
  // INTERACTION_ONLY_MODULES, which now fails the build by name if any of them
  // comes back, and note that `SessionContextMenu` was already deferred this
  // exact way: this is the established shape, applied to the two it had missed.
  //
  // Measured at fcbfb2d5c with and without the three deferrals:
  //
  //                    before        after         paid down
  //     source         7,694,486     7,560,932     -133,554
  //     raw            2,192,060     2,152,070      -39,990
  //     gzip             657,037       646,516      -10,521
  //     Brotli           545,626       537,763       -7,863
  //
  // THE MERGE (2026-08-18). The paydown and the edge.2 raise were made on two
  // lines that had not met, and each note above was written without the other in
  // view: the paydown said "the lower of the two survives", meaning 7_600_000
  // against the release line's 7_700_000, and knew nothing of edge.2 taking the
  // ceiling to 7_800_000 on a graph that had grown too. Measured on the merged
  // tree, the eager graph is 7,642,796 — over the paydown's ceiling by 42,796,
  // and under edge.2's measurement by 108,752. So neither number carries over:
  // 7_600_000 would land this merge red, and 7_800_000 would hand back the
  // paydown as slack. 7_700_000 is where the merged graph actually is, plus the
  // ~57k of modest headroom this file has used before, and it is still DOWN from
  // the 7_800_000 it merges with. The paydown was not lost — it is why the
  // merged graph sits 108,752 under what edge.2 measured. It was spent, by the
  // mobile-offline and reconnect work arriving at the same time.
  //
  // The three payload ceilings are deliberately left where the 2026-08-16 raise
  // put them rather than tightened to the new numbers. Source is the gate that
  // bites first — it went red while all three of those still passed — so it stays
  // the sentinel, and re-cutting three budgets to the bone in the same commit
  // that fixes a red build just moves the redness to another line.
  //
  // This is the first move DOWN in this ratchet's history — a real reduction,
  // not the same ceiling renamed. At the drift this file has measured, the room
  // it leaves is days rather than weeks, which means the next move is a paydown
  // too. It does not have to start from a blank page: measured in the same
  // graph, all still eager — xterm plus its WebGL addon 390k (the terminal
  // renderer, evaluated before any pane has shown a terminal), dompurify +
  // marked 144k, @dnd-kit 124k (a drag cannot precede a pointer down). Each is a
  // bigger cut than this whole commit.
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
  //
  // 7_700_000 → 7_000_000 (2026-08-24, POD-2730). DOWN 700,000, against a graph
  // that came down 1,533,144 — and the gap between those two numbers is the
  // whole point of this entry.
  //
  // WHAT WENT WRONG WAS NOT A NUMBER, IT WAS THE ABSENCE OF ROOM. POD-2718 paid
  // this ceiling down and landed at 7,697,872 — 2,128 bytes under, 0.03%. The
  // very next commit to touch apps/web was POD-2721, a reload fix, and it added
  // 24,320 bytes across nine files (protocol +5,995, features/setup +5,276,
  // ErrorBoundary +3,866, served-website +2,338, chunk-load-failure +2,064, and
  // four smaller). Every one of those is the bugfix doing its job. There was
  // nothing in it to defer and nothing in it to blame, and it broke packaging —
  // which blocks every sandbox and every gate run in the repo. A ratchet whose
  // clearance is smaller than one ordinary commit is not a ratchet. It is a
  // tripwire on unrelated work, and this file's own history is a record of
  // paying for that: five raises, each one landing back within ~57k, each note
  // saying the next move had to be a paydown.
  //
  // WHERE THE 1,533,144 CAME FROM. Not from features, and not from a second copy
  // of anything — the duplicate report was empty and an independent pass over
  // the eager source maps found zero bytes double-counted, so this was placement
  // and only placement. Three surfaces that first paint cannot reach stopped
  // being eager, all three the shape POD-1239 and POD-2190 established:
  //
  //   AgentPanel (both call sites, through AgentPanelLazy)  — the session body:
  //     the terminal, the chat view, xterm + its WebGL addon (390,297), marked,
  //     dompurify. Cannot render before the replica names a session.
  //   DockShellPanel (RightDock)                            — the second door to
  //     xterm, and the one static import among that dock's seven panels.
  //   RefMiniview (AppShell)                                — renders null until
  //     a ref is hovered; brought @base-ui/react's select (~90k) with it.
  //
  // Each is guarded by name in DEFERRED_FIRST_PAINT_MODULES, and the four vendor
  // packages behind them by POST_PAINT_VENDOR_PACKAGES, so the boundary is a
  // build failure rather than a convention. The bytes were checked out of the
  // graph rollup actually built, not inferred from the import shape.
  //
  // WHY 7_000_000 AND NOT 6_250_000. 810,952 bytes of clearance, 13.1%. Measured
  // against what this file has recorded of ordinary drift — 53,497 bytes over
  // ~20 commits of shell work, 24,320 for one bugfix — that is somewhere between
  // 30 and 300 commits, i.e. months. Tighter would re-create the defect this
  // entry exists to fix; looser would hand the paydown straight back, and the
  // eager graph would grow into it without anyone deciding to spend it. 700,000
  // is banked as a real reduction and 810,952 is lent to whoever works here next.
  //
  // AND THE NEXT PAYDOWN DOES NOT START FROM A BLANK PAGE. Measured in the same
  // graph after this move, still eager: @dnd-kit 133,557 across four packages (a
  // drag cannot precede a pointer down, but Workspace's DndContext wraps the
  // pane area structurally, so that one is a refactor rather than a `lazy()`),
  // tailwind-merge 105,606 (reached by `cn()`, so genuinely everywhere), and
  // sonner 65,887. None of it is needed to keep this gate honest for months, and
  // the owner table a breach now prints is how the next person finds the list
  // without re-deriving it.
  //
  // KEPT AT 7_000_000 THROUGH THE AGENT-RUNTIME MERGE (POD-3070). The epic's own
  // entry had raised this to 7_780_000 for growth it could not defer — AgentPanel
  // +7,670, panel-surface +5,006, startup-overlay +4,235, use-panel-surface +1,757
  // — and every one of those now sits BEHIND `AgentPanelLazy`, which is the
  // deferral this ratchet was cut against. What the epic adds that is still eager
  // is the schema half: runtime-interactions.ts and the protocol/model/viewmodel
  // growth around it, ~54k, against 810,952 of clearance. The epic's `Workspace`
  // deferral survives in DEFERRED_FIRST_PAINT_MODULES above, so both sides' named
  // guards hold. Raising the ceiling to carry growth that is no longer eager would
  // hand the paydown straight back.
  atMost('eager parsed source bytes', report.eager.sourceBytes, 7_000_000)
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

  // The check that must speak BEFORE the byte ceilings do, because it is the one
  // that explains them. A split package is counted twice in `sourcesContent`, so
  // it arrives at the source budget as anonymous growth — and that is how a
  // duplicated @dnd-kit came to be reported as "58KB over" and hunted as a
  // recently-eager module for a day (POD-2527). It runs over every package in
  // the bundle rather than SINGLETON_PACKAGES, because costing bytes and
  // breaking a feature are two different reasons to be here and only the second
  // one was ever listed.
  if (report.allBrowserChunks.duplicatedPackages.length > 0) {
    const { duplicatedPackages: duplicated } = report.allBrowserChunks
    const breaking = duplicated.filter(({ breaksTheFeature }) => breaksTheFeature)
    const outgrown = duplicated.filter(({ acceptedInstallations }) => acceptedInstallations)
    errors.push(
      `${duplicated.length} package(s) are in the bundle more than once: ` +
        `${duplicated.map(({ package: pkg, installations }) => `${pkg} (${installations.length})`).join(', ')}. ` +
        (outgrown.length > 0
          ? `${outgrown
              .map(
                ({ package: pkg, installations, acceptedInstallations }) =>
                  `${pkg} was signed off for ${acceptedInstallations} installation(s) and there are ${installations.length}`,
              )
              .join('; ')} — the count on the accept list is not the count in the bundle, so the ` +
            `entry does not describe this split. Re-measure it and either correct the entry or fix ` +
            `the split; do not widen the number to make the build pass. `
          : '') +
        `A second copy is never free: it is counted twice in the eager source budget, so it ` +
        `also shows up there as growth with no feature behind it. ` +
        (breaking.length > 0
          ? `${breaking.map(({ package: pkg }) => pkg).join(', ')} ` +
            `additionally hand out objects their own code recognises with instanceof, so a split ` +
            `BREAKS them rather than costing bytes — POD-2469 was EditorState.create throwing ` +
            `"Unrecognized extension value in extension set", which killed the file panel on mount ` +
            `in edit and side-by-side mode, and a split @lezer/highlight does the same thing ` +
            `silently by simply not colouring code. `
          : '') +
        `One lockfile entry is not one module, and the second copy is often not even in this ` +
        `checkout: .worktrees/ sits inside the main checkout, so a worktree missing ` +
        `apps/web/node_modules walks up past its own root into the main one. Pin the specifier in ` +
        `resolve.dedupe in apps/web/vite.config.ts — or, if the two copies are DELIBERATE and ` +
        `both versions are needed, record them in ACCEPTED_DUPLICATE_PACKAGES in ` +
        `scripts/web-bundle-duplicates.ts with what each one is for; dedupe is the wrong advice ` +
        `for a split somebody chose. Installations: ` +
        `${duplicated.flatMap(({ installations }) => installations).join(', ')}`,
    )
  }

  // An accept list that only ever grows stops being a set of decisions and
  // becomes a set of holes. Both of these are faults in the LIST, not in the
  // bundle, and both are fixed by deleting the entry.
  if (report.allBrowserChunks.unusedDuplicateAcceptances.length > 0)
    errors.push(
      `${report.allBrowserChunks.unusedDuplicateAcceptances.join(', ')} sits in ` +
        `ACCEPTED_DUPLICATE_PACKAGES but is not bundled more than once any more. Delete the ` +
        `entry: kept, it would silently accept the next split of that package, which nobody has ` +
        `agreed to.`,
    )

  if (report.allBrowserChunks.illegalDuplicateAcceptances.length > 0)
    errors.push(
      `${report.allBrowserChunks.illegalDuplicateAcceptances.join(', ')} cannot be accepted as a ` +
        `duplicate: it is in SINGLETON_PACKAGES, where a second copy does not cost bytes but ` +
        `breaks the feature outright. Remove the entry and fix the split.`,
    )

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

  if (report.eager.interactionOnlySources.length > 0)
    errors.push(
      `first paint pays for a gesture nobody has made yet — import these through ` +
        `lazy(() => import(...)) as their other call sites do: ${report.eager.interactionOnlySources.join(', ')}`,
    )

  if (report.eager.deferredFirstPaintSources.length > 0)
    errors.push(
      `deferred first-paint module is back in first paint: ${report.eager.deferredFirstPaintSources.map(readableSource).join(', ')}`,
    )

  if (report.eager.postPaintVendorSources.length > 0) {
    const { postPaintVendorSources: vendor } = report.eager
    errors.push(
      `${vendor.length} source(s) from a package whose work begins AFTER the first frame are ` +
        `eager — the terminal renderer cannot draw before a PTY exists and the markdown ` +
        `pipeline cannot run before there is a message (POD-2730). Find the import edge that ` +
        `reaches them from the app shell and put it behind lazy(() => import(...)): ` +
        `${vendor.slice(0, 5).map(readableSource).join(', ')}` +
        (vendor.length > 5 ? `, and ${vendor.length - 5} more` : ''),
    )
  }

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
    if (breached.length > 0) {
      const note = (line: string) => console.error(`[web-bundle-budget] ${line}`)
      note('')
      note(`WHAT IS IN THE EAGER GRAPH (${withThousands(report.eager.sourceBytes)} bytes of`)
      note('original source, largest owners first — this is where a paydown comes from):')
      for (const line of ownerLines(report.eager.bytesByOwner, 12)) note(line)
      if (baseline) {
        const owners = new Set([
          ...Object.keys(baseline.eagerBytesByOwner),
          ...Object.keys(report.eager.bytesByOwner),
        ])
        const moved = Object.fromEntries(
          [...owners]
            .map(
              (owner) =>
                [
                  owner,
                  (report.eager.bytesByOwner[owner] ?? 0) -
                    (baseline.eagerBytesByOwner[owner] ?? 0),
                ] as const,
            )
            .filter(([, delta]) => delta !== 0)
            .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1])),
        )
        const total = report.eager.sourceBytes - baseline.eager.sourceBytes
        note('')
        note(
          `SINCE THE RECORDED BASELINE (${baseline.label}): ` +
            `${total > 0 ? '+' : ''}${withThousands(total)} bytes eager source.`,
        )
        if (Object.keys(moved).length > 0)
          for (const line of ownerLines(moved, 10, true)) note(line)
        else note('    nothing moved — this build matches the baseline owner for owner.')
        note('')
        note(
          'A diff spread thinly over the owners you were editing is drift, not a module to ' +
            'defer: the ceiling is what is wrong, and raising it needs the reasoning and the ' +
            'headroom written into this file, not just a bigger number.',
        )
      } else {
        note('')
        note(
          `no ${basename(baselinePath)} on disk, so this cannot say what GREW — only what is ` +
            'big. Record one with `bun scripts/web-bundle-budget.ts <dist> --write-baseline`.',
        )
      }
    }
    process.exitCode = 1
  }
}
