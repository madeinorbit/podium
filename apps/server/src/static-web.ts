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
 * Inject the maintainer issue token into the served SPA shell so the web tRPC client
 * can present it as `x-podium-issue-token` (see resolveRole). Inserts a script before
 * `</head>` (or prepends if there is no head). No-op when no token is configured.
 */
function injectIssueToken(html: string, token?: string): string {
  if (!token) return html
  const tag = `<script>window.__PODIUM_ISSUE_TOKEN__=${JSON.stringify(token)}</script>`
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html
}

/**
 * Serve the built web bundle for EXTERNAL clients (browser / phone / other desktop
 * app connecting to a running machine). The Tauri desktop window uses its own bundled
 * UI, not this route. Returns false (registers nothing) when no build is present, so a
 * source/dev run or an API-only server is unaffected. Call AFTER the API routes.
 */
export function registerWebStatic(app: Hono, webDir: string, issueToken?: string): boolean {
  if (!existsSync(join(webDir, 'index.html'))) return false

  app.get('/*', (c) => {
    const pathname = new URL(c.req.url).pathname
    if (BACKEND_PREFIXES.some((pre) => pathname === pre || pathname.startsWith(`${pre}/`))) {
      return c.notFound()
    }
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(webDir, rel)
    if ((filePath === webDir || filePath.startsWith(webDir + sep)) && existsSync(filePath) && statSync(filePath).isFile()) {
      // The SPA shell can be requested directly (e.g. /index.html); inject the token there too.
      if (extname(filePath).toLowerCase() === '.html') {
        return new Response(injectIssueToken(readFileSync(filePath, 'utf8'), issueToken), {
          status: 200,
          headers: { 'Content-Type': contentType(filePath) },
        })
      }
      return new Response(readFileSync(filePath), {
        status: 200,
        headers: { 'Content-Type': contentType(filePath) },
      })
    }
    return new Response(
      injectIssueToken(readFileSync(join(webDir, 'index.html'), 'utf8'), issueToken),
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    )
  })
  return true
}
