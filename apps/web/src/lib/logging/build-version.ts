import {
  bundleVersionFromEntrySrc,
  PRODUCT_VERSION_META,
  sourceDigest,
  SOURCE_DIGEST_META,
} from '@podium/protocol'

/**
 * WHICH PRODUCT IS RUNNING, read out of the page itself.
 *
 * A built dist carries `<meta name="podium-version">` (`PODIUM_APP_VERSION` or
 * `dev+<sha>`). Vite serving source has no meta, so this falls through to
 * `import.meta.env.PODIUM_APP_VERSION`. Either way the string is synchronous:
 * boot records must be tagged, and a dest-server `/podium-build.json` is the
 * last built dist, not the source this page is running.
 *
 * The entry-chunk hash is a forensic field on the stamp (`bundleVersion`),
 * not this string.
 */

export function pageBuildVersion(
  doc: Pick<Document, 'querySelector'> = document,
  declared: string | undefined = import.meta.env.PODIUM_APP_VERSION,
): string {
  const fromPage = doc
    .querySelector(`meta[name="${PRODUCT_VERSION_META}"]`)
    ?.getAttribute('content')
  const labeled = fromPage?.trim()
  if (labeled) return labeled
  const baked = declared?.trim()
  if (baked) return baked
  return 'dev'
}

/** Source identity embedded in this loaded HTML; unlike a fetched stamp, it cannot move on reload. */
export function pageBuildDigest(
  doc: Pick<Document, 'querySelector'> = document,
  declared: string | undefined = import.meta.env.PODIUM_SOURCE_SHA,
): string | undefined {
  const fromPage = doc.querySelector(`meta[name="${SOURCE_DIGEST_META}"]`)?.getAttribute('content')
  return sourceDigest(fromPage ?? declared)
}

/**
 * WHICH BYTES ARE RUNNING — the entry chunk this page was loaded from (POD-2721).
 *
 * Read off the `<script>` element rather than a stamped meta on purpose. That
 * URL is the request that produced the code now executing, so it cannot be
 * stamped wrong, and it is the same string a crash stack already names.
 *
 * The entry chunk fingerprints the whole module graph — a lazy chunk's hash
 * appears in the entry as an import specifier — so comparing it against the
 * bundle the server reports answers exactly one question: are the chunk URLs
 * this page is holding still the ones on the server's disk?
 *
 * `undefined` when the entry carries no content hash (Vite serving source).
 * That is a refusal, not a default: {@link classifyAssets} turns it into
 * `unknown`, and nothing offers a reload on `unknown`.
 */
export function pageBundleVersion(
  doc: Pick<Document, 'querySelectorAll'> = document,
): string | undefined {
  let classic: string | undefined
  for (const script of doc.querySelectorAll('script[src]')) {
    const src = script.getAttribute('src')
    if (src === null) continue
    // A module entry wins when the document has one: that is the app. A hashed
    // classic script beside it is not, and only answers when nothing else does —
    // which is the shape the Metro phone export emits.
    if (script.getAttribute('type') === 'module') return bundleVersionFromEntrySrc(src)
    classic ??= bundleVersionFromEntrySrc(src)
  }
  return classic
}
