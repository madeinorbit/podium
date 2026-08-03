/**
 * IS THE BUNDLE WE ARE SERVING THE BUNDLE WE WERE BUILT WITH? (POD-1610)
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER IS THE ONE THAT ASKS
 * ---------------------------------------------------------------------------
 *
 * The obvious place for a staleness check is the client: fetch `/version`,
 * compare, complain. That check is worth having and it exists (apps/web's
 * version guard) — but it cannot fire for the bundle that needs it MOST, because
 * a bundle old enough to be broken is also old enough to predate the check. The
 * outage that produced this file was served by a dist built three days before the
 * code that would have noticed.
 *
 * The server has no such problem. It reads the artefact off disk, and its verdict
 * does not depend on a single line of what is inside. A stale dist from any era
 * is caught the first time it is served, which is the property that makes this
 * the GATE and the client check a convenience.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COMPARES
 * ---------------------------------------------------------------------------
 *
 * `@podium/protocol`'s {@link wireSchemaDigest} — the structural fingerprint of
 * the message schemas — computed HERE from the running server's own copy, against
 * the same value computed by the vite build and written into `podium-build.json`
 * beside index.html. Equal means the two were built from the same protocol
 * source. Unequal means they were not, whichever is older.
 *
 * A missing stamp is reported as `unstamped`, NOT as ok. Every build from this
 * change on writes one, so its absence means the dist predates the stamp — which
 * is exactly the condition that cost three days — or was produced by something
 * other than the build. Neither can be certified, and a check that reports
 * "fine" for the artefacts it cannot inspect is not a check.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD_STAMP_FILE, type BuildStamp, wireSchemaDigest } from '@podium/protocol'

export type BundleGrade =
  /** No dist at all — a source run or an API-only server. Not a problem. */
  | 'absent'
  /** Stamped, and the digest matches this server. */
  | 'ok'
  /** Stamped, and the digest does NOT match: one of the two is older. */
  | 'stale'
  /** No stamp to compare. Cannot be certified; treated as suspect. */
  | 'unstamped'

export interface BundleStatus {
  grade: BundleGrade
  /** What the dist claims, when it claims anything. */
  bundleDigest?: string
  /** What this server computes for itself. Always present. */
  serverDigest: string
  builtAt?: string
}

/**
 * One sentence a person can act on, or null when there is nothing to say.
 *
 * The action named is REBUILD, not "reload": a reload re-fetches the same stale
 * files. The whole reason this issue existed is that the root build script did
 * not build the web app, so the instruction has to be the specific command that
 * does.
 */
export function describeBundle(status: BundleStatus): string | null {
  if (status.grade === 'ok' || status.grade === 'absent') return null
  const built = status.builtAt ? ` (built ${status.builtAt})` : ''
  return status.grade === 'stale'
    ? `The web app being served${built} was built from a different protocol schema than this ` +
        `server (bundle ${status.bundleDigest}, server ${status.serverDigest}). It may drop ` +
        'messages it cannot read and show incomplete or empty views. Rebuild it: ' +
        '`bun run build` (or `bun run --filter @podium/web build`).'
    : 'The web app being served carries no build stamp, so it cannot be checked against this ' +
        'server. It predates the check or was not produced by the build. Rebuild it: ' +
        '`bun run build`.'
}

interface CacheEntry {
  key: string
  status: BundleStatus
}
const cache = new Map<string, CacheEntry>()

/**
 * Grade the dist at `webDir`.
 *
 * Re-read when the stamp's mtime/size moves, so a rebuild WHILE the server runs
 * clears the warning without a restart — the dist is served lazily and rebuilt
 * constantly in development, and a verdict cached for the process's life would
 * make the banner outlive its own cause. That is how a warning teaches people to
 * ignore warnings.
 */
export function gradeWebBundle(webDir: string): BundleStatus {
  const serverDigest = wireSchemaDigest()
  if (!webDir || !existsSync(join(webDir, 'index.html'))) return { grade: 'absent', serverDigest }

  const stampPath = join(webDir, BUILD_STAMP_FILE)
  let key = 'missing'
  if (existsSync(stampPath)) {
    const stat = statSync(stampPath)
    key = `${stat.mtimeMs}:${stat.size}`
  }
  const hit = cache.get(webDir)
  if (hit?.key === key) return hit.status

  let status: BundleStatus = { grade: 'unstamped', serverDigest }
  if (key !== 'missing') {
    try {
      const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as BuildStamp
      const bundleDigest = typeof stamp.wireSchemaDigest === 'string' ? stamp.wireSchemaDigest : ''
      const builtAt = typeof stamp.builtAt === 'string' ? stamp.builtAt : undefined
      status = bundleDigest
        ? {
            grade: bundleDigest === serverDigest ? 'ok' : 'stale',
            bundleDigest,
            serverDigest,
            builtAt,
          }
        : { grade: 'unstamped', serverDigest, builtAt }
    } catch {
      // A corrupt stamp is a stamp we cannot read: same verdict as none, never ok.
      status = { grade: 'unstamped', serverDigest }
    }
  }
  cache.set(webDir, { key, status })
  return status
}

/** Escape for an HTML text node. The message is ours, but it interpolates a
 *  digest read off disk, and a value from a file is never markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Put the warning INTO the page the stale bundle is served as.
 *
 * The injection is the point. A stale bundle cannot be asked to render a warning
 * about itself — it does not contain the code — so the only surface that reaches
 * a user of a three-day-old dist is the HTML around it. Plain markup with inline
 * styles and no script, so it renders in a bundle that fails to boot at all.
 *
 * Returns `html` untouched when there is nothing to say, so the healthy path is
 * byte-for-byte what it always was.
 */
export function injectBundleWarning(html: string, status: BundleStatus): string {
  const message = describeBundle(status)
  if (!message) return html
  const banner =
    '<div role="alert" style="position:fixed;inset:0 0 auto 0;z-index:2147483647;' +
    'background:#f5c518;color:#1a1a1a;padding:10px 16px;font:600 13px/1.5 ui-sans-serif,system-ui,sans-serif;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.35)">Podium: stale web build. ' +
    `${escapeHtml(message)}</div>`
  return html.includes('</body>') ? html.replace('</body>', `${banner}</body>`) : html + banner
}
