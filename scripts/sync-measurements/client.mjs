/** External Node client: CPU accounting never includes this process. */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import { hostname, loadavg } from 'node:os'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createGunzip, createZstdDecompress, zstdDecompressSync } from 'node:zlib'

const [readyPath, outPath, mode = 'bootstrap', coding = 'identity', slowSecondsArg = '30'] =
  process.argv.slice(2)
const ready = JSON.parse(readFileSync(readyPath, 'utf8'))
const { port, pid, arm, manifest, root } = ready
const require = createRequire(resolve(root, 'apps/server/package.json'))
const WebSocket = require('ws')
const readIntervalMs = Number(slowSecondsArg)
const smoke = manifest.rows < 100
let Replica, InMemoryReplicaStore, toDeltaFrame, rowPayload
if (mode === 'delta') {
  ;({ Replica } = await import(
    pathToFileURL(resolve(root, 'packages/sync/src/replica/replica.ts'))
  ))
  ;({ InMemoryReplicaStore } = await import(
    pathToFileURL(resolve(root, 'packages/sync/src/replica/memory-store.ts'))
  ))
  ;({ toDeltaFrame } = await import(
    pathToFileURL(resolve(root, 'packages/client-core/src/replica/feed/frames.ts'))
  ))
  ;({ rowPayload } = await import('./corpus.mjs'))
}
const tickHz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
const origin = `http://127.0.0.1:${port}`
const walBytes = () => {
  try {
    return statSync(`${ready.dbPath}-wal`).size
  } catch {
    return null
  }
}
const conditions = () => ({
  at: new Date().toISOString(),
  hostname: hostname(),
  loadAverage: loadavg(),
  processes: execFileSync('ps', ['-eo', 'pid,ppid,comm,pcpu,pmem', '--sort=-pcpu'], {
    encoding: 'utf8',
  })
    .split('\n')
    .slice(0, 25),
  freeDisk: execFileSync('df', ['-h', root], { encoding: 'utf8' }).trim(),
})
function snapshot() {
  const threads = {}
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const raw = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8')
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/)
      threads[tid] = {
        ticks: Number(fields[11]) + Number(fields[12]),
        name: raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')),
      }
    } catch {} // Thread exited between enumeration and read.
  }
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  return {
    atMs: performance.now(),
    threads,
    walBytes: walBytes(),
    rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
    highWaterRssBytes: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024,
  }
}
function request(path, options = {}) {
  return new Promise((yes, no) => {
    const req = http.request(`${origin}${path}`, options, yes)
    req.on('error', no)
    req.end()
  })
}
async function json(path, options) {
  const res = await request(path, options)
  let body = ''
  for await (const chunk of res) body += chunk
  if (res.statusCode !== 200) throw new Error(`${path}: ${res.statusCode}: ${body}`)
  return JSON.parse(body)
}
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null
async function bootstrap(index) {
  const start = performance.now()
  let firstRecordMs = null,
    bytesWireBody = 0,
    bytesDecoded = 0,
    rows = 0,
    records = 0,
    complete = false
  const record = (value) => {
    if (firstRecordMs === null) firstRecordMs = performance.now() - start
    if (value.type === 'feedBootstrap') {
      rows += value.changes.length
      records++
      if (value.last) complete = true
    }
    if (value.type === 'syncComplete') complete = true
    if (value.type === 'syncError') throw new Error(JSON.stringify(value))
  }
  try {
    if (arm === 'before') {
      await new Promise((yes, no) => {
        const ws = new WebSocket(
          `${origin.replace('http:', 'ws:')}/bootstrap-ws?coding=${coding}&client=${index}`,
        )
        const timeout = setTimeout(() => {
          ws.terminate()
          no(new Error('bootstrap timeout'))
        }, 30000)
        ws.on('error', no)
        ws.on('message', (data, binary) => {
          try {
            bytesWireBody += data.length
            const decoded = binary
              ? zstdDecompressSync(data.subarray(4 + data.readUInt32BE(0)))
              : data
            bytesDecoded += decoded.length
            record(JSON.parse(decoded.toString()))
            if (complete) {
              clearTimeout(timeout)
              ws.close()
              yes()
            }
          } catch (error) {
            clearTimeout(timeout)
            ws.terminate()
            no(error)
          }
        })
        ws.on('close', () => {
          if (!complete) {
            clearTimeout(timeout)
            no(new Error('bootstrap closed before last record'))
          }
        })
      })
    } else {
      const response = await request(`/sync/bootstrap?client=${index}`, {
        headers: { 'accept-encoding': coding },
      })
      if (response.statusCode !== 200) {
        response.resume()
        return { status: response.statusCode }
      }
      response.on('data', (bytes) => {
        bytesWireBody += bytes.length
      })
      const decoded =
        coding === 'gzip'
          ? response.pipe(createGunzip())
          : coding === 'zstd'
            ? response.pipe(createZstdDecompress())
            : response
      let pending = ''
      for await (const bytes of decoded) {
        bytesDecoded += bytes.length
        pending += bytes.toString('utf8')
        for (;;) {
          const end = pending.indexOf('\n')
          if (end < 0) break
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          if (line) record(JSON.parse(line))
        }
      }
      if (pending || !complete) throw new Error('incomplete NDJSON bootstrap')
    }
  } catch (error) {
    return {
      status: 'failed',
      error: String(error),
      firstRecordMs,
      completionMs: null,
      observedMs: performance.now() - start,
      bytesWireBody,
      bytesDecoded,
      rows,
      records,
    }
  }
  if (rows !== manifest.rows) throw new Error(`Expected ${manifest.rows} world rows, got ${rows}`)
  return {
    status: 200,
    firstRecordMs,
    completionMs: performance.now() - start,
    bytesWireBody,
    bytesDecoded,
    achievedRatio: bytesDecoded / bytesWireBody,
    rows,
    records,
  }
}
async function slowReader() {
  const socket = net.createConnection({ host: '127.0.0.1', port, readableHighWaterMark: 65536 })
  let socketError
  socket.on('error', (error) => {
    socketError = error
  })
  await new Promise((yes, no) => {
    socket.once('connect', yes)
    socket.once('error', no)
  })
  const path =
    arm === 'before' ? '/bootstrap-ws?coding=identity&client=slow' : '/sync/bootstrap?client=slow'
  const upgrade =
    arm === 'before'
      ? 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
      : 'Accept-Encoding: identity\r\nConnection: close\r\n'
  const start = performance.now()
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${upgrade}\r\n`)
  const progress = async () => {
    const metrics = await json('/metrics')
    return arm === 'before'
      ? metrics.senders.slow
      : Object.values(metrics.relays).find((r) => r.principal === 'measurement-reader-slow')
  }
  const tcp = () =>
    execFileSync('ss', ['-tinm', `( sport = :${port} or dport = :${port} )`], { encoding: 'utf8' })
  let buffer = Buffer.alloc(0),
    headersDone = false,
    chunkRemaining = null,
    jsonPending = '',
    rows = 0,
    bodyBytes = 0,
    done = false,
    completeRecord = false
  const onRecord = (frame) => {
    if (frame.type === 'feedBootstrap') {
      rows += frame.changes.length
      if (frame.last && arm === 'before') done = true
    }
    if (frame.type === 'syncComplete') completeRecord = true
    if (frame.type === 'syncError') throw new Error(JSON.stringify(frame))
  }
  const feedBody = (bytes) => {
    bodyBytes += bytes.length
    jsonPending += bytes.toString()
    for (;;) {
      const end = jsonPending.indexOf('\n')
      if (end < 0) break
      const line = jsonPending.slice(0, end)
      jsonPending = jsonPending.slice(end + 1)
      if (line) onRecord(JSON.parse(line))
    }
  }
  function parse(bytes) {
    buffer = Buffer.concat([buffer, bytes])
    if (!headersDone) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const headers = buffer.subarray(0, end).toString()
      if (!headers.startsWith(arm === 'before' ? 'HTTP/1.1 101' : 'HTTP/1.1 200'))
        throw new Error(headers)
      buffer = buffer.subarray(end + 4)
      headersDone = true
    }
    if (arm === 'before') {
      while (buffer.length >= 2) {
        let size = buffer[1] & 127,
          offset = 2
        if (size === 126) {
          if (buffer.length < 4) return
          size = buffer.readUInt16BE(2)
          offset = 4
        } else if (size === 127) {
          if (buffer.length < 10) return
          size = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (buffer.length < offset + size) return
        const opcode = buffer[0] & 15,
          payload = buffer.subarray(offset, offset + size)
        buffer = buffer.subarray(offset + size)
        if (opcode === 1) {
          bodyBytes += payload.length
          onRecord(JSON.parse(payload.toString()))
        } else if (opcode === 8 && !done) throw new Error('slow WebSocket closed before completion')
      }
    } else {
      while (true) {
        if (chunkRemaining === null) {
          const end = buffer.indexOf('\r\n')
          if (end < 0) return
          chunkRemaining = parseInt(buffer.subarray(0, end).toString(), 16)
          buffer = buffer.subarray(end + 2)
          if (chunkRemaining === 0) {
            done = completeRecord
            return
          }
        }
        if (buffer.length < chunkRemaining + 2) return
        feedBody(buffer.subarray(0, chunkRemaining))
        buffer = buffer.subarray(chunkRemaining + 2)
        chunkRemaining = null
      }
    }
  }
  let readBytes = 0,
    maxBufferedBytes = 0,
    writes = 0
  const walBeforeBytes = walBytes()
  let walPeakBytes = walBeforeBytes
  try {
    // No application reads at all in this interval. Kernel/native slack must
    // fill and progress must plateau; a delayed JavaScript body reader is not proof.
    await delay(smoke ? 50 : 3000)
    const stalledA = await progress(),
      tcpA = smoke ? 'smoke' : tcp()
    await delay(smoke ? 50 : 2000)
    const stalledB = await progress(),
      tcpB = smoke ? 'smoke' : tcp()
    for (let i = 0; i < 10; i++) {
      await json('/write', { method: 'POST' })
      writes++
    }
    walPeakBytes = Math.max(walPeakBytes ?? 0, walBytes() ?? 0)
    const checkpointWhileStopped = await json('/checkpoint', { method: 'POST' })
    const count = (p) => (arm === 'before' ? p?.sentBytes : p?.bytes)
    const stalled =
      !smoke &&
      stalledA &&
      stalledB &&
      count(stalledA) === count(stalledB) &&
      count(stalledB) > 0 &&
      (arm === 'before' ? stalledB.paused : !stalledB.complete)
    if (!smoke && arm === 'after' && stalledB?.complete)
      return {
        status: 'failed',
        error: 'worker completed entire body while raw socket remained unread',
        stalled: false,
        proofPassed: false,
        stalledA,
        stalledB,
        tcpA,
        tcpB,
        checkpointWhileStopped,
        walBeforeBytes,
        walPeakBytes,
        writes,
        achievedRatio: 1,
      }
    const resumeAt = performance.now(),
      reads = []
    let deadline = resumeAt
    while (!done) {
      if (socketError) throw socketError
      if (performance.now() - start > 580000) throw new Error('slow completion deadline')
      deadline += smoke ? 1 : readIntervalMs
      await delay(Math.max(0, deadline - performance.now()))
      maxBufferedBytes = Math.max(maxBufferedBytes, socket.readableLength)
      if (socket.readableLength > 128 * 1024) throw new Error('unbounded slow socket buffer')
      const chunk = socket.read(Math.min(65536, socket.readableLength))
      if (chunk) {
        readBytes += chunk.length
        parse(chunk)
        reads.push({ atMs: performance.now() - resumeAt, bytes: chunk.length })
      }
      if (reads.length && reads.length % 10 === 0) {
        await json('/write', { method: 'POST' })
        writes++
        const wal = walBytes()
        if (wal !== null) walPeakBytes = Math.max(walPeakBytes ?? 0, wal)
      }
      if (socket.readableEnded && !done && !socket.readableLength)
        throw new Error('slow socket ended prematurely')
    }
    const completionMs = performance.now() - start,
      pacedMs = performance.now() - resumeAt
    const finalProgress = await progress()
    const checkpointAfterCompletion = await json('/checkpoint?truncate=1', { method: 'POST' })
    if (rows !== manifest.rows) throw new Error(`slow row control ${rows}`)
    const idealPacedMs = (readBytes / 65536) * readIntervalMs
    const rateErrorFraction = smoke ? null : Math.abs(pacedMs - idealPacedMs) / idealPacedMs
    return {
      status: 200,
      rows,
      bodyBytes,
      achievedRatio: 1,
      completionMs,
      pacedMs,
      idealPacedMs,
      rateErrorFraction,
      stalled: !!stalled,
      checkpointWhileStopped,
      checkpointAfterCompletion,
      walAfterCheckpointBytes: walBytes(),
      proofPassed: smoke
        ? null
        : !!stalled && rateErrorFraction < 0.15 && count(finalProgress) > count(stalledB),
      stalledA,
      stalledB,
      finalProgress,
      tcpA,
      tcpB,
      bytesPerReadLimit: 65536,
      intervalMs: readIntervalMs,
      maxNodeSocketBufferedBytes: maxBufferedBytes,
      readBytesIncludingHeaders: readBytes,
      reads,
      walBeforeBytes,
      walPeakBytes,
      walGrowthBytes: walPeakBytes === null ? null : walPeakBytes - walBeforeBytes,
      writes,
    }
  } finally {
    socket.destroy()
  }
}
async function delta() {
  const store = new InMemoryReplicaStore()
  store.cache.applyAtomic({
    operations: Array.from({ length: manifest.rows }, (_, i) => ({
      kind: 'upsert',
      entity: 'repo',
      entityId: `measurement-repo-${i}`,
      value: JSON.parse(rowPayload(i)),
      provenance: { seq: i + 1 },
    })),
    cursor: { feedId: 'measurement-feed', epoch: 'measurement-epoch', seq: manifest.from },
  })
  let start,
    firstPageMs = null,
    rows = 0,
    pages = 0,
    bytesDecoded = 0
  const frame = (wire) => {
    if (firstPageMs === null) firstPageMs = performance.now() - start
    rows += wire.changes.length
    pages++
    return toDeltaFrame(wire)
  }
  const authority = {
    // biome-ignore lint/correctness/useYield: the retained-heal arm must never bootstrap; this generator only throws
    bootstrap: async function* () {
      throw new Error('unexpected bootstrap during retained heal')
    },
    changesRange: async (_cursor, _signal, onTarget) => {
      const response = await request(
        `/sync/delta?feedId=measurement-feed&epoch=measurement-epoch&from=${manifest.from}&to=${manifest.through}`,
        { headers: { 'accept-encoding': 'identity' } },
      )
      if (response.statusCode !== 200) throw new Error(`delta status ${response.statusCode}`)
      return (async function* () {
        let pending = '',
          complete = false
        for await (const bytes of response) {
          bytesDecoded += bytes.length
          pending += bytes.toString()
          for (;;) {
            const end = pending.indexOf('\n')
            if (end < 0) break
            const line = pending.slice(0, end)
            pending = pending.slice(end + 1)
            if (!line) continue
            const wire = JSON.parse(line)
            if (wire.type === 'syncMeta')
              onTarget?.({ feedId: wire.feedId, epoch: wire.epoch, seq: wire.seq })
            if (wire.type === 'feedDelta') yield frame(wire)
            if (wire.type === 'syncComplete') complete = true
            if (wire.type === 'syncError') throw new Error(JSON.stringify(wire))
          }
        }
        if (pending || !complete) throw new Error('incomplete delta')
      })()
    },
  }
  const replica = new Replica({ store: store.cache, unitOfWork: store.unitOfWork, authority })
  const initialRss = process.memoryUsage().rss
  let peakRss = initialRss
  const sample = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  const timer = setInterval(sample, 5)
  try {
    start = performance.now()
    replica.connect()
    await replica.settled()
    sample()
    const completionMs = performance.now() - start
    if (
      replica.cursor?.seq !== manifest.through ||
      rows !== manifest.deltaRows ||
      replica.posture !== 'live'
    )
      throw new Error(`Replica failed heal: ${replica.posture}/${replica.cursor?.seq}/${rows}`)
    if (replica.entities().length !== manifest.rows) throw new Error('Replica key count mismatch')
    return {
      firstPageMs,
      completionMs,
      rows,
      pages,
      bytesDecoded,
      achievedRatio: 1,
      initialClientRssBytes: initialRss,
      peakClientRssBytes: peakRss,
      retainedReplicaKeys: replica.entities().length,
      replicaScope:
        'production Replica and InMemoryReplicaStore from measured source, production wire mapper; seeded full world; no disk persistence',
    }
  } finally {
    clearInterval(timer)
    replica.disconnect()
  }
}
async function admission() {
  const sockets = []
  try {
    for (let i = 0; i < 12; i++) {
      const socket = net.createConnection({ host: '127.0.0.1', port, readableHighWaterMark: 1024 })
      socket.on('error', () => {})
      await new Promise((yes, no) => {
        socket.once('connect', yes)
        socket.once('error', no)
      })
      socket.write(
        `GET /sync/bootstrap?client=queue-${i} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
      )
      sockets.push(socket)
    }
    await delay(smoke ? 500 : 5000)
    const states = sockets.map((socket) => {
      const bytes = socket.read(Math.min(socket.readableLength, 1024))
      const text = bytes?.toString() ?? ''
      return {
        status: Number(text.match(/^HTTP\/1.1 (\d+)/)?.[1]) || 'pending',
        retryAfter: text.match(/retry-after: ([^\r]+)/i)?.[1] ?? null,
      }
    })
    const during = await json('/metrics')
    writeFileSync(
      `${outPath}.admission-checkpoint.json`,
      JSON.stringify(
        {
          arm,
          sourceCommit: process.env.MEASUREMENT_SHA,
          conditions: conditions(),
          manifest,
          states,
          during,
        },
        null,
        2,
      ),
    )
    for (const socket of sockets) socket.destroy()
    await delay(1000)
    const after = await json('/metrics')
    return {
      states,
      jobsDuring: during.jobs,
      jobsAfter: after.jobs,
      admissionPassed:
        arm === 'before'
          ? states.every((x) => x.status === 404)
          : smoke
            ? null
            : states.filter((x) => x.status === 503 && x.retryAfter).length >= 2 &&
              during.jobs <= 10 &&
              after.jobs === 0,
      scope:
        arm === 'before'
          ? 'HTTP bootstrap absent (404); no equivalent HTTP admission limit'
          : 'two active and eight queued HTTP jobs under stopped raw readers',
      achievedRatio: 1,
    }
  } finally {
    for (const socket of sockets) socket.destroy()
  }
}
async function observedBootstrap(index) {
  try {
    return await bootstrap(index)
  } catch (error) {
    return { status: 'failed', error: String(error) }
  }
}
const health = [],
  ping = []
const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ping`)
await new Promise((yes, no) => {
  ws.once('open', yes)
  ws.once('error', no)
})
const beforeConditions = conditions(),
  before = snapshot(),
  timeline = [before]
let running = true
const timer = setInterval(() => timeline.push(snapshot()), 50)
const probeHealth = async () => {
  while (running) {
    const t = performance.now()
    await json('/health')
    health.push(performance.now() - t)
    await delay(25)
  }
}
const probePing = async () => {
  while (running) {
    const t = performance.now()
    await new Promise((yes, no) => {
      const timeout = setTimeout(() => no(new Error('ping timeout')), 10000)
      ws.once('pong', () => {
        clearTimeout(timeout)
        yes()
      })
      ws.ping()
    })
    ping.push(performance.now() - t)
    await delay(25)
  }
}
const probes = Promise.all([probeHealth(), probePing()])
void probes.catch(() => {})
let result
try {
  result =
    mode === 'admission'
      ? await admission()
      : mode === 'delta'
        ? await delta()
        : mode === 'concurrent' || mode === 'rate-control'
          ? await Promise.all([
              slowReader(),
              ...Array.from({ length: 4 }, (_, i) => observedBootstrap(i)),
            ])
          : await observedBootstrap(0)
} finally {
  running = false
  await probes
  clearInterval(timer)
  ws.terminate()
}
const after = snapshot()
timeline.push(after)
const wallMs = after.atMs - before.atMs
const threadCpu = Object.fromEntries(
  Object.entries(after.threads).map(([tid, entry]) => [
    tid,
    {
      name: entry.name,
      cpuMs: ((entry.ticks - (before.threads[tid]?.ticks ?? 0)) / tickHz) * 1000,
    },
  ]),
)
const report = {
  arm,
  mode,
  coding,
  effectiveCoding: arm === 'before' && coding === 'gzip' ? 'identity' : coding,
  sourceCommit: process.env.MEASUREMENT_SHA ?? 'SMOKE-NOT-A-MEASUREMENT',
  node: process.version,
  conditionsBefore: beforeConditions,
  conditionsAfter: conditions(),
  manifest,
  result,
  wallMs,
  mainThreadCpuMs: threadCpu[pid]?.cpuMs,
  mainThreadBusyPercent: (threadCpu[pid]?.cpuMs / wallMs) * 100,
  threadCpu,
  peakSampledServerRssBytes: Math.max(...timeline.map((x) => x.rssBytes)),
  serverRssBeforeBytes: before.rssBytes,
  serverHighWaterRssBytes: after.highWaterRssBytes,
  health: {
    samples: health.length,
    p50Ms: percentile(health, 0.5),
    p95Ms: percentile(health, 0.95),
  },
  websocketPing: {
    samples: ping.length,
    p50Ms: percentile(ping, 0.5),
    p95Ms: percentile(ping, 0.95),
  },
  serverMetrics: await json('/metrics'),
  timeline,
}
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(
  JSON.stringify({
    arm,
    mode,
    coding,
    wallMs,
    mainThreadBusyPercent: report.mainThreadBusyPercent,
    healthP95Ms: report.health.p95Ms,
    result: Array.isArray(result) ? result.map(({ reads, tcpA, tcpB, ...rest }) => rest) : result,
  }),
)
