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
 * A file over the size ceiling is a FAILED BUILD here, not a warning: workbox
 * would leave it out of the precache, and an offline reload would then fail on
 * exactly that file.
 */
import { join } from 'node:path'
import { type GenerateSWOptions, generateSW } from 'workbox-build'

export const PHONE_BASE_PATH = '/mobile'

/** What the page loads: scripts, styles, the page, fonts, images, the manifest. */
const PRECACHED = 'js,css,html,svg,png,ico,woff2,ttf,webmanifest'

/** The settings above, for a phone dist at `distDir`. */
export function phoneServiceWorkerOptions(distDir: string): GenerateSWOptions {
  return {
    globDirectory: distDir,
    globPatterns: [
      `**/*.{${PRECACHED}}`,
      // Metro exports package assets under their install path, which has dot
      // directories (`.bun`) that `**` does not enter; name them explicitly.
      `**/.*/**/*.{${PRECACHED}}`,
    ],
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

export async function generatePhoneServiceWorker(
  distDir: string,
): Promise<{ count: number; size: number }> {
  const { count, size, warnings } = await generateSW(phoneServiceWorkerOptions(distDir))
  if (warnings.length > 0) {
    throw new Error(`the phone service worker would be incomplete:\n${warnings.join('\n')}`)
  }
  return { count, size }
}

if (import.meta.main) {
  const out = process.argv[2] ?? join(import.meta.dir, '..', 'dist')
  const { count, size } = await generatePhoneServiceWorker(out)
  console.log(`phone service worker: ${count} files precached, ${(size / 1048576).toFixed(1)} MiB`)
}
