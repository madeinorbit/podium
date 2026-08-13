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
import {
  BUILD_STAMP_FILE,
  type BuildStamp,
  parseBuildStamp,
  webSourceDigest,
  wireSchemaDigest,
} from '@podium/protocol'

export type BundleGrade =
  /** No dist at all — a source run or an API-only server. Not a problem. */
  | 'absent'
  /** Stamped, and the digest matches this server. */
  | 'ok'
  /** Stamped, and the digest does NOT match: one of the two processes is stale. */
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
 * The action names BOTH halves of the pairing, not "reload": a reload re-fetches
 * the same files and cannot replace a server's already-loaded module graph. A
 * mismatched digest proves only that the builds differ; it cannot prove which
 * side is older. The original incident was a stale web dist, but a freshly built
 * dist beside a long-running source server is the opposite and needs a restart.
 */
export function describeBundle(status: BundleStatus): string | null {
  if (status.grade === 'ok' || status.grade === 'absent') return null
  return status.grade === 'stale'
    ? 'Podium’s server and this page are using different app builds. Some ' +
        'information may be missing. Use “Repair and reload” in the update panel to finish.'
    : 'This page is using an app build that Podium cannot verify. Some information may be ' +
        'missing. Use “Repair and reload” in the update panel to finish.'
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
/** Read the served stamp. Null when the file is missing or not JSON. */
export function readWebBuildStamp(webDir: string): BuildStamp | null {
  if (!webDir) return null
  const stampPath = join(webDir, BUILD_STAMP_FILE)
  if (!existsSync(stampPath)) return null
  try {
    return parseBuildStamp(JSON.parse(readFileSync(stampPath, 'utf8')))
  } catch {
    return null
  }
}

/** Install identity advertised as `artifacts.web.digest` on a source target. */
export function servedWebSourceDigest(webDir: string): string | undefined {
  const stamp = readWebBuildStamp(webDir)
  return stamp ? webSourceDigest(stamp) : undefined
}

/**
 * A served website's install identity, with the one distinction a digest alone
 * cannot make: is there a website here at all? (POD-1980)
 *
 * Absent and unstamped are the SAME `undefined` digest and OPPOSITE verdicts.
 * An installation that never exported the phone website has nothing stale about
 * it, and reading absence as "behind" would light Update forever with nothing to
 * install. A dist that IS on disk and names no checkout is the artefact this
 * stamp exists to replace, and must read as behind rather than as fine — the
 * POD-1610 rule that a check reporting "ok" for what it cannot inspect is not a
 * check.
 *
 * Presence is probed per call, never captured: the phone export is gitignored
 * and built by a unit that can run long after boot, so a value cached at
 * startup would answer "absent" for the rest of the process's life.
 */
export interface ServedWebIdentity {
  present: boolean
  digest?: string
}

export function servedWebIdentity(webDir: string): ServedWebIdentity {
  if (!webDir || !existsSync(join(webDir, 'index.html'))) return { present: false }
  const digest = servedWebSourceDigest(webDir)
  return digest ? { present: true, digest } : { present: true }
}

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
      const stamp = parseBuildStamp(JSON.parse(readFileSync(stampPath, 'utf8')))
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
  const title = 'Podium needs to finish updating. '
  const banner =
    '<div role="alert" style="position:fixed;inset:0 0 auto 0;z-index:2147483647;' +
    'background:#f5c518;color:#1a1a1a;padding:10px 16px;font:600 13px/1.5 ui-sans-serif,system-ui,sans-serif;' +
    `box-shadow:0 2px 8px rgba(0,0,0,.35)">${title}` +
    `${escapeHtml(message)}</div>`
  return html.includes('</body>') ? html.replace('</body>', `${banner}</body>`) : html + banner
}
