import { PRODUCT_VERSION_META } from '@podium/protocol'

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
  const fromPage = doc.querySelector(`meta[name="${PRODUCT_VERSION_META}"]`)?.getAttribute('content')
  const labeled = fromPage?.trim()
  if (labeled) return labeled
  const baked = declared?.trim()
  if (baked) return baked
  return 'dev'
}
