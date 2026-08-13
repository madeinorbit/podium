/**
 * WHICH BUILD IS THIS PAGE? (POD-1965)
 *
 * Every web log record used to ship without a `v`, because the build wrote a
 * stamp with one set of keys and the page read a key that was never in it. The
 * two ends lived in different files under different toolchains and agreed only
 * by a string literal — the same failure mode {@link BUILD_STAMP_FILE}'s comment
 * describes for the filename, one level down, in the payload.
 *
 * So the derivation lives HERE, in the one package both ends already import, and
 * both ends call the same function:
 *   - `scripts/write-web-build-stamp.ts` derives it from the built index.html and
 *     writes it into the stamp as `appVersion`;
 *   - `apps/web/src/lib/logging` derives it from the DOM of the page it is
 *     running in, synchronously, before the first record is written.
 *
 * WHY THE ENTRY CHUNK HASH and not a timestamp or a git sha. It is what a crash
 * stack already names (`index-DHMkD0wf.js`), so a log line and a stack trace can
 * be matched by eye. It is content-derived, so it changes exactly when the code
 * changes and not when a clock moves. And it fingerprints the whole module graph
 * rather than one file: a lazy chunk's hash appears in the entry chunk as an
 * import specifier, so a change anywhere downstream changes the entry hash too.
 *
 * A source-mode dev server has no build and therefore no identity to report —
 * these return undefined rather than inventing one.
 */

/** Vite's default content hash: base64url, eight characters. */
const HASHED_ENTRY = /(?:^|\/)[^/?#]+-([A-Za-z0-9_-]{8})\.js(?:[?#]|$)/

/** Every `<script …>` open tag, so the attributes can be read in any order —
 *  `type` before `src` is only vite's current habit, not a guarantee. */
const SCRIPT_TAG = /<script\b[^>]*>/gi
const TYPE_MODULE = /\btype=["']module["']/i
const SRC_ATTR = /\bsrc=["']([^"']+)["']/i

/**
 * The build identity carried by an entry chunk's URL, or undefined when the URL
 * carries no content hash (the dev server serving `/src/main.tsx`).
 */
export function bundleVersionFromEntrySrc(src: string): string | undefined {
  const hash = HASHED_ENTRY.exec(src)?.[1]
  return hash ? `bundle+${hash}` : undefined
}

/** The same identity, derived from built HTML — what the stamp writer records. */
export function bundleVersionFromHtml(html: string): string | undefined {
  for (const [tag] of html.matchAll(SCRIPT_TAG)) {
    if (!TYPE_MODULE.test(tag)) continue
    const src = SRC_ATTR.exec(tag)?.[1]
    if (src !== undefined) return bundleVersionFromEntrySrc(src)
  }
  return undefined
}
