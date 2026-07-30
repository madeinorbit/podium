/**
 * Minimal static update feed for verification. Serves Tauri's update manifest at
 * /update/:target/:arch/:current and the artifact + sig from a directory. Run:
 *   bun scripts/serve-update-feed.ts <artifactsDir> <version> [port]
 *
 * The manifest shape matches Tauri's `tauri-plugin-updater` "dynamic" endpoint
 * response: a JSON object with `version`, `pub_date`, `notes`, and a `platforms`
 * map keyed by `<os>-<arch>` (here `linux-x86_64`). The `signature` is the verbatim
 * contents of the `.AppImage.sig` minisign detached signature; the updater verifies
 * it against the `pubkey` baked into tauri.conf.json before installing.
 */
import { serve } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, version, portArg] = process.argv.slice(2)
if (!dir || !version) {
  console.error('usage: bun scripts/serve-update-feed.ts <artifactsDir> <version> [port]')
  process.exit(2)
}
const port = Number(portArg ?? 8788)
const appImage = readFileSync(join(dir, `Podium_${version}_amd64.AppImage`))
const sig = readFileSync(join(dir, `Podium_${version}_amd64.AppImage.sig`), 'utf8').trim()

serve({
  port,
  // Bind on all loopback paths; the updater endpoint uses 127.0.0.1.
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/update/')) {
      // Tauri appends /<target>/<arch>/<current_version>; respond with the manifest.
      console.error(`[feed] manifest request: ${url.pathname} -> v${version}`)
      return Response.json({
        version,
        notes: 'verification build',
        pub_date: '2026-06-22T00:00:00Z',
        platforms: {
          'linux-x86_64': { signature: sig, url: `http://127.0.0.1:${port}/artifact` },
        },
      })
    }
    if (url.pathname === '/artifact') {
      console.error(`[feed] artifact request (${appImage.byteLength} bytes)`)
      return new Response(appImage, { headers: { 'content-type': 'application/octet-stream' } })
    }
    return new Response('not found', { status: 404 })
  },
})
console.error(`update feed for v${version} on :${port} (artifact ${appImage.byteLength} bytes, sig ${sig.length} chars)`)
