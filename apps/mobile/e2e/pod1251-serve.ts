/**
 * SERVE THE BRANCH'S PHONE APP AGAINST THE LIVE API (POD-1251).
 *
 * The phone app is a static export served at `/mobile` by the live instance, so
 * there is no dev server that renders THIS branch against real data. This is
 * that dev server: it serves the worktree's own export and proxies everything
 * else — tRPC and the feed websocket — to the live instance, from the same
 * origin, so the HttpOnly `podium_session` cookie keeps working.
 *
 *   bunx expo export -p web --output-dir dist-1251
 *   bun run apps/mobile/e2e/pod1251-serve.ts 8123 dist-1251
 */
import { existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const port = Number(process.argv[2] ?? 8123)
const root = join(import.meta.dir, '..', process.argv[3] ?? 'dist-1251')
const UPSTREAM = process.env.P1251_UPSTREAM ?? '127.0.0.1:18787'

function staticFile(pathname: string): Response | null {
  // Everything under /mobile is the export; an unknown path inside it is the
  // SPA's own route, so it falls back to index.html.
  const rel = pathname.replace(/^\/mobile\/?/, '')
  const candidate = normalize(join(root, rel))
  if (!candidate.startsWith(root)) return null
  if (rel && existsSync(candidate) && statSync(candidate).isFile()) {
    return new Response(Bun.file(candidate))
  }
  const index = join(root, 'index.html')
  return existsSync(index)
    ? new Response(Bun.file(index), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    : null
}

Bun.serve({
  port,
  idleTimeout: 120,
  fetch(req, server) {
    const url = new URL(req.url)
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const ok = server.upgrade(req, {
        data: { path: url.pathname + url.search, cookie: req.headers.get('cookie') ?? '' },
      })
      if (ok) return undefined as unknown as Response
    }
    if (url.pathname === '/mobile' || url.pathname.startsWith('/mobile/')) {
      const served = staticFile(url.pathname)
      if (served) return served
    }
    const target = `http://${UPSTREAM}${url.pathname}${url.search}`
    return fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual',
      // @ts-expect-error bun accepts a duplex hint for streamed bodies
      duplex: 'half',
    }).then((upstream) => {
      // fetch has already decoded the body, so passing the upstream's
      // content-encoding through makes the browser try to decode it twice
      // (ERR_CONTENT_DECODING_FAILED) — and the old length no longer applies.
      const headers = new Headers(upstream.headers)
      headers.delete('content-encoding')
      headers.delete('content-length')
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      })
    })
  },
  websocket: {
    open(ws) {
      const { path, cookie } = ws.data as { path: string; cookie: string }
      const queued: (string | Uint8Array)[] = []
      const upstream = new WebSocket(`ws://${UPSTREAM}${path}`, {
        headers: { cookie },
      } as unknown as string[])
      upstream.binaryType = 'arraybuffer'
      upstream.onopen = () => {
        for (const m of queued) upstream.send(m)
        queued.length = 0
      }
      upstream.onmessage = (event) => {
        ws.send(
          typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer),
        )
      }
      upstream.onclose = () => ws.close()
      upstream.onerror = () => ws.close()
      ;(ws.data as { up?: WebSocket; queued?: unknown[] }).up = upstream
      ;(ws.data as { queued?: unknown[] }).queued = queued
    },
    message(ws, message) {
      const { up, queued } = ws.data as { up: WebSocket; queued: (string | Uint8Array)[] }
      const payload = typeof message === 'string' ? message : new Uint8Array(message)
      if (up.readyState === WebSocket.OPEN) up.send(payload)
      else queued.push(payload)
    },
    close(ws) {
      const { up } = ws.data as { up?: WebSocket }
      up?.close()
    },
  },
})

console.log(`serving ${root} at http://127.0.0.1:${port}/mobile/ (api -> ${UPSTREAM})`)
