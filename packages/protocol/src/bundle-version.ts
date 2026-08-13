/**
 * FORENSIC BUNDLE IDENTITY — the Vite entry-chunk hash.
 *
 * This is NOT the product version. Operators see `PODIUM_APP_VERSION` or
 * `dev+<sha>` (see {@link resolveProductVersion}). The chunk hash stays on the
 * stamp as `bundleVersion` so a crash stack (`index-DHMkD0wf.js`) can still be
 * matched by eye.
 *
 * WHY THE ENTRY CHUNK HASH. It is what a crash stack already names. It is
 * content-derived, so it changes exactly when the code changes. And it
 * fingerprints the whole module graph: a lazy chunk's hash appears in the
 * entry as an import specifier, so a change anywhere downstream changes it.
 *
 * Vite serving source has no hashed entry — these return undefined
 * rather than inventing one.
 */

/** Vite's default content hash: base64url, eight characters. */
const HASHED_ENTRY = /(?:^|\/)[^/?#]+-([A-Za-z0-9_-]{8})\.js(?:[?#]|$)/

/** Every `<script …>` open tag, so the attributes can be read in any order —
 *  `type` before `src` is only vite's current habit, not a guarantee. */
const SCRIPT_TAG = /<script\b[^>]*>/gi
const TYPE_MODULE = /\btype=["']module["']/i
const SRC_ATTR = /\bsrc=["']([^"']+)["']/i

/**
 * The forensic identity carried by an entry chunk's URL, or undefined when the
 * URL carries no content hash (Vite serving `/src/main.tsx`).
 */
export function bundleVersionFromEntrySrc(src: string): string | undefined {
  const hash = HASHED_ENTRY.exec(src)?.[1]
  return hash ? `bundle+${hash}` : undefined
}

/** The same identity, derived from built HTML — what the stamp writer records
 *  as `bundleVersion`, not as the product version. */
export function bundleVersionFromHtml(html: string): string | undefined {
  for (const [tag] of html.matchAll(SCRIPT_TAG)) {
    if (!TYPE_MODULE.test(tag)) continue
    const src = SRC_ATTR.exec(tag)?.[1]
    if (src !== undefined) return bundleVersionFromEntrySrc(src)
  }
  return undefined
}
