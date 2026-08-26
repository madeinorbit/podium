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

/** Heavy leaf renderers whose callers deliberately load them after the shell. */
const DEFERRED_FIRST_PAINT_MODULES = [
  'src/features/mobile-handoff/MobileHandoffQr.tsx',
  'src/features/chat/TranscriptFeed.tsx',
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
 * PACKAGES THAT MUST BE BUNDLED EXACTLY ONCE (POD-2469).
 *
 * Like BROWSER_HOSTILE_SOURCES above, this is a correctness check wearing a size
 * check's clothes. Every package here hands out objects that its own code then
 * recognises with `instanceof` or by reference, so a second copy in the bundle
 * does not cost bytes — it breaks the feature. `@codemirror/state` is the one
 * that taught us: `EditorState.create` walks the extension set, meets a `Facet`
 * minted by the other copy, fails the check and throws "Unrecognized extension
 * value in extension set". The file panel died on mount in edit and
 * side-by-side mode; view mode renders a preview, so it looked fine.
 *
 * `@lezer/highlight` is the quiet one. Its `tags` are the objects a grammar
 * marks its tree with AND the objects `HighlightStyle` matches against, so a
 * split there throws nothing at all — the code just stops being coloured.
 *
 * WHAT MAKES A COPY. One entry in the lockfile is not one module: what counts
 * is the resolved path on disk, and a mixed node_modules yields two of them for
 * the same version. `apps/web/node_modules/@codemirror/` carries symlinks into
 * `node_modules/.bun/` for some of these and not others, so some imports landed
 * on the `.bun` copy and the rest on the hoisted root one. That is why the fix
 * is `resolve.dedupe` in apps/web/vite.config.ts rather than an install step,
 * and why this check counts DISTINCT RESOLVED PATHS rather than chunks.
 *
 * If this fires, something reached one of these packages by a path `dedupe` does
 * not cover — a new dependency of its own, or a specifier not on that list.
 */
const SINGLETON_PACKAGES = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/search',
  '@codemirror/lint',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  'react',
  'react-dom',
] as const

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

/** Distinct on-disk installations of `pkg` that reached the bundle. Keyed by the
 *  directory the sources sit in rather than by version or lockfile entry: one
 *  entry can still be two modules, and it is the module identity that decides
 *  whether `instanceof` holds. See SINGLETON_PACKAGES. */
function packageInstallations(sourcePaths: readonly string[], pkg: string): string[] {
  const needle = `node_modules/${pkg}/`
  return [
    ...new Set(
      sourcePaths.flatMap((path) => {
        const at = path.lastIndexOf(needle)
        return at < 0 ? [] : [path.slice(0, at + needle.length - 1)]
      }),
    ),
  ].sort()
}

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
    duplicatedSingletons: SINGLETON_PACKAGES.flatMap((pkg) => {
      const installations = packageInstallations(allChunkSourcePaths, pkg)
      return installations.length > 1 ? [{ package: pkg, installations }] : []
    }),
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
  atMost('eager raw bytes', report.eager.raw, 2_260_000)
  atMost('eager gzip bytes', report.eager.gzip, 680_000)
  atMost('eager Brotli bytes', report.eager.brotli, 566_000)
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
  // 7_700_000 -> 7_780_000 (2026-08-21, POD-2470). THE PAYDOWN CAME FIRST, and it
  // is in this same commit: `packages/protocol/src/messages/runtime.ts` was the
  // agent-runtime epic's W1 contract filed as ONE module, and `./sync.ts` parses
  // `PendingInteractionWire` out of it as the `pendingInteraction` metadata feed
  // arm — so importing one browser-facing schema dragged all 55,193 bytes of the
  // contract into the eager graph, including ~19k of daemon-plane request/result
  // envelopes no browser can receive. Eager Zod schemas are built at module
  // scope, so no bundler shakes them out; only the import edge decides. Splitting
  // the interaction half into `./runtime-interactions.ts` and leaving the daemon
  // plane behind `@podium/protocol/daemon` — which is the rule `messages/index.ts`
  // and `daemon.ts` BOTH already state, and which W1 broke — took 25,314 bytes
  // out. The wire is untouched: schema digest 86b2d689b1e6358f either side.
  //
  // What is left is 46,626 over, and it is the epic's growth that CANNOT be
  // deferred, measured against the merge-base 1bda60ae6:
  //   runtime-interactions.ts  29,866  the browser parses these at runtime
  //   AgentPanel.tsx           +7,670  \
  //   panel-surface.ts         +5,006   | the terminal panel IS the workspace
  //   startup-overlay.ts       +4,235   | first paint
  //   use-panel-surface.ts     +1,757  /
  //   protocol terminal.ts     +5,992  \
  //   message-class.ts         +2,509   | wire + entity schemas the client
  //   model machine.ts         +3,376   | parses on every frame
  //   model session.ts         +2,029   |
  //   sync/host.ts             +2,416  /
  //   client-core viewmodels   +7,681  session-status, ui-state, socket-hub,
  //                                    machine-selection, replica, contract
  // Deferring any one in isolation is not available: none is behind a gesture,
  // and each is reached by the shell's own first render.
  //
  // The three payload budgets all IMPROVED and pass with room — raw 2,185,261 of
  // 2,260,000, gzip 657,105 of 680,000, Brotli 548,241 of 566,000 — so nothing
  // the browser downloads got worse; this metric counts commented source text.
  //
  // THE REAL LEVER IS NAMED AND FILED, not left for the next person to rediscover
  // (POD-2560): `AppShell.tsx` imports `Workspace` EAGERLY while SettingsView,
  // UsageView, FlightDeck, OnboardingWizard and the dialogs are all `lazy()`.
  // Workspace pulls AgentPanel -> ChatView -> the whole chat and terminal stack,
  // and the app lands on the work list, not a workspace. `TranscriptFeed.tsx` is
  // already in DEFERRED_FIRST_PAINT_MODULES above while its own scroll hooks are
  // eager, which is the tell. That paydown is worth several hundred k and should
  // bring this ceiling DOWN, not sideways.
  atMost('eager parsed source bytes', report.eager.sourceBytes, 7_780_000)
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

  // The other check phrased as a crash rather than as weight. See
  // SINGLETON_PACKAGES for why a duplicate here is a broken feature and not a
  // bigger download, and note that one of these fails silently: a split
  // `@lezer/highlight` stops colouring code without throwing anything.
  if (report.allBrowserChunks.duplicatedSingletons.length > 0) {
    const { duplicatedSingletons: duplicated } = report.allBrowserChunks
    errors.push(
      `${duplicated.length} package(s) are in the bundle more than once: ` +
        `${duplicated.map(({ package: pkg, installations }) => `${pkg} (${installations.length})`).join(', ')}. ` +
        `Each hands out objects its own code recognises with instanceof, so a second copy breaks ` +
        `the feature rather than costing bytes — POD-2469 was EditorState.create throwing ` +
        `"Unrecognized extension value in extension set", which killed the file panel on mount in ` +
        `edit and side-by-side mode, and a split @lezer/highlight does the same thing silently by ` +
        `simply not colouring code. One lockfile entry is not one module: pin the specifier in ` +
        `resolve.dedupe in apps/web/vite.config.ts. Installations: ` +
        `${duplicated.flatMap(({ installations }) => installations).join(', ')}`,
    )
  }

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
      `deferred leaf renderer is back in first paint: ${report.eager.deferredFirstPaintSources.join(', ')}`,
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
