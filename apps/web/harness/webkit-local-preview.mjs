/** Bun-only local Mac preview: production assets + prevalidated synthetic NDJSON.
 * Small API requests and live socket frames go to the isolated Linux fixture.
 * No connection to the operator backend is made by this process.
 */
const root = process.env.WEBKIT_PREVIEW_ROOT
if (!root) throw Error('Set WEBKIT_PREVIEW_ROOT to the owned runner directory')
const upstream = 'http://127.0.0.1:19688'
const manifest = await Bun.file(`${root}/manifest.json`).json()
const offline = process.env.WEBKIT_OFFLINE === '1'
const api = offline ? await Bun.file(`${root}/fixture-api.json`).json() : {}
const transcript = offline ? await Bun.file(`${root}/transcript.json`).json() : []
const frames = offline ? await Bun.file(`${root}/socket-frames.json`).json() : []
const workingSince = new Date((manifest.fixedNow ?? 1789905600000) - 15000).toISOString()
const busy = value => ({...value, status: 'live', transcriptAvailable: true,
    agentState: {phase: 'working', since: workingSince, nativeSubagentCount: 0}})
const procedures = new Map()
for (const [path, entry] of Object.entries(api)) {
    if (!path.startsWith('/trpc/')) continue
    const url = new URL(path, 'http://fixture')
    const names = url.pathname.slice(6).split(',')
    const values = JSON.parse(entry.body)
    for (const [index, name] of names.entries()) procedures.set(name, Array.isArray(values) ? values[index] : values)
}
function readTranscript(input = {}) {
    const limit = input.limit ?? 200
    let index = input.anchor ? transcript.findIndex(item => item.cursor === input.anchor) : transcript.length
    if (index < 0) index = transcript.length
    const items = input.direction === 'after' && input.anchor ? transcript.slice(index + 1, index + 1 + limit) : transcript.slice(Math.max(0, index - limit), index)
    return {result: {data: {items, head: items[0]?.cursor, tail: items.at(-1)?.cursor, hasMore: index > limit}}}
}
const server = Bun.serve({hostname: '127.0.0.1', port: 19678, async fetch(request, server) {
    const url = new URL(request.url)
    if (request.headers.get('upgrade') === 'websocket') {
        if (server.upgrade(request, {data: {path: url.pathname + url.search, queue: []}})) return
    }
    if (url.pathname === '/__fixture') {
        const scaleFile = Bun.file(`${root}/scale.txt`)
        const scale = await scaleFile.exists() ? Number((await scaleFile.text()).trim()) : 1
        return Response.json({...manifest, scale, issues: 4867 * scale, sessions: 4304 * scale, busyControl: true})
    }
    if (url.pathname === '/sync/bootstrap') {
        const scaleFile = Bun.file(`${root}/scale.txt`)
        const scale = await scaleFile.exists() ? (await scaleFile.text()).trim() : '1'
        if (!['1','4'].includes(scale)) throw Error('Invalid corpus scale')
        const path = scale === '1' ? `${root}/bootstrap.ndjson` : `${root}/bootstrap-4x.ndjson`
        const lines = (await Bun.file(path).text()).trim().split('\n').map(line => {
            const record = JSON.parse(line)
            if (record.type === 'feedBootstrap') record.changes = record.changes.map(row =>
                row.entity === 'session' && row.entityId === manifest.control ? {...row, value: busy(row.value)} : row)
            return JSON.stringify(record)
        })
        return new Response(lines.join('\n') + '\n', {headers: {'content-type': 'application/x-ndjson'}})
    }
    if (url.pathname === '/sw.js') return new Response('', {status: 404})
    if (offline && url.pathname.startsWith('/trpc/')) {
        const names = url.pathname.slice(6).split(',')
        const batch = url.searchParams.get('batch') === '1'
        const input = url.searchParams.has('input') ? JSON.parse(url.searchParams.get('input')) : request.method === 'POST' ? await request.json() : {}
        const results = names.map((name, index) => {
            if (name === 'sessions.transcriptRead') return readTranscript(batch ? input[index] : input)
            if (request.method === 'POST') return {result: {data: null}}
            return procedures.get(name) ?? {error: {message: `Missing synthetic RPC: ${name}`, code: -32601, data: {code: 'NOT_FOUND', httpStatus: 404}}}
        })
        return Response.json(batch ? results : results[0])
    }
    if (offline && api[url.pathname + url.search]) {
        const entry = api[url.pathname + url.search]
        return new Response(entry.body, {status: entry.status, headers: {'content-type': entry.type}})
    }
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
        if (offline) return
        const socket = new WebSocket(`ws://127.0.0.1:19688${client.data.path}`)
        client.data.socket = socket
        socket.onopen = () => {for (const message of client.data.queue) socket.send(message); client.data.queue = []}
        socket.onmessage = event => client.send(event.data)
        socket.onclose = () => client.close()
    },
    message(client, message) {
        if (offline) {
            const frame = JSON.parse(String(message))
            if (frame.type === 'ping') client.send(JSON.stringify({type: 'pong'}))
            if (frame.type === 'hello') for (const saved of frames) if (saved.type !== 'hostMetricsChanged') client.send(JSON.stringify(saved))
            if (frame.type === 'transcriptSubscribe' && frame.sessionId === manifest.control) {
                clearInterval(client.data.timer)
                client.data.tick = 0
                client.data.timer = setInterval(() => {
                    const tick = ++client.data.tick
                    const id = `synthetic-stream-${tick}`
                    const item = {id, cursor: id, role: 'assistant', text: `Generated tool batch ${tick}: inspecting the next synthetic change.`, ts: new Date((manifest.fixedNow ?? 1789905600000) + tick * 1000).toISOString()}
                    client.send(JSON.stringify({type: 'transcriptDelta', sessionId: manifest.control, items: [item], tail: id}))
                }, 1000)
            }
            if (frame.type === 'transcriptUnsubscribe') clearInterval(client.data.timer)
            return
        }
        if (client.data.socket.readyState === WebSocket.OPEN) client.data.socket.send(message); else client.data.queue.push(message)
    },
    close(client) {clearInterval(client.data.timer); client.data.socket?.close()},
}})
await Bun.write(`${root}/preview.pid`, String(process.pid))
console.log(`Mac synthetic preview ready: ${server.url} (${manifest.issues} issues)`)
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {server.stop(true); process.exit(0)})
await new Promise(() => {})
