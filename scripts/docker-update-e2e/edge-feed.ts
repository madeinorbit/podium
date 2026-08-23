import { basename, join } from 'node:path'

const root = process.env.PODIUM_EDGE_FEED_ROOT
const cert = process.env.PODIUM_EDGE_FEED_CERT
const key = process.env.PODIUM_EDGE_FEED_KEY
if (!root || !cert || !key) {
  throw new Error('PODIUM_EDGE_FEED_ROOT, CERT, and KEY are required')
}

const prefix = '/madeinorbit/podium/releases/download/edge/'

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: 443,
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok\n')
    if (!url.pathname.startsWith(prefix)) return new Response('not found\n', { status: 404 })
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
