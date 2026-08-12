/**
 * RETAIN THE LAST N BUILDS' SOURCE MAPS (POD-1957).
 *
 * `apps/web` emits `sourcemap: 'hidden'` — the `.map` files land in `dist/assets`
 * and no browser ever fetches one (POD-1658). A crash report names the bundle it
 * died in (`assets/index-wTnyuHr3.js`) and is resolved OFFLINE against that
 * bundle's map. But `vite build` empties `dist`, so the NEXT build deletes the map
 * the last report needs — three POD-1954 reports were unresolvable because a
 * rebuild 20 seconds later replaced the dist.
 *
 * Resolving a stale report against the CURRENT map is not a partial answer, it is
 * a wrong one: minified names are not stable across builds (`wDe` was a component
 * in one build and a className string in the next), so the wrong map produces
 * confident nonsense. Retention is what makes the report resolvable at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS STEP DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It READS `dist` and WRITES ONLY to the store. It never adds, removes, or edits
 * a byte under `dist`, so what a release build ships is unchanged by construction
 * — not by a flag someone has to remember. Nothing new becomes reachable from a
 * browser either: the maps stay `hidden`, and the store is not served by anything.
 *
 * It does NOT symbolicate at report time. That was considered and rejected for
 * POD-1957; the deliverable is the retention window, and the resolver stays the
 * manual path (docs/agents/pod-1954/resolve-stack.mjs).
 *
 * ---------------------------------------------------------------------------
 * CONTENT-ADDRESSED, BECAUSE A BUNDLE NAME IS NOT A UNIQUE KEY
 * ---------------------------------------------------------------------------
 *
 * The obvious store is `maps/<bundle-name>.map.gz`, keyed by the exact string a
 * crash stack names. It is wrong in a narrow but real case: vite's hash covers the
 * OUTPUT chunk, and two builds can produce byte-identical output from sources
 * whose comments moved — same `index-<hash>.js`, different original line numbers
 * in the map. Keyed by name, the second build silently reuses the first build's
 * map and reports lines that are off.
 *
 * So maps are stored under a digest of their own bytes and `builds.json` records
 * the (bundle → digest) pairs per build. Two builds that share an unchanged vendor
 * chunk share one stored file, which is most of why the window fits on disk. And
 * when one bundle name does map to two distinct digests across the window, the
 * resolver can say so and refuse, instead of guessing.
 *
 * RETENTION IS 10 BUILDS, NOT 10 FILES. A build is one entry in `builds.json`; a
 * prune drops the oldest entries and then deletes only the map files no surviving
 * entry still references. A vendor chunk that has not changed in twelve builds
 * therefore survives the pruning of the build that first introduced it.
 *
 * A REBUILD THAT PRODUCED NOTHING NEW IS NOT A BUILD. Rebuilding after a
 * backend-only change emits an identical dist; counting it would evict a real
 * older build and shrink the window for free. An emit whose map set is identical
 * to the newest entry's refreshes that entry's timestamp instead of adding one.
 *
 * Measured: this fires for `build:dev`, which disables the PWA plugin, and NOT for
 * the ordinary `build` — workbox stamps a fresh id into `sw.js` every time, so
 * `sw.js.map` differs even when all twenty other maps are byte-identical. Left as
 * it is on purpose: excluding the service worker from the comparison would collapse
 * two builds into one entry and then prune the newer `sw.js.map` as unreferenced,
 * which is a crash in the service worker made unresolvable to save a slot.
 *
 * Usage: bun scripts/archive-web-sourcemaps.ts <dist-dir> [store-dir]
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/** How many builds the window holds. The bound is the point: it is the span in
 *  which a crash report is still resolvable, and past it the resolver must fail
 *  rather than answer. */
export const KEEP_BUILDS = 10

/** Bumped if the on-disk shape changes; an unreadable/older store is rebuilt from
 *  scratch rather than half-read. */
export const STORE_VERSION = 1

/** `apps/web/.sourcemaps`, relative to the repo root — beside the checkout that
 *  produced the build, not in a shared state dir. A global store would let a
 *  rebuild in one worktree prune the maps for the build another one is serving. */
export function defaultStoreDir(): string {
  return fileURLToPath(new URL('../apps/web/.sourcemaps', import.meta.url))
}

/** One bundle's map inside a build. `bundle` is the exact filename a crash stack
 *  names (`index-wTnyuHr3.js`); `digest` addresses the stored bytes. */
export interface StoredMap {
  bundle: string
  digest: string
}

export interface ArchivedBuild {
  /** ISO-8601 ms, when the maps were archived. */
  at: string
  /** The entry bundle from `index.html` — how a human recognises this build. */
  entry?: string
  maps: StoredMap[]
}

export interface SourcemapStore {
  version: number
  builds: ArchivedBuild[]
}

export interface ArchiveResult {
  build: ArchivedBuild
  /** Digests written for the first time — i.e. what this build actually cost. */
  added: string[]
  /** Builds that fell out of the window. */
  prunedBuilds: ArchivedBuild[]
  /** Stored files deleted because nothing in the window referenced them. */
  removedMaps: string[]
  /** True when the emit was identical to the newest entry and refreshed it. */
  refreshedExisting: boolean
  /** Total bytes under `maps/` after the write. */
  bytes: number
}

const BUILDS_FILE = 'builds.json'
const MAPS_DIR = 'maps'

function mapsDir(storeDir: string): string {
  return join(storeDir, MAPS_DIR)
}

function mapPath(storeDir: string, digest: string): string {
  return join(mapsDir(storeDir), `${digest}.map.gz`)
}

/** sha256 of the map's raw bytes, truncated. 12 hex is 48 bits — collision-free
 *  at a scale of tens of files by an enormous margin, and short enough to read. */
export function digestOf(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12)
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

/** Every `<name>.map` in the dist, keyed by the bundle filename it belongs to. */
export function mapFilesIn(distDir: string): { bundle: string; path: string }[] {
  if (!existsSync(distDir)) return []
  const found: { bundle: string; path: string }[] = []
  for (const path of walk(distDir)) {
    if (!path.endsWith('.map')) continue
    const base = path.slice(path.lastIndexOf('/') + 1)
    found.push({ bundle: base.slice(0, -'.map'.length), path })
  }
  return found.sort((a, b) => a.bundle.localeCompare(b.bundle))
}

/** The entry chunk `index.html` loads, e.g. `index-wTnyuHr3.js`. Undefined when
 *  there is no index.html to read — labelling is a convenience, never a gate. */
export function entryBundle(distDir: string): string | undefined {
  const html = join(distDir, 'index.html')
  if (!existsSync(html)) return undefined
  const match = readFileSync(html, 'utf8').match(/<script[^>]+src="[^"]*?([^"/]+\.js)"/)
  return match?.[1]
}

export function readStore(storeDir: string): SourcemapStore {
  const file = join(storeDir, BUILDS_FILE)
  if (!existsSync(file)) return { version: STORE_VERSION, builds: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SourcemapStore>
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.builds)) {
      return { version: STORE_VERSION, builds: [] }
    }
    // Entries are validated, not trusted: a hand-edited builds.json must degrade
    // to "that build is not retained" rather than to a crash mid-build.
    const builds = parsed.builds.filter(
      (build): build is ArchivedBuild =>
        typeof build?.at === 'string' &&
        Array.isArray(build.maps) &&
        build.maps.every((m) => typeof m?.bundle === 'string' && typeof m?.digest === 'string'),
    )
    return { version: STORE_VERSION, builds }
  } catch {
    // A truncated builds.json (a full disk mid-write) must not break the build.
    return { version: STORE_VERSION, builds: [] }
  }
}

function sameMapSet(a: StoredMap[], b: StoredMap[]): boolean {
  if (a.length !== b.length) return false
  const key = (m: StoredMap) => `${m.bundle} ${m.digest}`
  const left = a.map(key).sort()
  const right = b.map(key).sort()
  return left.every((value, index) => value === right[index])
}

function storeBytes(storeDir: string): number {
  const dir = mapsDir(storeDir)
  if (!existsSync(dir)) return 0
  let total = 0
  for (const name of readdirSync(dir)) total += statSync(join(dir, name)).size
  return total
}

/**
 * Copy this build's maps into the store, then prune the window to `keep` builds.
 *
 * Reads `distDir`; writes only under `storeDir`.
 */
export function archiveSourcemaps(options: {
  distDir: string
  storeDir: string
  keep?: number
  now?: () => number
}): ArchiveResult {
  const { distDir, storeDir, keep = KEEP_BUILDS, now = Date.now } = options
  mkdirSync(mapsDir(storeDir), { recursive: true })

  const added: string[] = []
  const maps: StoredMap[] = []
  for (const { bundle, path } of mapFilesIn(distDir)) {
    const bytes = readFileSync(path)
    const digest = digestOf(bytes)
    maps.push({ bundle, digest })
    const target = mapPath(storeDir, digest)
    // Content-addressed: an existing file with this digest IS these bytes.
    if (existsSync(target)) continue
    writeFileSync(target, gzipSync(bytes, { level: 9 }))
    added.push(digest)
  }

  const store = readStore(storeDir)
  const at = new Date(now()).toISOString()
  const build: ArchivedBuild = { at, entry: entryBundle(distDir), maps }

  const newest = store.builds[0]
  const refreshedExisting = newest !== undefined && sameMapSet(newest.maps, maps)
  const builds: ArchivedBuild[] =
    newest && refreshedExisting
      ? [{ ...newest, at, entry: build.entry }, ...store.builds.slice(1)]
      : [build, ...store.builds]

  const kept = builds.slice(0, Math.max(1, keep))
  const prunedBuilds = builds.slice(kept.length)

  const referenced = new Set(kept.flatMap((b) => b.maps.map((m) => m.digest)))
  const removedMaps: string[] = []
  for (const name of readdirSync(mapsDir(storeDir))) {
    const digest = name.replace(/\.map\.gz$/, '')
    if (referenced.has(digest)) continue
    rmSync(join(mapsDir(storeDir), name), { force: true })
    removedMaps.push(digest)
  }

  writeFileSync(
    join(storeDir, BUILDS_FILE),
    `${JSON.stringify({ version: STORE_VERSION, builds: kept }, null, 2)}\n`,
  )

  return {
    build: kept[0] ?? build,
    added,
    prunedBuilds,
    removedMaps,
    refreshedExisting,
    bytes: storeBytes(storeDir),
  }
}

/**
 * Why a build would NOT be archived. Retention is a DEV affordance: a release is
 * built in CI, is not the build anyone resolves a local crash against, and gets
 * no store written for it.
 */
export function archiveSkipReason(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PODIUM_SOURCEMAP_ARCHIVE === '0') return 'PODIUM_SOURCEMAP_ARCHIVE=0'
  if (env.PODIUM_SOURCEMAP_ARCHIVE === '1') return undefined
  if (env.CI) return 'CI is set (release builds keep no local window)'
  return undefined
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function main(): void {
  const arg = process.argv[2]
  if (!arg) {
    console.error('usage: archive-web-sourcemaps.ts <dist-dir> [store-dir]')
    process.exit(2)
  }

  const skip = archiveSkipReason(process.env)
  if (skip) {
    console.log(`[podium] source maps: not retained — ${skip}`)
    return
  }

  const distDir = isAbsolute(arg) ? arg : resolve(process.cwd(), arg)
  const storeDir = process.argv[3]
    ? resolve(process.cwd(), process.argv[3])
    : (process.env.PODIUM_SOURCEMAP_STORE ?? defaultStoreDir())

  if (mapFilesIn(distDir).length === 0) {
    // Warn rather than fail: a stamping step that breaks the build is worse than
    // the gap it reports. But say it loudly — a silent no-op here is exactly how
    // the window would quietly stop existing.
    console.warn(
      `[podium] source maps: NONE FOUND in ${distDir} — nothing retained. ` +
        'A crash report against this build will not be resolvable.',
    )
    return
  }

  const result = archiveSourcemaps({ distDir, storeDir })
  const store = readStore(storeDir)
  const label = result.build.entry ?? `${result.build.maps.length} maps`

  console.log(
    `[podium] source maps: ${result.refreshedExisting ? 'refreshed' : 'retained'} ${label} ` +
      `(${result.build.maps.length} maps, ${result.added.length} new) — ` +
      `${store.builds.length}/${KEEP_BUILDS} builds, ${mib(result.bytes)} in ${storeDir}`,
  )
  for (const pruned of result.prunedBuilds) {
    console.log(
      `[podium] source maps: pruned ${pruned.entry ?? '(unknown entry)'} from ${pruned.at} — ` +
        'crash reports naming that build can no longer be resolved',
    )
  }
}

if (import.meta.main) main()
