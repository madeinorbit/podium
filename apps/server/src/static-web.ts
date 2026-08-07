import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, normalize, sep } from 'node:path'
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib'
import { desktopShellLocation, mobileEntryRedirect } from '@podium/model'
import type { Context, Hono } from 'hono'
import { gradeWebBundle, injectBundleWarning } from './web-bundle-stamp'

/**
 * Backend route prefixes that must never be shadowed by the SPA index.html.
 * A superset of the backend prefixes in apps/web NAVIGATION_FALLBACK_DENYLIST:
 * it also covers /version, /mcp, and /hooks (which the vite dev proxy doesn't list).
 * Do NOT trim it down to match that list — that would let the SPA shell shadow a
 * backend route. When adding a backend route, add its prefix here.
 *
 * The reverse is NOT true: that denylist also carries `/` and `/desktop`, the
 * entry redirects registered by registerMobileRouting. Those must reach the
 * server rather than a service worker's precache, but they are not backend
 * routes — `/` is served from here once the redirect declines. Adding either
 * one below would 404 the web root.
 */
const BACKEND_PREFIXES = [
  '/trpc',
  '/health',
  '/version',
  '/setup',
  '/auth',
  '/files',
  '/client',
  '/daemon',
  '/hooks',
  '/mcp',
]

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  // POD-541: expo-sqlite's web worker streams this as WebAssembly.compileStreaming.
  // Wrong MIME → compile fails, the worker never answers, openDatabaseSync hits
  // "Sync operation timeout", and the replica degrades to memory-only.
  '.wasm': 'application/wasm',
}

/**
 * Extensions that mean "this request wants a FILE, not a page" [POD-421]. An
 * unmatched path ending in one of these gets a 404 rather than the SPA shell:
 * answering an icon probe with 200 text/html is a lie every consumer of it
 * mishandles differently — iOS's Add to Home Screen silently keeps whatever it
 * had, crawlers index the shell under an image URL, unfurlers show nothing.
 *
 * A DENYLIST of known asset types, deliberately not "the path contains a dot":
 * SPA routes carry user-authored segments (branch names, repo names, file
 * paths) that may well contain one, and 404ing those would break navigation to
 * them. Erring toward serving the shell is the safe direction here.
 */
const ASSET_EXTENSIONS = new Set([
  '.avif',
  '.br',
  '.css',
  '.eot',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.mp4',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.txt',
  '.wasm',
  '.webm',
  '.webmanifest',
  '.webp',
  '.woff',
  '.woff2',
  '.xml',
])

/**
 * Content types worth compressing. Everything else here (png, ico, woff/woff2)
 * is already compressed — running deflate over it burns CPU for ~0% gain, so the
 * bytes go out as-is. Keyed by extension rather than by sniffing the body.
 */
const COMPRESSIBLE_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.webmanifest',
  '.map',
  '.txt',
])

/** Below this, the gzip framing costs more than it saves. */
const MIN_COMPRESS_BYTES = 1024

/**
 * On-the-fly compression is the FALLBACK, not the plan: the build writes .br/.gz
 * next to each asset (scripts/precompress-dist.ts) and those are served straight
 * off disk. This cache exists for dists that were not pre-compressed (the Expo
 * mobile export, a dev `vite build` run by hand) so the 2.7 MB main chunk is
 * deflated once rather than once per request — this server's event loop is
 * already its bottleneck. Keyed on path+size+mtime, so a rebuild misses rather
 * than serving the previous build's bytes.
 */
const compressedCache = new Map<string, Buffer>()
let compressedCacheBytes = 0
const COMPRESSED_CACHE_LIMIT = 64 * 1024 * 1024

function cacheCompressed(key: string, buf: Buffer): void {
  if (buf.byteLength > COMPRESSED_CACHE_LIMIT) return
  while (compressedCacheBytes + buf.byteLength > COMPRESSED_CACHE_LIMIT) {
    const oldest = compressedCache.keys().next()
    if (oldest.done) break
    const evicted = compressedCache.get(oldest.value)
    compressedCache.delete(oldest.value)
    compressedCacheBytes -= evicted?.byteLength ?? 0
  }
  compressedCache.set(key, buf)
  compressedCacheBytes += buf.byteLength
}

type Encoding = 'br' | 'gzip'

/**
 * Encodings the client will accept, best first. Brotli wins when offered: it is
 * ~15% smaller than gzip on JS and every browser that speaks it over http/https
 * advertises it. `identity` is implicit; an explicit `;q=0` opts an encoding out.
 */
function acceptedEncodings(header: string | undefined): Encoding[] {
  if (!header) return []
  const accepted: Encoding[] = []
  const entries = header.split(',').map((part) => part.trim().toLowerCase())
  const wants = (name: string): boolean =>
    entries.some((entry) => {
      const [token, ...params] = entry.split(';').map((p) => p.trim())
      if (token !== name && token !== '*') return false
      return !params.some((p) => p.replace(/\s/g, '') === 'q=0' || p.replace(/\s/g, '') === 'q=0.0')
    })
  if (wants('br')) accepted.push('br')
  if (wants('gzip')) accepted.push('gzip')
  return accepted
}

function compress(buf: Buffer, encoding: Encoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer): void => {
      if (err) reject(err)
      else resolve(out)
    }
    // Both run on libuv's threadpool, so a 2.7 MB chunk does not block the loop.
    // Brotli quality 5 is the on-the-fly setting (quality 11 takes seconds); the
    // build-time pre-compression uses 11 because it pays that cost once.
    if (encoding === 'br') {
      brotliCompress(
        buf,
        {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength,
          },
        },
        done,
      )
    } else {
      gzip(buf, { level: 6 }, done)
    }
  })
}

const ENCODING_SUFFIX: Record<Encoding, string> = { br: '.br', gzip: '.gz' }

/**
 * Vite and Expo both emit content-hashed filenames (`index-RR9HhGf3.js`). Those
 * are immutable by construction: a new build is a new URL, so the browser never
 * needs to revalidate. Everything else (index.html, the service worker, manifest)
 * keeps its URL across builds and must revalidate every load.
 */
function isImmutableAsset(filePath: string): boolean {
  const name = basename(filePath)
  if (name.toLowerCase().endsWith('.html')) return false
  return /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name)
}

function cacheControl(filePath: string): string {
  return isImmutableAsset(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache'
}

/**
 * A view over the buffer, not a copy: node's Buffer is not structurally a
 * BodyInit under this lib set, but the Uint8Array over its bytes is.
 */
function body(buf: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength)
}

/**
 * Serve one file, negotiating compression. Prefers a build-time .br/.gz sitting
 * next to it; falls back to compressing once and caching. `Vary: Accept-Encoding`
 * goes out for every compressible type — including the ones we chose NOT to
 * compress this time — so a shared cache never hands a br body to a client that
 * cannot read it.
 */
async function serveFile(
  filePath: string,
  accepted: Encoding[],
  inMemory?: Buffer,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': contentType(filePath),
    'Cache-Control': cacheControl(filePath),
    ...extraHeaders,
  }
  if (!COMPRESSIBLE_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    return new Response(body(inMemory ?? readFileSync(filePath)), { status: 200, headers })
  }
  headers.Vary = 'Accept-Encoding'

  // Pre-compressed sibling from the build — the fast path for the web dist.
  if (!inMemory) {
    for (const encoding of accepted) {
      const sibling = filePath + ENCODING_SUFFIX[encoding]
      if (existsSync(sibling) && statSync(sibling).isFile()) {
        return new Response(body(readFileSync(sibling)), {
          status: 200,
          headers: { ...headers, 'Content-Encoding': encoding },
        })
      }
    }
  }

  const raw = inMemory ?? readFileSync(filePath)
  const encoding = accepted[0]
  if (!encoding || raw.byteLength < MIN_COMPRESS_BYTES) {
    return new Response(body(raw), { status: 200, headers })
  }

  // In-memory bodies (the SPA shell, rewritten per request) are compressed but
  // never cached: the stale-build warning makes each render potentially distinct.
  if (inMemory) {
    const out = await compress(raw, encoding)
    return new Response(body(out), {
      status: 200,
      headers: { ...headers, 'Content-Encoding': encoding },
    })
  }

  const stat = statSync(filePath)
  const key = `${encoding}:${filePath}:${stat.size}:${stat.mtimeMs}`
  let out = compressedCache.get(key)
  if (!out) {
    out = await compress(raw, encoding)
    cacheCompressed(key, out)
  }
  return new Response(body(out), {
    status: 200,
    headers: { ...headers, 'Content-Encoding': encoding },
  })
}

/**
 * Headers that make `window.crossOriginIsolated === true` so the page may use
 * SharedArrayBuffer.
 *
 * POD-541: expo-sqlite's web backend drives its worker through
 * SharedArrayBuffer + Atomics (the "sync" API). Without isolation the SAB
 * constructor is unavailable, openDatabaseSync falls into the degraded
 * in-memory path, and an offline relaunch finds no durable issue rows — which
 * is why deep-linked task detail painted "Task not found." after a live
 * session had just shown the task. COEP is `credentialless` rather than
 * `require-corp` so a same-origin SPA that later loads a no-CORS third-party
 * asset is not permanently bricked; SAB still unlocks under either value.
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  // Same-origin is the default for CORP, but state it so a future proxy that
  // strips defaults cannot re-open the SAB gate while leaving COEP on.
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export interface StaticWebOptions {
  basePath?: string
  /** Register routes even when the build is currently absent; each request
   *  re-checks. Lets a dist built after boot start serving without a restart
   *  (routes registered earlier, e.g. registerMobileRouting's fallback, own
   *  the absent case). */
  lazy?: boolean
  /** Compare this dist's build stamp against the running server and warn in the
   *  served HTML when they disagree (POD-1610). OPT-IN, not defaulted on: only
   *  the apps/web dist carries a stamp, so defaulting it would put a permanent
   *  "unstamped" banner on the Expo mobile shell, which is a different artefact
   *  built by a different toolchain. */
  stampCheck?: boolean
  /**
   * Opt-in isolation headers for SharedArrayBuffer (POD-541). The Expo mobile
   * shell needs them for durable expo-sqlite; the desktop web shell does not
   * and must not inherit them — COOP would break its multi-window flows.
   */
  crossOriginIsolated?: boolean
}

function contentType(p: string): string {
  return CONTENT_TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

function normalizedBasePath(basePath: string | undefined): string {
  const raw = basePath?.trim() || '/'
  if (raw === '/') return '/'
  const withLeadingSlash = raw.startsWith('/') ? raw : '/' + raw
  return withLeadingSlash.replace(/\/+$/, '') || '/'
}

function routePattern(basePath: string): string {
  return basePath === '/' ? '/*' : basePath + '/*'
}

function pathInsideBase(pathname: string, basePath: string): string | null {
  if (basePath === '/') return pathname
  if (pathname === basePath) return '/'
  if (pathname.startsWith(basePath + '/')) return pathname.slice(basePath.length) || '/'
  return null
}

function isBackendRoute(pathname: string): boolean {
  return BACKEND_PREFIXES.some((pre) => pathname === pre || pathname.startsWith(pre + '/'))
}

/**
 * Whether an unmatched path may fall back to the SPA shell [POD-421]. Only a
 * NAVIGATION may: everything else asked for a specific file that is not there,
 * and deserves to hear so.
 *
 * Two independent tells, either of which is enough to refuse:
 *
 *  - the path ends in a known asset extension (see ASSET_EXTENSIONS);
 *  - `Accept` names concrete types and text/html is not among them — an image
 *    probe sends `image/png,image/*;q=0.8`, a fetch() for JSON sends
 *    `application/json`.
 *
 * `Sec-Fetch-Mode: navigate` would be the direct answer and is checked first
 * when present, but it is not something to REQUIRE: it rides only on secure
 * contexts, and a plain-http LAN instance (how Podium is usually reached) sees
 * it on no request at all. The two tells above work everywhere.
 *
 * A wildcard Accept, or no Accept at all, still gets the shell — that is what
 * curl and a lot of tooling send, and guessing against them would 404 real
 * navigations.
 */
function isNavigationRequest(pathname: string, c: Context): boolean {
  const mode = c.req.header('sec-fetch-mode')
  if (mode) return mode === 'navigate'
  if (ASSET_EXTENSIONS.has(extname(pathname).toLowerCase())) return false
  const accept = c.req.header('accept')
  if (!accept) return true
  return accept.split(',').some((entry) => {
    const type = entry.split(';')[0]?.trim().toLowerCase()
    return type === 'text/html' || type === '*/*' || type === 'text/*'
  })
}

/**
 * iOS probes these two EXACT names at the origin root when a page's declared
 * apple-touch-icon cannot be used, and it is the only icon path that Add to
 * Home Screen has when the declaration is missed [POD-421]. Neither name is
 * emitted by @vite-pwa/assets-generator (which writes the sized name) or by
 * Expo, so both are served here as aliases of whatever 180x180 the dist does
 * ship. `-precomposed` is the older spelling and means "already has the gloss
 * baked in" — the same bytes answer it.
 */
const APPLE_TOUCH_ICON_NAMES = new Set([
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
])
const APPLE_TOUCH_ICON_SOURCES = [
  'apple-touch-icon-180x180.png', // apps/web, via pwa-assets.config.ts
  join('icons', 'apple-touch-icon.png'), // apps/mobile, via scripts/generate-web-icons.ts
]

function appleTouchIcon(webDir: string, inside: string): string | null {
  if (!APPLE_TOUCH_ICON_NAMES.has(inside)) return null
  for (const name of APPLE_TOUCH_ICON_SOURCES) {
    const candidate = join(webDir, name)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Mobile entry routing [POD-102, reverses SP-902c]: the Expo app at /mobile is
 * the ONLY mobile UX — phone browsers hitting exactly `/` are redirected there.
 * The responsive web shell is gone; /desktop remains as the Expo app's escape
 * hatch to the desktop web shell (`/?desktop=1` suppresses the phone redirect
 * for that navigation). Deep links (e.g. /session/xyz) are never redirected.
 * When the Expo build is absent, /mobile falls back to the desktop shell instead
 * of loading the main SPA under a wrong base path. Every redirect preserves the
 * query string (?server, ?e2e). The decision itself lives in @podium/model, so
 * this door and the two in apps/web cannot drift apart (POD-359).
 *
 * Presence is a live probe, not a boot-time flag: the mobile dist is gitignored
 * and built separately from the web dist, so a deploy can restart the server
 * before (or without) exporting it. With a boot-time flag that ordering silently
 * disabled the phone redirect until the next restart.
 *
 * `redirectPhoneRoot: false` withholds only the `/` redirect while /mobile keeps
 * serving Expo — the browser harness drives both shells from one server and would
 * otherwise never reach the web shell from a phone-sized Pixel profile.
 */
export function registerMobileRouting(
  app: Hono,
  opts: { expoMobilePresent: () => boolean; redirectPhoneRoot?: boolean },
): void {
  const present = opts.expoMobilePresent
  // Carries the ?desktop marker, which tells apps/web's browser-side redirect
  // that the Expo build is genuinely absent rather than bouncing back to it.
  const toDesktopShell = (c: Context) => c.redirect(desktopShellLocation(new URL(c.req.url).search))
  app.get('/', async (c, next) => {
    const url = new URL(c.req.url)
    if (opts.redirectPhoneRoot !== false) {
      const target = mobileEntryRedirect({
        pathname: url.pathname,
        search: url.search,
        userAgent: c.req.header('user-agent'),
        mobilePresent: present(),
      })
      if (target) return c.redirect(target)
    }
    await next()
  })
  app.get('/desktop', toDesktopShell)
  const mobileFallback = async (c: Context, next: () => Promise<void>) => {
    if (!present()) return toDesktopShell(c)
    await next()
  }
  app.get('/mobile', mobileFallback)
  app.get('/mobile/*', mobileFallback)
}

/**
 * The SPA shell, with the stale-build warning folded in when it applies.
 *
 * Read per request rather than cached at registration: `lazy` dists appear after
 * boot and every dev rebuild replaces this file, so a cached shell would serve a
 * warning about a build that no longer exists (see `gradeWebBundle`, which caches
 * the VERDICT on the stamp's mtime and so re-grades exactly when the stamp moves).
 */
function serveIndex(webDir: string, indexPath: string, stampCheck: boolean): string {
  const html = readFileSync(indexPath, 'utf8')
  return stampCheck ? injectBundleWarning(html, gradeWebBundle(webDir)) : html
}

/**
 * Serve the built web bundle for EXTERNAL clients (browser / phone / other desktop
 * app connecting to a running machine). The Tauri desktop window uses its own bundled
 * UI, not this route. Returns false (registers nothing) when no build is present, so a
 * source/dev run or an API-only server is unaffected. Call AFTER the API routes.
 */
export function registerWebStatic(
  app: Hono,
  rawWebDir: string,
  opts: StaticWebOptions = {},
): boolean {
  // Normalised ONCE, here, because the containment guard below compares a
  // `join`ed (and therefore already normalised) path against this string. Handed
  // a dir with a `..` or a trailing slash in it — `<root>/.claude/../apps/web/dist`
  // is exactly how a preview harness writes it — every real file failed that
  // prefix test and fell through to the SPA shell. Silently: the dist was fine
  // and the server answered 200 text/html for all of it, which looked like a
  // working site until the catch-all stopped lying [POD-421].
  const webDir = normalize(rawWebDir).replace(/[/\\]+$/, '')
  const indexPath = join(webDir, 'index.html')
  if (!opts.lazy && !existsSync(indexPath)) return false

  const basePath = normalizedBasePath(opts.basePath)
  const isolationHeaders = opts.crossOriginIsolated ? CROSS_ORIGIN_ISOLATION_HEADERS : undefined
  const handler = async (c: Context) => {
    if (opts.lazy && !existsSync(indexPath)) return c.notFound()
    const pathname = new URL(c.req.url).pathname
    const inside = pathInsideBase(pathname, basePath)
    if (inside === null) return c.notFound()
    if (isBackendRoute(pathname)) return c.notFound()

    const rel = normalize(decodeURIComponent(inside)).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(webDir, rel)
    const accepted = acceptedEncodings(c.req.header('accept-encoding'))
    if (
      (filePath === webDir || filePath.startsWith(webDir + sep)) &&
      existsSync(filePath) &&
      statSync(filePath).isFile() &&
      filePath !== indexPath
    ) {
      return await serveFile(filePath, accepted, undefined, isolationHeaders)
    }
    const icon = appleTouchIcon(webDir, inside)
    if (icon) return await serveFile(icon, accepted, undefined, isolationHeaders)
    // Workbox precaches `/index.html` with a normal same-origin fetch, not a
    // navigation request. Keep the shell on the single annotated path below,
    // but admit that exact existing file regardless of Sec-Fetch-Mode; otherwise
    // its 404 aborts the entire service-worker installation.
    if (filePath === indexPath) {
      return await serveFile(
        indexPath,
        accepted,
        Buffer.from(serveIndex(webDir, indexPath, opts.stampCheck === true), 'utf8'),
        isolationHeaders,
      )
    }
    // A missing FILE is a 404, not the web page. Only navigations fall through
    // to the shell [POD-421].
    if (!isNavigationRequest(pathname, c)) return c.notFound()
    // index.html goes out through ONE path — the fallback — even when it was
    // asked for by name. The service worker precaches `/index.html` explicitly,
    // so a second, un-annotated route for the same file is how the stale-build
    // warning (POD-1610) would be missing from precisely the installed PWA that
    // most needs it.
    return await serveFile(
      indexPath,
      accepted,
      Buffer.from(serveIndex(webDir, indexPath, opts.stampCheck === true), 'utf8'),
      isolationHeaders,
    )
  }

  if (basePath !== '/') app.get(basePath, handler)
  app.get(routePattern(basePath), handler)
  return true
}
