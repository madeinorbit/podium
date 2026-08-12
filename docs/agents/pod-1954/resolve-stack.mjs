/**
 * POD-1954 — resolve a crash report's minified frames through the build's HIDDEN
 * source maps.
 *
 * A web crash lands in `~/.podium/logs/crashes/<stamp>-<id>.json` with `err.stack`
 * and `context.componentStack` naming frames the way the browser saw them:
 * `Xr`/`qr`/`Os` at some line:column inside `assets/index-<hash>.js`. With
 * `sourcemap: 'hidden'` the page never fetches a map, so the mapping happens HERE,
 * offline, against the `.map` for that bundle.
 *
 * MATCH THE HASH. The map is only valid for the bundle the crash names — read the
 * `index-<hash>.js` out of the stack and resolve against THAT map. Minified names
 * are not stable across builds (a rebuild can turn `wDe` from a component into a
 * className string), so resolving a stale crash against a newer map yields
 * confident nonsense rather than a miss. Everything below exists to make that
 * mistake impossible to make by accident.
 *
 * Usage:
 *   node docs/agents/pod-1954/resolve-stack.mjs <bundle-or-map> <line:col> [line:col ...]
 *
 * `<bundle-or-map>` is either:
 *   - the bundle the crash names — `index-wTnyuHr3.js`, or the whole URL from the
 *     stack. Its map is looked up in the retained-build store (POD-1957), which
 *     holds the last 10 builds, so a report survives the rebuilds that follow it.
 *   - a path to a `.map` file, when you have one in hand (e.g. `dist/assets/...`).
 *
 * A bundle whose build has aged out of the window EXITS NON-ZERO and resolves
 * nothing. That is deliberate: no answer beats a wrong one here.
 *
 * Resolve the TOP componentStack frame first: that is the component that crashed.
 *
 * For CPU profiles rather than crash stacks, use
 * docs/agents/pod-1658/resolve-profile.mjs, which does the same lookup per frame.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping')

/** Mirrors scripts/archive-web-sourcemaps.ts. The archiver's own test spawns THIS
 *  file against a store it just wrote, so the two cannot drift apart unnoticed. */
const STORE_DIR =
  process.env.PODIUM_SOURCEMAP_STORE ??
  fileURLToPath(new URL('../../../apps/web/.sourcemaps', import.meta.url))

const [target, ...frames] = process.argv.slice(2)
if (!target || frames.length === 0) {
  console.error(
    'usage: node resolve-stack.mjs <bundle-or-map> <line:col> [line:col ...]\n' +
      '       <bundle-or-map> is the bundle the crash names (index-<hash>.js, or the\n' +
      '       whole URL from the stack), or a path to a .map file.',
  )
  process.exit(2)
}

/** `https://host/assets/index-wTnyuHr3.js?v=1` → `index-wTnyuHr3.js`. Also accepts
 *  the map's own name, so pasting either half of the pair works. */
function bundleNameFrom(value) {
  const withoutQuery = value.split(/[?#]/, 1)[0]
  const base = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1)
  return base.endsWith('.map') ? base.slice(0, -'.map'.length) : base
}

function readStore() {
  const file = path.join(STORE_DIR, 'builds.json')
  if (!fs.existsSync(file)) return { builds: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { builds: Array.isArray(parsed.builds) ? parsed.builds : [] }
  } catch {
    return { builds: [] }
  }
}

/** What the window holds right now, newest first — the reader needs this to tell
 *  "pruned" from "never built here". */
function describeWindow(builds) {
  if (builds.length === 0) {
    return `  (the store at ${STORE_DIR} is empty — no build has been archived here)`
  }
  return builds
    .map((build, index) => `  ${index + 1}. ${build.entry ?? '(unknown entry)'}  ${build.at}`)
    .join('\n')
}

/** The map text for a bundle, or a hard exit explaining why there is not one. */
function mapTextForBundle(bundle) {
  const { builds } = readStore()
  const digests = [
    ...new Set(
      builds.flatMap((build) =>
        (build.maps ?? []).filter((m) => m.bundle === bundle).map((m) => m.digest),
      ),
    ),
  ]

  if (digests.length === 0) {
    console.error(
      `NO RETAINED MAP for ${bundle}.\n` +
        'That build is not in the retained window, so this crash CANNOT be resolved.\n' +
        "Do NOT resolve it against another build's map: minified names are not stable\n" +
        'across builds, and the answer would be confident nonsense.\n\n' +
        `Retained builds (newest first), from ${STORE_DIR}:\n${describeWindow(builds)}`,
    )
    process.exit(3)
  }

  if (digests.length > 1) {
    console.error(
      `AMBIGUOUS: ${bundle} has ${digests.length} distinct maps in the retained window\n` +
        `(${digests.join(', ')}), so the same bundle name came from more than one build\n` +
        'and there is no way to tell which one this crash came from. Refusing to guess.',
    )
    process.exit(4)
  }

  const file = path.join(STORE_DIR, 'maps', `${digests[0]}.map.gz`)
  if (!fs.existsSync(file)) {
    console.error(
      `STORE CORRUPT: ${bundle} is listed in builds.json as ${digests[0]}, but\n` +
        `${file} is missing. Rebuild the web app to repopulate the store.`,
    )
    process.exit(5)
  }
  return gunzipSync(fs.readFileSync(file)).toString('utf8')
}

// A path that actually exists is used as given; anything else is read as the
// bundle a crash named. A mistyped path therefore lands in the store lookup and
// fails loudly there, rather than being silently resolved against the wrong file.
const targetIsFile = fs.existsSync(target) && fs.statSync(target).isFile()
const mapText = targetIsFile
  ? fs.readFileSync(target, 'utf8')
  : mapTextForBundle(bundleNameFrom(target))

const map = new TraceMap(JSON.parse(mapText))

for (const frame of frames) {
  const [line, column] = frame.split(':').map(Number)
  if (!Number.isFinite(line) || !Number.isFinite(column)) {
    console.log(`${frame}  ->  (not a line:col)`)
    continue
  }
  const origin = originalPositionFor(map, { line, column })
  const source = origin.source ? origin.source.replace(/^.*\/(src|node_modules)\//, '$1/') : '?'
  console.log(
    `${frame}  ->  ${source}:${origin.line ?? '?'}:${origin.column ?? '?'}` +
      (origin.name ? `  (${origin.name})` : ''),
  )
}
