import { bundleVersionFromEntrySrc } from '@podium/protocol'

/**
 * WHICH BUILD IS RUNNING, read out of the page itself (POD-1965).
 *
 * The bundle's own entry script tag carries a content hash — `index-DHMkD0wf.js`
 * — which is both the identity a crash stack already prints and a fingerprint of
 * the whole module graph. {@link bundleVersionFromEntrySrc} turns it into the
 * string the build stamp writes under `appVersion`, so a log line and
 * `podium-build.json` name the same build.
 *
 * SYNCHRONOUS, AND NOT A FETCH. The previous attempt asked the server for
 * `/podium-build.json` and tagged records once the promise resolved, which was
 * wrong twice over. Records written before it resolved — every record from boot,
 * which is where the crashes worth having are — went out untagged. And the
 * server's stamp describes the dist THE SERVER HAS: with the vite dev server in
 * front of it the page is running source the stamp knows nothing about, so the
 * answer would have been confidently wrong. The page's own script tag cannot be
 * wrong about which bundle the page is.
 *
 * A source-mode dev server has no build, so it says so rather than borrowing the
 * dist's identity or leaving `v` off entirely — an absent field is what made the
 * original defect invisible.
 */
export const DEV_SERVER_VERSION = 'dev-server'

export function pageBuildVersion(doc: Pick<Document, 'querySelectorAll'> = document): string {
  for (const script of doc.querySelectorAll('script[type="module"][src]')) {
    const src = script.getAttribute('src')
    const version = src === null ? undefined : bundleVersionFromEntrySrc(src)
    if (version) return version
  }
  return DEV_SERVER_VERSION
}
