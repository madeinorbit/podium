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
 * TWO TOOLCHAINS EMIT PODIUM'S WEBSITES. The desktop shell is a Vite build
 * (`index-DHMkD0wf.js`); the phone shell is `expo export -p web`, which is Metro
 * (`entry-a074e4f437a1ee92fdb168054dc07da9.js`, and no `type="module"`). Both
 * are read here rather than in two places, because "the entry chunk hash" is one
 * idea and a second copy of it is a second answer waiting to disagree.
 *
 * Vite serving source has no hashed entry — these return undefined
 * rather than inventing one.
 */

/** Vite's base64url-8, or Metro's hex-32. Anchored to `.js` at both ends so a
 *  name that merely CONTAINS a run of hex is not mistaken for a hashed entry. */
const HASHED_ENTRY = /(?:^|\/)[^/?#]+-([A-Za-z0-9_-]{8}|[0-9a-f]{32})\.js(?:[?#]|$)/

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

/**
 * The same identity, derived from built HTML — what the stamp writer records
 * as `bundleVersion`, not as the product version.
 *
 * A module entry still WINS when the document has one: that is Vite's entry, and
 * a hashed classic script beside it (an analytics snippet, a polyfill) is not the
 * app. Only when no module script names a src does a plain `<script src>` answer,
 * which is the shape Metro emits for the phone export and the only script in it.
 */
export function bundleVersionFromHtml(html: string): string | undefined {
  let classic: string | undefined
  for (const [tag] of html.matchAll(SCRIPT_TAG)) {
    const src = SRC_ATTR.exec(tag)?.[1]
    if (src === undefined) continue
    if (TYPE_MODULE.test(tag)) return bundleVersionFromEntrySrc(src)
    classic ??= bundleVersionFromEntrySrc(src)
  }
  return classic
}
