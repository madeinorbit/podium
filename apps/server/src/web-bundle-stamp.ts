/**
 * IS THE BUNDLE WE ARE SERVING THE BUNDLE WE WERE BUILT WITH? (POD-1610)
 *
 * This is an operator diagnostic, not a reason to modify the page. The running
 * app owns compatibility warnings because it can identify actual wire skew and
 * route the user to the update panel. The server keeps this coarser build-pair
 * comparison for its boot log, where it can still explain a suspect deployment
 * without covering the app with a second warning.
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
  productVersionFromStamp,
  type ServedWebIdentity,
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
 * One server-log diagnostic, or null when there is nothing to report.
 *
 * The action names BOTH halves of the pairing, not "reload": a reload re-fetches
 * the same files and cannot replace a server's already-loaded module graph. A
 * mismatched digest proves only that the builds differ; it cannot prove which
 * side is older. The original incident was a stale web dist, but a freshly built
 * dist beside a long-running source server is the opposite and needs a restart.
 */
export function describeBundleDiagnostic(status: BundleStatus): string | null {
  if (status.grade === 'ok' || status.grade === 'absent') return null
  return status.grade === 'stale'
    ? 'Served web bundle wire-schema digest differs from the running server; rebuild the web ' +
        'bundle or restart the server so both come from the same source.'
    : 'Served web bundle has no valid build stamp; its compatibility with the running server ' +
        'cannot be verified.'
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
/**
 * The wire shape is the protocol's, not a second copy of it: this value is
 * published on `/version` and read by a page that may have been built from a
 * different commit, so its field names are a contract rather than an internal
 * detail.
 *
 * `bundle` is the field POD-2721 added, and it carries `bundleVersion` — the
 * entry chunk hash — straight off the stamp. The DIGEST is the checkout and the
 * BUNDLE is the bytes. An open page needs the second: two builds of one commit,
 * a packaged release and a dev release from the same SHA, share a digest and
 * share nothing else, and the page's chunk URLs belong to exactly one of them.
 */
export type { ServedWebIdentity }

export function servedWebIdentity(webDir: string): ServedWebIdentity {
  if (!webDir || !existsSync(join(webDir, 'index.html'))) return { present: false }
  const stamp = readWebBuildStamp(webDir)
  if (!stamp) return { present: true }
  const digest = webSourceDigest(stamp)
  const hasProductIdentity = typeof stamp.appVersion === 'string' || digest !== undefined
  return {
    present: true,
    ...(hasProductIdentity ? { appVersion: productVersionFromStamp(stamp) } : {}),
    ...(digest ? { digest } : {}),
    ...(stamp.bundleVersion ? { bundle: stamp.bundleVersion } : {}),
  }
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
