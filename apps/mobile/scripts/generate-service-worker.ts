/**
 * THE PHONE WEBSITE'S SERVICE WORKER (POD-7179), written into the export after
 * `patch-web-html.ts` and before precompression and the build stamp.
 *
 * It is the desktop shell's worker for the phone's dist: workbox's
 * `generateSW`, which vite-plugin-pwa runs for apps/web, with the same
 * decisions (apps/web/vite.config.ts says why for each):
 *
 *  - no `skipWaiting`: a new build installs and WAITS, so a running page keeps
 *    the precache its lazy chunks come from; Refresh hands over through the
 *    shared reload handshake (`src/lib/phone-service-worker.ts`).
 *  - `clientsClaim`: once the swap is authorised it completes in one step.
 *  - no source map, so two builds of one commit stay byte-identical.
 *  - outdated precaches are deleted on activation.
 *
 * What differs is only the phone's place: the worker lives at `/mobile/sw.js`
 * and is registered with scope `/mobile`, so its precache URLs are relative to
 * `/mobile/` and every navigation under `/mobile` falls back to the precached
 * `/mobile/index.html`. That is what lets an offline reload open the app, which
 * then reads the replica the device holds.
 *
 * The precache holds what the page loads: scripts, styles, the page, fonts and
 * images. Not JSON: `podium-build.json` must always come from the server, since
 * it is how the page learns a newer build is served. The workbox runtime is
 * inlined, so the dist gains exactly one file.
 *
 * `write-web-build-stamp.ts` rewrites the `index.html` revision afterwards, as
 * it does for the desktop's `sw.js` (POD-3083), because it changes that page.
 *
 * Workbox's glob does not enter dot directories, and Metro can export package
 * assets under an install path that has one (`.bun`): those files are added
 * to the manifest by name, with their content hash as the revision.
 *
 * A file left out is a FAILED BUILD here, not a warning: an offline reload
 * would fail on exactly that file. So after generating, every file of a
 * precached type in the export must be in the worker's manifest.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { type GenerateSWOptions, generateSW } from 'workbox-build'

export const PHONE_BASE_PATH = '/mobile'

/** What the page loads: scripts, styles, the page, fonts, images, the manifest. */
const PRECACHED = 'js,css,html,svg,png,ico,woff2,ttf,webmanifest'
const PRECACHED_FILE = new RegExp(`\\.(${PRECACHED.split(',').join('|')})$`)

/** The settings above, for a phone dist at `distDir`. */
export function phoneServiceWorkerOptions(distDir: string): GenerateSWOptions {
  const inDotDirectory = precachedTypeFiles(distDir).filter((path) =>
    path
      .split('/')
      .slice(0, -1)
      .some((part) => part.startsWith('.')),
  )
  return {
    globDirectory: distDir,
    additionalManifestEntries: inDotDirectory.map((url) => ({
      url,
      revision: createHash('md5')
        .update(readFileSync(join(distDir, url)))
        .digest('hex'),
    })),
    globPatterns: [`**/*.{${PRECACHED}}`],
    // Not workbox's default `**/node_modules/**`: the export keeps package
    // assets (fonts, the router's images) under a `node_modules` path.
    globIgnores: ['sw.js', 'workbox-*.js'],
    swDest: join(distDir, 'sw.js'),
    mode: 'production',
    sourcemap: false,
    inlineWorkboxRuntime: true,
    clientsClaim: true,
    skipWaiting: false,
    cleanupOutdatedCaches: true,
    // The phone's entry chunk is several MiB; give it headroom, and fail the
    // build (below) rather than ship a worker that leaves a file out.
    maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
    navigateFallback: `${PHONE_BASE_PATH}/index.html`,
    navigateFallbackAllowlist: [/^\/mobile(\/|\?|$)/],
  }
}

/** Every file of a precached type in the export, dot directories included. */
function precachedTypeFiles(distDir: string): string[] {
  return readdirSync(distDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && PRECACHED_FILE.test(entry.name))
    .map((entry) => relative(distDir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => path !== 'sw.js' && !/^workbox-[^/]*\.js$/.test(path))
}

export async function generatePhoneServiceWorker(
  distDir: string,
): Promise<{ count: number; size: number }> {
  const options = phoneServiceWorkerOptions(distDir)
  const { count, size, warnings } = await generateSW(options)
  const worker = readFileSync(options.swDest, 'utf8')
  const missing = precachedTypeFiles(distDir).filter((path) => !worker.includes(`url:"${path}"`))
  if (warnings.length > 0 || missing.length > 0) {
    throw new Error(
      [
        'the phone service worker would be incomplete:',
        ...warnings,
        ...missing.map((path) => `not precached: ${path}`),
      ].join('\n'),
    )
  }
  return { count, size }
}

if (import.meta.main) {
  const out = process.argv[2] ?? join(import.meta.dir, '..', 'dist')
  const { count, size } = await generatePhoneServiceWorker(out)
  console.log(`phone service worker: ${count} files precached, ${(size / 1048576).toFixed(1)} MiB`)
}
