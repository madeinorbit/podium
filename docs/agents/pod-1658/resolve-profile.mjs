/**
 * POD-1658 — resolve a V8 .cpuprofile through the build's HIDDEN source maps.
 *
 * A CDP `Profiler.stop` result names frames as V8 saw them: `ure`, `dre`, `ese` at
 * some line:column inside `index-<hash>.js`. The browser never applies a source map
 * to a CPU profile (and with `sourcemap: 'hidden'` it does not even know one exists),
 * so the mapping has to happen HERE, offline, against the `.map` files sitting next
 * to the chunks in dist.
 *
 * Two things get resolved per frame, and they are not the same lookup:
 *   - the LOCATION: bundle line:col -> original file:line:col, straight from the map.
 *   - the NAME: minified `ure` -> `worktreeForCwd`. The mapping's `name` field only
 *     carries a name when the minifier recorded one for that exact position, which for
 *     a function's ENTRY position it usually does not. So we fall back to reading the
 *     original source out of the map's `sourcesContent` and lifting the identifier at
 *     the mapped position — that is the declaration site, so the name is right there.
 *
 * Usage:
 *   node docs/agents/pod-1658/resolve-profile.mjs <profile.cpuprofile> <dist-dir> [topN]
 *
 * Prints top self time and top inclusive time, same shape as
 * docs/agents/pod-1641/cdpan.mjs (which this replaces for BUILT bundles; that one is
 * still fine against the vite dev server, where names are never mangled).
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping')

const [profilePath, distDir, topArg] = process.argv.slice(2)
if (!profilePath || !distDir) {
  console.error('usage: resolve-profile.mjs <profile.cpuprofile> <dist-dir> [topN]')
  process.exit(1)
}
const TOP = Number(topArg || 25)

const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))

// --- source maps, loaded lazily per bundle file -----------------------------

const maps = new Map() // basename -> TraceMap | null
function mapFor(url) {
  const file = path.basename(new URL(url, 'http://x/').pathname)
  if (maps.has(file)) return maps.get(file)
  const mapPath = path.join(distDir, `${file}.map`)
  let tm = null
  if (fs.existsSync(mapPath)) tm = new TraceMap(JSON.parse(fs.readFileSync(mapPath, 'utf8')))
  maps.set(file, tm)
  return tm
}

/**
 * Pull the declared identifier at an original position out of `sourcesContent`.
 * Handles the shapes our sources actually use at a function's entry position:
 *   function foo(       |  const foo = (      |  foo(x) {  (method/property)
 *   export function foo |  async function foo |  foo: (x) =>
 * Returns null when the position points at something anonymous.
 */
const sourceLines = new Map()
function identifierAt(tm, source, line, column) {
  const idx = tm.sources.indexOf(source)
  if (idx < 0) return null
  const content = tm.sourcesContent?.[idx]
  if (!content) return null
  let lines = sourceLines.get(source)
  if (!lines) {
    lines = content.split('\n')
    sourceLines.set(source, lines)
  }
  const text = lines[line - 1]
  if (text === undefined) return null
  // Look at the token starting at `column` first, then at the whole line: a mapped
  // entry position can land on `function`, on the name itself, or on the paren.
  const from = text.slice(column)
  const decl =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(from) ||
    /^(?:async\s+)?(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*[(:=]/.exec(from) ||
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/.exec(text) ||
    /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text) ||
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(text)
  return decl ? decl[1] : null
}

/** `../../packages/x/src/y.ts` -> `packages/x/src/y.ts`; node_modules paths get trimmed. */
function shortSource(source) {
  return source.replace(/^(\.\.\/)+/, '').replace(/^.*?\/node_modules\//, 'node_modules/')
}

const resolvedCache = new Map()
function resolveFrame(f) {
  const cacheKey = `${f.url}|${f.lineNumber}|${f.columnNumber}|${f.functionName}`
  const hit = resolvedCache.get(cacheKey)
  if (hit) return hit
  let out = {
    name: f.functionName || '(anon)',
    loc: f.url ? `${f.url.replace(/^https?:\/\/[^/]+/, '')}:${f.lineNumber + 1}` : '',
    mapped: false,
  }
  const tm = f.url ? mapFor(f.url) : null
  if (tm) {
    // V8 call frames are 0-based in both axes; trace-mapping wants 1-based lines.
    const pos = originalPositionFor(tm, { line: f.lineNumber + 1, column: f.columnNumber })
    if (pos?.source) {
      const name = pos.name || identifierAt(tm, pos.source, pos.line, pos.column) || f.functionName
      out = { name: name || '(anon)', loc: `${shortSource(pos.source)}:${pos.line}`, mapped: true }
    }
  }
  resolvedCache.set(cacheKey, out)
  return out
}

// --- aggregation (same maths as pod-1641/cdpan.mjs) -------------------------

const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id)

const dt = profile.timeDeltas || []
const selfUs = new Map()
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i]
  selfUs.set(id, (selfUs.get(id) || 0) + (dt[i] || 0))
}
const spanUs = dt.reduce((s, x) => s + x, 0)

/**
 * Fold by RESOLVED identity: one source function is many bundle nodes (inlining,
 * multiple call sites). Reporting those separately is a large part of why the
 * original POD-1658 profile looked like a flat "6% everywhere" and named nothing.
 * U+001F (unit separator) joins name and location: unlike a space or colon it
 * cannot occur inside either field, so splitting the key back apart is lossless.
 */
const SEP = String.fromCharCode(0x1f)
const keyOf = (node) => {
  const r = resolveFrame(node.callFrame)
  return r.name + SEP + r.loc
}
const split = (key) => key.split(SEP)

const selfByKey = new Map()
let unmappedUs = 0
let mappedUs = 0
for (const [id, us] of selfUs) {
  const node = byId.get(id)
  if (!node) continue
  const r = resolveFrame(node.callFrame)
  if (node.callFrame.url) {
    if (r.mapped) mappedUs += us
    else unmappedUs += us
  }
  const key = r.name + SEP + r.loc
  selfByKey.set(key, (selfByKey.get(key) || 0) + us)
}

const inclByKey = new Map()
for (const [id, us] of selfUs) {
  let cur = id
  const seen = new Set()
  while (cur !== undefined) {
    const node = byId.get(cur)
    if (!node) break
    const key = keyOf(node)
    if (!seen.has(key)) {
      seen.add(key)
      inclByKey.set(key, (inclByKey.get(key) || 0) + us)
    }
    cur = parent.get(cur)
  }
}

// --- report -----------------------------------------------------------------

/**
 * V8's bookkeeping frames. In any profile with idle time they dominate both tables
 * while saying nothing about which of OUR functions is hot, so they are reported
 * once in the header and the tables renormalise over what is left.
 * `(garbage collector)` deliberately stays IN the tables: allocation pressure is a
 * finding, not bookkeeping.
 */
const BOOKKEEPING = new Set(['(idle)', '(program)', '(root)'])
const isBookkeeping = (key) => BOOKKEEPING.has(split(key)[0])

const scriptedUs = [...selfByKey].reduce((sum, [k, us]) => (isBookkeeping(k) ? sum : sum + us), 0)
const fmt = ([key, us]) => {
  const [name, loc] = split(key)
  const pct = scriptedUs ? ((100 * us) / scriptedUs).toFixed(1) : '0.0'
  return `${(us / 1e6).toFixed(3).padStart(9)}s ${pct.padStart(5)}%  ${name.padEnd(30)} ${loc}`
}
const table = (m) =>
  [...m]
    .filter(([k]) => !isBookkeeping(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)

const spanShare = (name) => `${((100 * (selfByKey.get(name + SEP) || 0)) / spanUs).toFixed(1)}%`
const withUrl = mappedUs + unmappedUs
console.log(
  `profile span ${(spanUs / 1e6).toFixed(1)}s; samples ${profile.samples.length}; ` +
    `idle ${spanShare('(idle)')}, program ${spanShare('(program)')}\n` +
    `scripted time ${(scriptedUs / 1e6).toFixed(2)}s — percentages below are OF THAT; ` +
    `maps loaded ${[...maps.values()].filter(Boolean).length}; ` +
    `resolved ${withUrl ? ((100 * mappedUs) / withUrl).toFixed(1) : '0'}% of scripted self time`,
)
console.log('\n--- TOP SELF TIME (source-mapped) ---')
for (const e of table(selfByKey)) console.log(fmt(e))
console.log('\n--- TOP INCLUSIVE (source-mapped) ---')
for (const e of table(inclByKey)) console.log(fmt(e))
