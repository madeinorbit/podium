/** External Node client: CPU accounting never includes this process. */
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { hostname, loadavg } from 'node:os'
import { createGunzip, createZstdDecompress, zstdDecompressSync } from 'node:zlib'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const [readyPath, outPath, mode = 'bootstrap', coding = 'identity', slowSecondsArg = '30'] = process.argv.slice(2)
const ready = JSON.parse(readFileSync(readyPath, 'utf8'))
const { port, pid, arm, manifest, root } = ready
const require = createRequire(resolve(root, 'apps/server/package.json'))
const WebSocket = require('ws')
const slowSeconds = Number(slowSecondsArg)
const tickHz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
const origin = `http://127.0.0.1:${port}`
const walBytes = () => { try { return statSync(`${ready.dbPath}-wal`).size } catch { return null } }
const conditions = () => ({ at: new Date().toISOString(), hostname: hostname(), loadAverage: loadavg(),
  processes: execFileSync('ps', ['-eo', 'pid,ppid,comm,pcpu,pmem', '--sort=-pcpu'], { encoding: 'utf8' }).split('\n').slice(0, 25),
  freeDisk: execFileSync('df', ['-h', root], { encoding: 'utf8' }).trim() })
function snapshot() {
  const threads = {}
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const raw = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8')
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/)
      threads[tid] = { ticks: Number(fields[11]) + Number(fields[12]), name: raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')) }
    } catch {} // Thread exited between enumeration and read.
  }
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  return { atMs: performance.now(), threads,
    walBytes: walBytes(),
    rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
    highWaterRssBytes: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024 }
}
function request(path, options = {}) {
  return new Promise((yes, no) => { const req = http.request(`${origin}${path}`, options, yes); req.on('error', no); req.end() })
}
async function json(path, options) {
  const res = await request(path, options)
  let body = ''
  for await (const chunk of res) body += chunk
  if (res.statusCode !== 200) throw new Error(`${path}: ${res.statusCode}: ${body}`)
  return JSON.parse(body)
}
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*p)-1)] ?? null
async function bootstrap(index) {
  const start = performance.now()
  let firstRecordMs = null, bytesWireBody = 0, bytesDecoded = 0, rows = 0, records = 0, complete = false
  const record = value => {
    if (firstRecordMs === null) firstRecordMs = performance.now()-start
    if (value.type === 'feedBootstrap') { rows += value.changes.length; records++; if (value.last) complete = true }
    if (value.type === 'syncComplete') complete = true
    if (value.type === 'syncError') throw new Error(JSON.stringify(value))
  }
  try {
  if (arm === 'before') {
    await new Promise((yes,no) => {
      const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/bootstrap-ws?coding=${coding}`)
      const timeout = setTimeout(() => { ws.terminate(); no(new Error('bootstrap timeout')) }, 30000)
      ws.on('error', no)
      ws.on('message', (data,binary) => {
        try {
          bytesWireBody += data.length
          const decoded = binary ? zstdDecompressSync(data.subarray(4 + data.readUInt32BE(0))) : data
          bytesDecoded += decoded.length
          record(JSON.parse(decoded.toString()))
          if (complete) { clearTimeout(timeout); ws.close(); yes() }
        } catch (error) { clearTimeout(timeout); ws.terminate(); no(error) }
      })
      ws.on('close', () => { if (!complete) { clearTimeout(timeout); no(new Error('bootstrap closed before last record')) } })
    })
  } else {
    const response = await request(`/sync/bootstrap?client=${index}`, { headers: { 'accept-encoding': coding } })
    if (response.statusCode !== 200) { response.resume(); return { status: response.statusCode } }
    response.on('data', bytes => { bytesWireBody += bytes.length })
    const decoded = coding === 'gzip' ? response.pipe(createGunzip()) : coding === 'zstd' ? response.pipe(createZstdDecompress()) : response
    let pending = ''
    for await (const bytes of decoded) {
      bytesDecoded += bytes.length
      pending += bytes.toString('utf8')
      let end
      while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0,end); pending = pending.slice(end+1); if (line) record(JSON.parse(line)) }
    }
    if (pending || !complete) throw new Error('incomplete NDJSON bootstrap')
  }
  } catch (error) { return { status: 'failed', error: String(error), firstRecordMs, completionMs: null, observedMs: performance.now()-start, bytesWireBody, bytesDecoded, rows, records } }
  if (rows !== manifest.rows) throw new Error(`Expected ${manifest.rows} world rows, got ${rows}`)
  return { status: 200, firstRecordMs, completionMs: performance.now()-start, bytesWireBody, bytesDecoded, rows, records }
}
async function slowReader() {
  // net.Socket stays in paused mode: no data handler, fetch, HTTP parser, or WS
  // parser drains it into an unbounded native response body. read() takes at most
  // 64 KiB each 500 ms. Kernel receive buffers are additional bounded slack.
  const socket = net.createConnection({ host: '127.0.0.1', port, readableHighWaterMark: 65536 })
  socket.on('error', () => {})
  await new Promise((yes,no) => { socket.once('connect',yes); socket.once('error',no) })
  const path = arm === 'before' ? '/bootstrap-ws?coding=identity' : '/sync/bootstrap?client=slow'
  const upgrade = arm === 'before' ? 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' : 'Accept-Encoding: identity\r\nConnection: close\r\n'
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${upgrade}\r\n`)
  let readBytes = 0, maxBufferedBytes = 0
  const walBeforeBytes = walBytes()
  let walPeakBytes = walBeforeBytes, writes = 0
  const end = performance.now() + slowSeconds*1000
  while (performance.now() < end) {
    await delay(500)
    await json('/write', { method: 'POST' }); writes++
    const wal = walBytes(); if (wal !== null) walPeakBytes = Math.max(walPeakBytes ?? 0, wal)
    maxBufferedBytes = Math.max(maxBufferedBytes, socket.readableLength)
    if (socket.readableLength > 128 * 1024) throw new Error('slow socket exceeded bounded read buffer')
    const chunk = socket.read(Math.min(65536, socket.readableLength))
    if (chunk) readBytes += chunk.length
  }
  socket.destroy()
  return { walBeforeBytes, walPeakBytes, walGrowthBytes: walPeakBytes === null || walBeforeBytes === null ? null : walPeakBytes-walBeforeBytes, writes, durationSeconds: slowSeconds, readBytesIncludingHeaders: readBytes, maxNodeSocketBufferedBytes: maxBufferedBytes,
    bytesPerReadLimit: 65536, intervalMs: 500, outcome: 'cancelled at observation deadline' }
}
async function delta() {
  const start = performance.now(), initialRss = process.memoryUsage().rss
  let peakRss = initialRss, firstPageMs = null, previous = manifest.from, rows = 0, pages = 0
  const replica = new Map()
  const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }
  const timer = setInterval(sample, 5)
  function apply(frame) {
    if (frame.fromSeq !== previous) throw new Error('non-contiguous delta page')
    for (const change of frame.changes) replica.set(`${change.entity}:${change.entityId}`, change)
    previous = frame.seq; rows += frame.changes.length; pages++; sample()
  }
  try {
    if (arm === 'before') {
      const envelope = await json('/trpc/feedChangesSince')
      const frame = envelope.result.data
      firstPageMs = performance.now()-start
      if (frame.kind !== 'delta') throw new Error(JSON.stringify(frame))
      apply(frame)
    } else {
      const response = await request(`/sync/delta?feedId=measurement-feed&epoch=measurement-epoch&from=${manifest.from}&to=${manifest.through}`, { headers: { 'accept-encoding': 'identity' } })
      if (response.statusCode !== 200) throw new Error(`delta status ${response.statusCode}`)
      let pending = '', complete = false
      for await (const bytes of response) {
        pending += bytes.toString('utf8')
        let end
        while ((end=pending.indexOf('\n'))>=0) {
          const line=pending.slice(0,end); pending=pending.slice(end+1)
          if (!line) continue
          const frame=JSON.parse(line)
          if (frame.type==='feedDelta') { if (firstPageMs===null) firstPageMs=performance.now()-start; apply(frame) }
          if (frame.type==='syncComplete') complete=true
          if (frame.type==='syncError') throw new Error(JSON.stringify(frame))
        }
        sample()
      }
      if (pending || !complete) throw new Error('incomplete delta')
    }
    if (previous!==manifest.through || rows!==manifest.deltaRows) throw new Error(`delta control ${previous}/${rows}`)
    return { firstPageMs, completionMs: performance.now()-start, rows, pages, initialClientRssBytes: initialRss, peakClientRssBytes: peakRss,
      retainedReplicaKeys: replica.size, replicaScope: 'Node Map sink with certified range checks; excludes production kernel and persistence' }
  } finally { clearInterval(timer) }
}
async function observedBootstrap(index) {
  try { return await bootstrap(index) } catch(error) { return { status: 'failed', error: String(error) } }
}
const beforeConditions = conditions(), before = snapshot(), timeline = [before]
let running = true
const timer = setInterval(() => timeline.push(snapshot()), 20)
const health = [], ping = []
const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ping`)
await new Promise((yes,no) => { ws.once('open',yes); ws.once('error',no) })
const probeHealth = async () => { while (running) { const t=performance.now(); await json('/health'); health.push(performance.now()-t); await delay(10) } }
const probePing = async () => { while (running) { const t=performance.now(); await new Promise((yes,no) => { const timeout=setTimeout(() => no(new Error('ping timeout')),10000); ws.once('pong',()=>{clearTimeout(timeout);yes()}); ws.ping() }); ping.push(performance.now()-t); await delay(10) } }
const probes = Promise.all([probeHealth(),probePing()])
let result
try {
  result = mode === 'delta' ? await delta() : mode === 'concurrent'
    ? await Promise.all([slowReader(), ...Array.from({length:4},(_,i)=>observedBootstrap(i))]) : await observedBootstrap(0)
} finally { running=false; await probes; clearInterval(timer); ws.terminate() }
const after = snapshot(); timeline.push(after)
const wallMs = after.atMs-before.atMs
const threadCpu = Object.fromEntries(Object.entries(after.threads).map(([tid, entry]) => [tid, { name: entry.name,
  cpuMs: (entry.ticks - (before.threads[tid]?.ticks ?? 0))/tickHz*1000 }]))
const report = { arm, mode, coding, sourceCommit: process.env.MEASUREMENT_SHA ?? 'SMOKE-NOT-A-MEASUREMENT', node: process.version,
  conditionsBefore: beforeConditions, conditionsAfter: conditions(), manifest, result, wallMs,
  mainThreadCpuMs: threadCpu[pid]?.cpuMs, mainThreadBusyPercent: threadCpu[pid]?.cpuMs/wallMs*100,
  threadCpu, peakSampledServerRssBytes: Math.max(...timeline.map(x=>x.rssBytes)),
  serverRssBeforeBytes: before.rssBytes, serverHighWaterRssBytes: after.highWaterRssBytes,
  health: { samples:health.length,p50Ms:percentile(health,.5),p95Ms:percentile(health,.95) },
  websocketPing: { samples:ping.length,p50Ms:percentile(ping,.5),p95Ms:percentile(ping,.95) },
  serverMetrics: await json('/metrics'), timeline }
writeFileSync(outPath, `${JSON.stringify(report,null,2)}\n`)
console.log(JSON.stringify({arm,mode,coding,wallMs,mainThreadBusyPercent:report.mainThreadBusyPercent,healthP95Ms:report.health.p95Ms,result}))
