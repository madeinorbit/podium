import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import type { Hono } from 'hono'

/**
 * Backend route prefixes that must never be shadowed by the SPA index.html.
 * Intentionally a SUPERSET of apps/web/vite.config.ts navigateFallbackDenylist:
 * it also covers /version, /mcp, and /hooks (which the vite dev proxy doesn't list).
 * Do NOT trim it down to match vite — that would let the SPA shell shadow a backend
 * route. When adding a backend route, add its prefix here.
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
}

function contentType(p: string): string {
  return CONTENT_TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Serve the built web bundle for EXTERNAL clients (browser / phone / other desktop
 * app connecting to a running machine). The Tauri desktop window uses its own bundled
 * UI, not this route. Returns false (registers nothing) when no build is present, so a
 * source/dev run or an API-only server is unaffected. Call AFTER the API routes.
 */
export function registerWebStatic(app: Hono, webDir: string): boolean {
  if (!existsSync(join(webDir, 'index.html'))) return false

  app.get('/*', (c) => {
    const pathname = new URL(c.req.url).pathname
    if (BACKEND_PREFIXES.some((pre) => pathname === pre || pathname.startsWith(`${pre}/`))) {
      return c.notFound()
    }
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(webDir, rel)
    if (
      (filePath === webDir || filePath.startsWith(webDir + sep)) &&
      existsSync(filePath) &&
      statSync(filePath).isFile()
    ) {
      return new Response(readFileSync(filePath), {
        status: 200,
        headers: { 'Content-Type': contentType(filePath) },
      })
    }
    // A MISSING path with a file extension is a stale/renamed static asset (e.g. a
    // content-hashed JS/CSS from a superseded build), NOT an SPA navigation. Return
    // 404: handing back index.html (HTML) where the browser expects a JS module
    // yields "Expected a module script but the server responded with MIME type
    // text/html", which breaks the post-redeploy load and poisons the PWA precache.
    if (extname(rel) !== '') return c.notFound()
    // Extensionless path → SPA navigation route; serve the app shell.
    return new Response(readFileSync(join(webDir, 'index.html'), 'utf8'), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  })
  return true
}
