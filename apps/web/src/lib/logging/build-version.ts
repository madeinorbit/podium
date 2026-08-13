import { PRODUCT_VERSION_META } from '@podium/protocol'

/**
 * WHICH PRODUCT IS RUNNING, read out of the page itself.
 *
 * Built dist: the stamp writer injects `<meta name="podium-version">` with the
 * product string (`PODIUM_APP_VERSION` or `dev+<sha>`). Dest-server: Vite
 * inlines the same string as `import.meta.env.PODIUM_APP_VERSION`. Either way
 * log field `v` and About print what Update and `/version` print.
 *
 * SYNCHRONOUS, AND NOT A FETCH. Records written before a stamp fetch resolved
 * used to go out untagged, and a dest-server fetch of `/podium-build.json`
 * describes the last built dist, not the source this page is running.
 *
 * The entry-chunk hash is a forensic field on the stamp (`bundleVersion`),
 * not this string.
 */

export function pageBuildVersion(
  doc: Pick<Document, 'querySelector'> = document,
  declared: string | undefined = import.meta.env.PODIUM_APP_VERSION,
): string {
  const fromPage = doc.querySelector(`meta[name="${PRODUCT_VERSION_META}"]`)?.getAttribute('content')
  const labeled = fromPage?.trim()
  if (labeled) return labeled
  const baked = declared?.trim()
  if (baked) return baked
  return 'dev'
}
