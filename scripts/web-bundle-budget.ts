#!/usr/bin/env bun

/**
 * THE BUNDLE PLACEMENT CHECK — and why it runs LAST, after the stamp.
 *
 * `--check` fails the build when a module lands in the wrong place: a deferred
 * surface back in first paint, a host-only source in a browser chunk, a package
 * bundled twice. It sets no byte ceilings; the sizes in the JSON report on
 * stdout are for reading, not a gate.
 *
 * This script only READS `dist`; it writes nothing. That is what decides its
 * place in the web build: it is a judgement on an artifact that is already
 * finished, so it must not stand between the build and the stamp that names it.
 * With a check in front of the stamp, a complaint left a perfectly good build
 * with no `podium-build.json`, and the server read the website as "not for this
 * commit" forever (POD-2002). A breach still fails the build command, so
 * landings and CI still stop; what is already on disk can still be named.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import {
  type BuildManifest,
  browserHostileSources,
  eagerClientGraphSources,
  eagerJsFiles,
} from '../apps/web/test/web-bundle-boundaries'
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
 * them. A check on totals would name no cause and suggest no fix; this names
 * both.
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
 * three behind `lazy()` took them out of first paint.
 *
 * Named for the reason the update engine is: the fix is a specific import edge.
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
  // Store/schema code may be eager in the always-pool app; these optional
  // screen bodies still load through their existing React.lazy boundaries.
  'src/features/settings/SettingsView.tsx',
  'src/app/CommandPalette.tsx',
  'src/features/issues/board-pool-data.ts',
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
 * decision, but through a second import edge added later.
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

const manifest = JSON.parse(
  readFileSync(join(dist, '.vite/manifest.json'), 'utf8'),
) as BuildManifest
const eagerChunks = eagerJsFiles(htmlJsReferences(indexHtml), manifest).map(chunkReport)
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
 * singleton — two copies throw nothing — but the old eager source budget counted
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
    clientGraphSources: eagerClientGraphSources(eagerChunks.flatMap((chunk) => chunk.sources)),
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
    browserHostileSources: browserHostileSources(allChunks.flatMap((chunk) => chunk.sources)),
  },
}

console.log(JSON.stringify(report, null, 2))

if (checkBudget) {
  const errors: string[] = []

  if (report.eager.ownershipMatrixSources.length > 0)
    errors.push('ownership matrix is present in the eager graph')
  if (report.allBrowserChunks.ownershipMatrixSources.length > 0)
    errors.push('ownership matrix is present in a browser chunk')
  // The envelope parser and the mail-command classifier (POD-2146) share
  // dependency-free mail text with the server and the CLI.
  // Every other command source still belongs behind its owning feature.
  const eagerCommandSources = report.eager.commandSources.filter(
    (source) =>
      !source.endsWith('packages/commands/src/mail/turn-close-rule.ts') &&
      !source.endsWith('packages/commands/src/mail/pointer-nudge.ts') &&
      !source.endsWith('packages/commands/src/mail/mail-command.ts'),
  )
  if (eagerCommandSources.length > 0)
    errors.push(`command sources are eager: ${eagerCommandSources.join(', ')}`)

  // A split package ships twice, and that is how a duplicated @dnd-kit came to
  // be reported as "58KB over" and hunted as a recently-eager module for a day
  // (POD-2527). It runs over every package in
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
        `A second copy is never free: the browser downloads and evaluates it twice. ` +
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
  // whose breach means a route does not render at all. The source boundary
  // lives with the other pure bundle checks in web-bundle-boundaries.ts.
  if (report.allBrowserChunks.browserHostileSources.length > 0) {
    const { browserHostileSources: hostile } = report.allBrowserChunks
    errors.push(
      `${hostile.length} host-only source(s) are in a browser chunk — these evaluate ` +
        `createRequire at module scope, so the chunk THROWS on evaluation and its routes are ` +
        `gone in any built bundle (POD-2176). Import the ` +
        `browser half instead (@podium/harness/browser), or move the dependency behind a port ` +
        `the composition root injects: ${hostile.slice(0, 5).join(', ')}` +
        (hostile.length > 5 ? `, and ${hostile.length - 5} more` : ''),
    )
  }

  if (report.eager.updateEngineSources.length > 0)
    errors.push(
      `update engine is eager, so the panel is back on the first paint: ${report.eager.updateEngineSources.join(', ')}`,
    )

  if (report.eager.clientGraphSources.length > 0)
    errors.push(
      `client-graph code outside the declared startup store/readers is eager: ` +
        `${report.eager.clientGraphSources.map(readableSource).join(', ')}. ` +
        `Keep optional screen code behind its owning screen's dynamic import; ` +
        `a new startup dependency needs an explicit boundary decision.`,
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
    process.exitCode = 1
  }
}
