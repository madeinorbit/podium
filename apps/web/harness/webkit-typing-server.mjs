/** Synthetic-only production preview for Safari (no live backend or data). */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import * as model from '@podium/model'
import { FeedChange } from '@podium/protocol'
import { readSyncStream } from '@podium/client-core/sync-stream'

const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const scale = Number(arg('scale', '1'))
if (![1, 4].includes(scale)) throw Error('Scale must be 1 or 4')
const root = resolve(arg('corpus', '.artifacts/POD-5508/corpus'))
const out = resolve(arg('out', `.artifacts/POD-5508/server-${scale}x`))
mkdirSync(out, { recursive: true })
const corpusBytes = readFileSync(`${root}/corpus-${scale}x.json`)
const corpus = JSON.parse(corpusBytes)
let synthetic = JSON.parse(readFileSync(`${root}/rows-${scale}x.json`, 'utf8'))
for (const row of synthetic) FeedChange.parse(row)
const backendPort = Number(arg('backend-port', '19656'))
const port = Number(arg('port', '19658'))
const backend = `http://127.0.0.1:${backendPort}`
const env = {...process.env, PORT: String(backendPort), PODIUM_NO_RELAY: '1'}
for (const key of Object.keys(env)) if (/^PODIUM_(SESSION|AGENT|CODEX_HOOK|ISSUE_RELAY|INSTANCE|HOME|STATE_DIR|AGENT_HOME|SERVER|PORT)/.test(key)) delete env[key]
const child = spawn(process.execPath, ['--conditions=@podium/source', 'tests/e2e/serve-harness.ts'], {env, stdio: ['ignore', 'pipe', 'pipe']})
writeFileSync(`${out}/pids.json`, JSON.stringify({preview: process.pid, harness: child.pid}))
const log = []
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {log.push(data); writeFileSync(`${out}/server.log`, Buffer.concat(log))})
const pause = ms => new Promise(done => setTimeout(done, ms))
const rpc = async (name, input) => {
    const response = await fetch(`${backend}/trpc/${name}`, input === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(input)})
    const body = await response.json()
    if (!response.ok || body.error) throw Error(JSON.stringify(body))
    return body.result.data
}
let server
let stopped = false
async function cleanup() {
    if (stopped) return
    stopped = true
    server?.stop(true)
    child.kill('SIGTERM')
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {await cleanup(); process.exit(0)})
process.on('exit', () => child.kill('SIGTERM'))

try {
    for (let i = 0; i < 180; i++) {
        if (child.exitCode !== null) throw Error(`Harness exited: ${Buffer.concat(log).toString().slice(-4000)}`)
        try {if ((await fetch(`${backend}/health`)).ok) break} catch {}
        if (i === 179) throw Error('Harness never became healthy')
        await pause(500)
    }
    const auth = await (await fetch(`${backend}/auth/status`)).json()
    synthetic = synthetic.map(row => {
        const value = {...row.value}
        if (['issueUserState', 'sessionUserState'].includes(row.entity)) value.userId = auth.memberId
        return {...row, value, entityId: row.entity === 'issueUserState' ? model.issueUserStateRowId(auth.memberId, value.entityId) : row.entity === 'sessionUserState' ? model.sessionUserStateRowId(auth.memberId, value.sessionId) : row.entityId}
    })
    let repos = []
    for (let i = 0; i < 120 && !repos.length; i++) {repos = await rpc('repos.list'); if (!repos.length) await pause(250)}
    if (!repos.length) throw Error('Isolated harness repository registration never became ready')
    const repoPath = repos.find(path => path.includes('zz-podium-e2e-repo-')) ?? repos[0]
    for (let i = 0; i < 120; i++) {
        const machines = await rpc('machines.list')
        if (machines.some(machine => machine.inventory?.agents?.some(agent => agent.kind === 'claude-code' && agent.installed))) break
        await pause(250)
    }
    const issue = await rpc('issues.create', {repoPath, title: 'Synthetic WebKit busy chat', description: 'Generated chat workload for Safari profiling.', parentBranch: 'main', startNow: true})
    await rpc('issues.update', {id: issue.id, patch: {stage: 'in_progress'}})
    const session = await rpc('sessions.create', {cwd: repoPath, issueId: issue.id, agentKind: 'claude-code', title: 'Synthetic long tool transcript'})
    const items = []
    const item = (role, text, extra = {}) => {
        const id = `synthetic-${items.length}`
        items.push(model.TranscriptItem.parse({id, cursor: id, role, text, ts: new Date(corpus.fixedNow + items.length * 1000).toISOString(), ...extra}))
    }
    for (let i = 0; i < 400; i++) {
        item('user', `Review the generated change ${i}, including its implementation and validation.`)
        item('assistant', `I am checking change **${i}**.\n\nThe generated workload includes a long transcript, tool batches, code blocks and file links.\n\n\`\`\`ts\nconst revision = ${i}\nconst result = {revision, verified: true}\n\`\`\``)
        for (let tool = 0; tool < 4; tool++) {
            const toolUseId = `tool-${i}-${tool}`
            item('assistant', '', {toolUseId, toolName: 'Bash', toolTitle: `Inspect generated file ${i}/${tool}`, toolInput: `rg -n revision /synthetic/project/file-${i}.ts`})
            item('tool', '', {toolUseId, toolName: 'Bash', toolResult: `revision: ${i}\nGenerated output line\n`.repeat(8)})
        }
        item('assistant', `Change ${i} is checked. The generated result preserves the intended behavior.`, {answer: true})
    }
    const busy = value => ({...value, status: 'live', transcriptAvailable: true,
        agentState: {phase: 'working', since: new Date(corpus.fixedNow - 15000).toISOString(), nativeSubagentCount: 0}})
    const decorate = row => row.entity === 'session' && row.entityId === session.sessionId ? {...row, value: busy(row.value)} : row
    let identity, seq
    async function bootstrap(response) {
        if (!response.ok) return response
        const records = (await response.text()).trim().split('\n').map(JSON.parse)
        const first = records[0], complete = records.at(-1)
        const original = records.filter(record => record.type === 'feedBootstrap').flatMap(record => record.changes).map(decorate)
        const rows = [...original, ...synthetic]
        seq = first.seq
        identity = {feedId: first.feedId, epoch: first.epoch, minAvailableSeq: first.minAvailableSeq}
        const chunks = []
        for (let offset = 0; offset < rows.length; offset += 64) {
            chunks.push({type: 'feedBootstrap', ...identity, fromSeq: 0, seq, last: offset + 64 >= rows.length, totalRows: rows.length, changes: rows.slice(offset, offset + 64).map((row, index) => ({...row, seq: index + 1}))})
        }
        const body = [{...first, totalRows: rows.length}, ...chunks, {...complete, rows: rows.length, records: chunks.length}].map(JSON.stringify).join('\n') + '\n'
        return new Response(body, {headers: {'content-type': 'application/x-ndjson'}})
    }
    // Decode the exact augmented stream before accepting a browser capture.
    let canonical
    for (let i = 0; i < 180; i++) {
        canonical = await fetch(`${backend}/sync/bootstrap`)
        if (canonical.ok) break
        if (i === 179) throw Error(`Synthetic bootstrap stayed unready: ${canonical.status}: ${await canonical.text()}`)
        await canonical.arrayBuffer()
        await pause(250)
    }
    const validated = await bootstrap(canonical)
    let validatedRecords = 0
    async function* lines() {for (const line of (await validated.text()).trim().split('\n')) yield line}
    for await (const record of readSyncStream(lines())) validatedRecords++
    const manifest = {sourceSha: arg('sha', ''), scale, semanticSha256: createHash('sha256').update(corpusBytes).digest('hex'), issues: corpus.issues.length, sessions: corpus.sessions.length, syntheticRows: synthetic.length, validatedRecords, transcriptItems: items.length, toolCalls: 1600, control: session.sessionId, issue: issue.id, url: `http://127.0.0.1:${port}/sessions/${session.sessionId}`, pids: {preview: process.pid, harness: child.pid}}
    writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2))
    const paths = []
    server = Bun.serve({port, hostname: '127.0.0.1', async fetch(request, server) {
        const url = new URL(request.url)
        paths.push(url.pathname + url.search)
        writeFileSync(`${out}/requests.json`, JSON.stringify(paths))
        if (url.pathname === '/__fixture') return Response.json(manifest)
        if (request.headers.get('upgrade') === 'websocket') {
            if (server.upgrade(request, {data: {path: url.pathname + url.search, queue: []}})) return
        }
        if (url.pathname.startsWith('/trpc/') && /transcriptRead|transcriptSubscribe|transcriptUnsubscribe/.test(url.pathname) && url.searchParams.get('batch') === '1') {
            const names = url.pathname.slice('/trpc/'.length).split(',')
            const inputs = url.searchParams.has('input') ? JSON.parse(url.searchParams.get('input')) : await request.json()
            const results = []
            for (let index = 0; index < names.length; index++) {
                const query = new URLSearchParams({input: JSON.stringify(inputs[index])})
                const single = new Request(`http://127.0.0.1:${port}/trpc/${names[index]}?${query}`, {method: request.method, headers: {'content-type':'application/json'}, body: request.method === 'POST' ? JSON.stringify(inputs[index]) : undefined})
                // Resolve through this preview's same unbatched synthetic handlers.
                const response = await fetch(single)
                results.push(await response.json())
            }
            return Response.json(results)
        }
        if (url.pathname.includes('/trpc/sessions.transcriptRead')) {
            const body = url.searchParams.has('input') ? JSON.parse(url.searchParams.get('input')) : await request.json()
            const input = body.json ?? body
            const limit = input.limit ?? 350
            let index = input.anchor ? items.findIndex(item => item.cursor === input.anchor) : items.length
            if (index < 0) index = items.length
            const page = input.direction === 'after' && input.anchor ? items.slice(index + 1, index + 1 + limit) : items.slice(Math.max(0, index - limit), index)
            return Response.json({result: {data: {items: page, head: page[0]?.cursor, tail: page.at(-1)?.cursor, hasMore: index > limit}}})
        }
        if (url.pathname.includes('/trpc/sessions.transcriptSubscribe') || url.pathname.includes('/trpc/sessions.transcriptUnsubscribe')) return Response.json({result: {data: {ok: true}}})
        const target = new URL(url.pathname + url.search, backend)
        const response = await fetch(target, {method: request.method, headers: request.headers, body: ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()})
        if (url.pathname === '/sync/bootstrap') return bootstrap(response)
        if (url.pathname.startsWith('/trpc/discovery.refreshRepos')) {
            const body = await response.json()
            if (body.result?.data?.repositories) {
                body.result.data.repositories.push(...corpus.repos)
                body.result.data.machines.push(...corpus.machines)
            }
            return Response.json(body)
        }
        if ((response.headers.get('content-type') ?? '').includes('text/html')) {
            const body = (await response.text()).replace('<head>', '<head><script>localStorage.setItem("podium.panelMode","chat");localStorage.setItem("podium.panelModeDefault","chat");window.__fixtureErrors=[];addEventListener("error",e=>window.__fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>window.__fixtureErrors.push(String(e.reason)));</script>')
            return new Response(body, {headers: {'content-type': 'text/html'}})
        }
        // fetch has decoded precompressed assets; forwarding their encoding
        // header would ask Safari to decompress the decoded bytes again.
        const headers = new Headers(response.headers)
        for (const key of ['content-encoding', 'content-length', 'transfer-encoding']) headers.delete(key)
        return new Response(response.body, {status: response.status, headers})
    }, websocket: {
        open(client) {
            const upstream = new WebSocket(`ws://127.0.0.1:${backendPort}${client.data.path}`)
            client.data.upstream = upstream
            upstream.onopen = () => {for (const message of client.data.queue) upstream.send(message); client.data.queue = []}
            upstream.onmessage = event => {
                if (typeof event.data !== 'string') return client.send(event.data)
                const frame = JSON.parse(event.data)
                if (frame.changes) frame.changes = frame.changes.map(decorate)
                if (frame.sessions) frame.sessions = frame.sessions.map(value => value.sessionId === session.sessionId ? busy(value) : value)
                if (frame.type === 'machinesChanged') frame.machines.push(...corpus.machines)
                if (frame.type === 'feedDelta' && identity) {
                    const start = seq
                    seq += Math.max(1, frame.seq - frame.fromSeq)
                    frame.fromSeq = start; frame.seq = seq
                    frame.changes = frame.changes.map((row, index) => ({...row, seq: start + index + 1}))
                }
                client.send(JSON.stringify(frame))
            }
            upstream.onclose = () => client.close()
        },
        message(client, message) {if (client.data.upstream.readyState === WebSocket.OPEN) client.data.upstream.send(message); else client.data.queue.push(message)},
        close(client) {client.data.upstream.close()},
    }})
    console.log(JSON.stringify(manifest), 'SYNTHETIC_PREVIEW_READY')
    await new Promise(() => {})
} catch (error) {await cleanup(); throw error}
