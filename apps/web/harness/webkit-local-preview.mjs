/** Bun-only local Mac preview: production assets + prevalidated synthetic NDJSON.
 * Small API requests and live socket frames go to the isolated Linux fixture.
 * No connection to the operator backend is made by this process.
 */
const root = process.env.WEBKIT_PREVIEW_ROOT
if (!root) throw Error('Set WEBKIT_PREVIEW_ROOT to the owned runner directory')
const upstream = 'http://127.0.0.1:19668'
const manifest = await Bun.file(`${root}/manifest.json`).json()
const server = Bun.serve({hostname: '127.0.0.1', port: 19678, async fetch(request, server) {
    const url = new URL(request.url)
    if (request.headers.get('upgrade') === 'websocket') {
        if (server.upgrade(request, {data: {path: url.pathname + url.search, queue: []}})) return
    }
    if (url.pathname === '/__fixture') return Response.json(manifest)
    if (url.pathname === '/sync/bootstrap') return new Response(Bun.file(`${root}/bootstrap.ndjson`), {headers: {'content-type': 'application/x-ndjson'}})
    if (url.pathname === '/sw.js') return new Response('', {status: 404})
    if (/^\/(trpc|auth|setup|sync|version|health|files|client|podium-build\.json)/.test(url.pathname)) {
        const response = await fetch(new URL(url.pathname + url.search, upstream), {method: request.method, headers: request.headers, body: ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()})
        const headers = new Headers(response.headers)
        for (const key of ['content-encoding','content-length','transfer-encoding']) headers.delete(key)
        return new Response(response.body, {status: response.status, headers})
    }
    const dist = (await Bun.file(`${root}/arm.txt`).text()).trim()
    if (!/^[a-z0-9-]+$/.test(dist)) throw Error('Invalid build arm')
    const file = Bun.file(`${root}/dist-${dist}${url.pathname}`)
    if (url.pathname !== '/' && !url.pathname.includes('..') && await file.exists()) return new Response(file, {headers: {'cache-control': 'no-store'}})
    const html = (await Bun.file(`${root}/dist-${dist}/index.html`).text()).replace('<head>', `<head><script>localStorage.setItem('podium.panelMode','chat');localStorage.setItem('podium.panelModeDefault','chat');window.__fixtureErrors=[];addEventListener('error',e=>window.__fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__fixtureErrors.push(String(e.reason)));const started=performance.now();Date.now=()=>${manifest.fixedNow ?? 1789905600000}+Math.floor(performance.now()-started);</script>`)
    return new Response(html, {headers: {'content-type':'text/html','cache-control':'no-store'}})
}, websocket: {
    open(client) {
        const socket = new WebSocket(`ws://127.0.0.1:19668${client.data.path}`)
        client.data.socket = socket
        socket.onopen = () => {for (const message of client.data.queue) socket.send(message); client.data.queue = []}
        socket.onmessage = event => client.send(event.data)
        socket.onclose = () => client.close()
    },
    message(client, message) {if (client.data.socket.readyState === WebSocket.OPEN) client.data.socket.send(message); else client.data.queue.push(message)},
    close(client) {client.data.socket.close()},
}})
await Bun.write(`${root}/preview.pid`, String(process.pid))
console.log(`Mac synthetic preview ready: ${server.url} (${manifest.issues} issues)`)
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {server.stop(true); process.exit(0)})
await new Promise(() => {})
