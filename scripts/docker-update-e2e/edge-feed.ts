import { basename, join } from 'node:path'

const root = process.env.PODIUM_EDGE_FEED_ROOT
const cert = process.env.PODIUM_EDGE_FEED_CERT
const key = process.env.PODIUM_EDGE_FEED_KEY
if (!root || !cert || !key) {
  throw new Error('PODIUM_EDGE_FEED_ROOT, CERT, and KEY are required')
}

/**
 * WHICH RELEASE PATHS THIS RUN-LOCAL ORIGIN ANSWERS ON.
 *
 * Defaults to the rolling edge directory, which is the only one the packaged
 * server lane ever asks for. The real-release row adds the STABLE pair — a
 * released install on `stable` fetches `releases/latest/download/`, and its
 * manifest names artifacts under `releases/download/<tag>/`. Serving those is
 * the difference between testing the URL a stable user's install really uses
 * and testing a nearby one, so the prefixes are configuration rather than a
 * constant.
 *
 * Every prefix is still an exact directory: the request path must start with one
 * of them and the remainder must be a bare filename.
 */
const prefixes = (
  process.env.PODIUM_EDGE_FEED_PREFIXES ?? '/madeinorbit/podium/releases/download/edge/'
)
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0)
if (prefixes.length === 0) throw new Error('PODIUM_EDGE_FEED_PREFIXES named no prefix')

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: 443,
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok\n')
    const prefix = prefixes.find((value) => url.pathname.startsWith(value))
    if (!prefix) return new Response('not found\n', { status: 404 })
    const name = decodeURIComponent(url.pathname.slice(prefix.length))
    if (!name || basename(name) !== name) return new Response('not found\n', { status: 404 })
    const file = Bun.file(join(root, name))
    if (!(await file.exists())) return new Response('not found\n', { status: 404 })
    const headers = {
      'cache-control': 'no-store',
      'content-length': String(file.size),
      'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    }
    if (request.method === 'HEAD') return new Response(null, { headers })
    if (request.method !== 'GET') return new Response('method not allowed\n', { status: 405 })
    return new Response(file, { headers })
  },
})

console.log(`edge feed listening on https://${server.hostname}:${server.port}`)
console.log(`serving ${prefixes.join(' ')} from ${root}`)
