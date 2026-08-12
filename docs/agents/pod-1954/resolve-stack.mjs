/**
 * POD-1954 — resolve a crash report's minified frames through the build's HIDDEN
 * source maps.
 *
 * A web crash lands in `~/.podium/logs/crashes/<stamp>-<id>.json` with `err.stack`
 * and `context.componentStack` naming frames the way the browser saw them:
 * `Xr`/`qr`/`Os` at some line:column inside `assets/index-<hash>.js`. With
 * `sourcemap: 'hidden'` the page never fetches a map, so the mapping happens HERE,
 * offline, against the `.map` sitting next to the chunk in `apps/web/dist`.
 *
 * MATCH THE HASH. The map is only valid for the bundle the crash names — read the
 * `index-<hash>.js` out of the stack and resolve against THAT map. Minified names
 * are not stable across builds (a rebuild can turn `wDe` from a component into a
 * className string), so resolving a stale crash against a newer map yields
 * confident nonsense. A rebuild overwrites the map, which is why an old report can
 * be unresolvable — see the sibling issue on retaining maps per build.
 *
 * Usage:
 *   node docs/agents/pod-1954/resolve-stack.mjs <dist/assets/index-<hash>.js.map> <line:col> [line:col ...]
 *
 * Resolve the TOP componentStack frame first: that is the component that crashed.
 *
 * For CPU profiles rather than crash stacks, use
 * docs/agents/pod-1658/resolve-profile.mjs, which does the same lookup per frame.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping')

const [mapPath, ...frames] = process.argv.slice(2)
if (!mapPath || frames.length === 0) {
  console.error(
    'usage: node resolve-stack.mjs <bundle.js.map> <line:col> [line:col ...]\n' +
      '       (line:col come from the crash report; the map must be the one for that bundle hash)',
  )
  process.exit(2)
}

const map = new TraceMap(JSON.parse(fs.readFileSync(mapPath, 'utf8')))

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
