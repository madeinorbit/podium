// Usage: ANTHROPIC_API_BASE=https://api.anthropic.com FAIL_FIRST=3 node scripts/fault-proxy.mjs 8788
import http from 'node:http'
import https from 'node:https'

const port = Number(process.argv[2] ?? 8788)
const upstream = process.env.ANTHROPIC_API_BASE ?? 'https://api.anthropic.com'
let failsLeft = Number(process.env.FAIL_FIRST ?? 3)

http
  .createServer((req, res) => {
    if (failsLeft > 0) {
      failsLeft--
      console.log(`[fault-proxy] injecting 500 (${failsLeft} left) for ${req.url}`)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'injected' } }))
      return
    }
    const target = new URL(req.url, upstream)
    const proxyReq = https.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    proxyReq.on('error', () => {
      res.writeHead(502).end()
    })
    req.pipe(proxyReq)
  })
  .listen(port, () => console.log(`[fault-proxy] :${port} → ${upstream}, failing first ${failsLeft}`))
