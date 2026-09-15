/**
 * THE SEND PUMP OVER A REAL BUN SOCKET (POD-3931).
 *
 * A mocked `send` can be scripted to say `-1`; it cannot prove that Bun says it,
 * when, or that `drain` follows. So these cases run `Bun.serve` with the same
 * `NativeGatewaySocket` adapter production uses and a raw TCP client that
 * performs the WebSocket handshake by hand — because a client that merely sleeps
 * in its message callback still lets the runtime read the socket, and the
 * server never feels pressure. `net.Socket.pause()` stops the kernel read, so
 * the server's kernel send buffer fills, Bun's own buffer fills, `send` answers
 * `-1`, and `drain` fires as the client reads again. Measured on Bun 1.3.14.
 *
 * The receiver is THROTTLED, not merely slow: it reads in short bursts with
 * pauses between them, so every transfer here crosses the pause/drain path many
 * times. Each case reports the pump's peak socket bytes, peak application bytes
 * and the shared budget's peak separately.
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import net from 'node:net'
import {
  BootstrapZstdMetadata,
  decodeBinaryEnvelope,
  type FeedBootstrapMessage,
} from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeBootstrapZstd } from '../../../../packages/client-core/src/socket-transport/bootstrap-zstd'
import {
  BootstrapCompressionBudget,
  compressBootstrap,
  OrderedClientSend,
  type OrderedSendOptions,
  type OrderedSendStats,
  type SendSequenceSource,
} from './ordered-client-send'
import { NativeGatewaySocket, serveNative } from './ws-server'
import { WS_MAX_PAYLOAD_BYTES } from './ws-send'

/** Small marks so the 50 MB world is many times the socket's capacity. */
const LIMITS = { sendBufferLimitBytes: 2 * 1024 * 1024, lossySendBufferLimitBytes: 256 * 1024 }
const MiB = 1024 * 1024
/** Scale every world down for a quick local look (e.g. `=4`); the gate runs full size. */
const SCALE = Number(process.env.PODIUM_TRANSPORT_TEST_MIB_SCALE ?? '1')
const worldOf = (mib: number) => bootstrapSource(Math.max(1, Math.round((mib * MiB) / SCALE)))

interface Connection {
  socket: NativeGatewaySocket
  closed: Promise<void>
}

/** One native server whose sockets are wrapped exactly as `ws-server.ts` wraps them. */
function serve() {
  const opened: Array<(c: Connection) => void> = []
  type Data = { socket?: NativeGatewaySocket; closed?: () => void }
  const server = serveNative<Data>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, srv) {
      return srv.upgrade(request, { data: {} }) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      data: {} as Data,
      perMessageDeflate: { compress: '3KB', decompress: '3KB' },
      maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
      backpressureLimit: LIMITS.sendBufferLimitBytes + WS_MAX_PAYLOAD_BYTES,
      closeOnBackpressureLimit: false,
      idleTimeout: 0,
      sendPings: false,
      open(native) {
        const socket = new NativeGatewaySocket(native as never)
        native.data.socket = socket
        const closed = new Promise<void>((resolve) => {
          native.data.closed = resolve
        })
        opened.shift()?.({ socket, closed })
      },
      message(native, message) {
        native.data.socket?.emit('message', message)
      },
      drain(native) {
        native.data.socket?.emit('drain')
      },
      pong(native) {
        native.data.socket?.emit('pong')
      },
      close(native) {
        native.data.socket?.emit('close')
        native.data.closed?.()
      },
    },
  })
  return {
    port: server.port,
    nextConnection: () => new Promise<Connection>((resolve) => opened.push(resolve)),
    stop: () => server.stop(true),
  }
}

interface Frame {
  opcode: number
  payload: Buffer
}

/**
 * A raw WebSocket client that reads only when told to. `burst(ms)` reads for
 * one burst then pauses for `gapMs`; `hold()` stops reading until `release()`.
 */
function rawClient(port: number, throttle: { readMs: number; gapMs: number }) {
  const key = randomBytes(16).toString('base64')
  const socket = net.connect(port, '127.0.0.1')
  socket.setNoDelay(true)
  const frames: Frame[] = []
  const listeners = new Set<() => void>()
  let handshake = Buffer.alloc(0)
  let handshook = false
  /** Received chunks not yet consumed; concatenated only once a frame is complete. */
  let chunks: Buffer[] = []
  let pendingBytes = 0
  let fragment: { opcode: number; parts: Buffer[] } | undefined
  let held = false
  let bytesRead = 0
  let ended = false
  const endListeners = new Set<() => void>()

  const head = (n: number): Buffer | undefined => {
    if (pendingBytes < n) return undefined
    if (chunks[0]!.length >= n) return chunks[0]!.subarray(0, n)
    return Buffer.concat(chunks).subarray(0, n)
  }
  const take = (n: number): Buffer => {
    const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)
    chunks = all.length > n ? [all.subarray(n)] : []
    pendingBytes = all.length - n
    return all.subarray(0, n)
  }
  const parse = () => {
    for (;;) {
      const h2 = head(2)
      if (!h2) return
      const fin = (h2[0]! & 0x80) !== 0
      const opcode = h2[0]! & 0x0f
      let length = h2[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        const h4 = head(4)
        if (!h4) return
        length = h4.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        const h10 = head(10)
        if (!h10) return
        length = Number(h10.readBigUInt64BE(2))
        offset = 10
      }
      if (pendingBytes < offset + length) return
      const payload = take(offset + length).subarray(offset)
      if (opcode === 0 && fragment) {
        fragment.parts.push(Buffer.from(payload))
        if (fin) {
          frames.push({ opcode: fragment.opcode, payload: Buffer.concat(fragment.parts) })
          fragment = undefined
        }
      } else if (!fin) {
        fragment = { opcode, parts: [Buffer.from(payload)] }
      } else {
        frames.push({ opcode, payload: Buffer.from(payload) })
      }
      for (const listener of [...listeners]) listener()
    }
  }

  let gapTimer: ReturnType<typeof setTimeout> | undefined
  let burstTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleGap = () => {
    if (held || ended) return
    socket.pause()
    gapTimer = setTimeout(() => {
      if (held || ended) return
      socket.resume()
      burstTimer = setTimeout(scheduleGap, throttle.readMs)
    }, throttle.gapMs)
  }

  socket.on('connect', () => {
    socket.write(
      `GET /client HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
  })
  socket.on('data', (chunk: Buffer) => {
    bytesRead += chunk.length
    if (!handshook) {
      handshake = Buffer.concat([handshake, chunk])
      const end = handshake.indexOf('\r\n\r\n')
      if (end === -1) return
      handshook = true
      const rest = handshake.subarray(end + 4)
      if (rest.length) {
        chunks.push(rest)
        pendingBytes += rest.length
      }
      parse()
      scheduleGap()
      return
    }
    chunks.push(chunk)
    pendingBytes += chunk.length
    parse()
  })
  socket.on('close', () => {
    ended = true
    if (gapTimer) clearTimeout(gapTimer)
    if (burstTimer) clearTimeout(burstTimer)
    for (const listener of [...endListeners]) listener()
  })
  socket.on('error', () => {})

  return {
    frames,
    bytesRead: () => bytesRead,
    hold() {
      held = true
      if (gapTimer) clearTimeout(gapTimer)
      if (burstTimer) clearTimeout(burstTimer)
      socket.pause()
    },
    release() {
      held = false
      socket.resume()
      burstTimer = setTimeout(scheduleGap, throttle.readMs)
    },
    waitForFrames(count: number, timeoutMs = 60_000): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check)
          reject(new Error(`only ${frames.length}/${count} frames after ${timeoutMs}ms`))
        }, timeoutMs)
        const check = () => {
          if (frames.length < count) return
          clearTimeout(timer)
          listeners.delete(check)
          resolve()
        }
        listeners.add(check)
        check()
      })
    },
    closed(timeoutMs = 10_000): Promise<void> {
      if (ended) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('socket never closed')), timeoutMs)
        endListeners.add(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    destroy: () => socket.destroy(),
  }
}

/** Rows of deliberately uneven size: mostly small, some hundreds of KB. */
function rowValue(row: number): unknown {
  const big = row % 37 === 0
  return {
    id: `row-${row}`,
    // Compressible but not trivially so: repeated words with varying counts.
    text: big ? `lorem ipsum ${row} `.repeat(12_000) : `row ${row} ${'x'.repeat(row % 300)}`,
  }
}

/** A bootstrap of at least `minBytes` serialized JSON, `rowsPerChunk` rows a chunk. */
function bootstrapSource(minBytes: number, rowsPerChunk = 200) {
  const chunks: string[] = []
  let produced = 0
  let seq = 0
  let bytes = 0
  const source: SendSequenceSource = {
    next() {
      if (bytes >= minBytes && produced > 0) return undefined
      const changes = Array.from({ length: rowsPerChunk }, (_, i) => ({
        seq: (seq += 1),
        entity: 'session' as const,
        entityId: `chunk-${produced}-row-${i}`,
        op: 'upsert' as const,
        value: rowValue(seq),
      }))
      const msg: FeedBootstrapMessage = {
        type: 'feedBootstrap',
        feedId: 'feed',
        epoch: 'epoch',
        fromSeq: 0,
        seq: 1_000_000,
        minAvailableSeq: 0,
        changes: changes as unknown as FeedBootstrapMessage['changes'],
        last: false,
        totalRows: 0,
        countsByEntity: {},
      }
      const encoded = JSON.stringify(msg)
      bytes += encoded.length
      produced += 1
      chunks.push(`chunk-${produced - 1}-row-0`)
      if (bytes >= minBytes) msg.last = true
      return msg
    },
  }
  return { source, chunks, bytes: () => bytes, count: () => produced }
}

function firstEntityId(frame: Frame, decode: boolean): string {
  let json: string
  if (decode && frame.opcode === 2) {
    const decoded = decodeBinaryEnvelope(new Uint8Array(frame.payload), BootstrapZstdMetadata)
    json = decodeBootstrapZstd({
      payload: decoded.payload,
      uncompressedBytes: decoded.metadata.uncompressedBytes,
    })
  } else {
    json = frame.payload.toString('utf8')
  }
  // Cheap positional read; parsing 50 MB of JSON per case would dominate the run.
  const match = /"entityId":"([^"]+)"/.exec(json)
  return match?.[1] ?? '<none>'
}

/** Peak socket bytes, peak application bytes and the shared budget, separately.
 * Also appended to `PODIUM_TRANSPORT_TEST_REPORT` when set, because the
 * reporter elides console output of passing tests. */
function report(name: string, stats: OrderedSendStats, budget: BootstrapCompressionBudget, extra: Record<string, unknown> = {}) {
  const line =
    `[transport] ${name}: sentFrames=${stats.sentFrames} sentBytes=${stats.sentBytes} pauses=${stats.pauses} ` +
    `peakSocketBufferedBytes=${stats.peakSocketBufferedBytes} peakQueuedBytes=${stats.peakQueuedBytes} ` +
    `sharedBudgetBytes=${budget.bytes} activeJobs=${budget.activeJobs} ` +
    Object.entries(extra)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ')
  console.log(line)
  const file = process.env.PODIUM_TRANSPORT_TEST_REPORT
  if (file) appendFileSync(file, `${line}\n`)
}

const THROTTLE = { readMs: 2, gapMs: 150 }

describe('send pump over a real Bun socket', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  async function connect(
    options: OrderedSendOptions = {},
    budget = new BootstrapCompressionBudget(),
    throttle = THROTTLE,
  ) {
    const server = serve()
    cleanups.push(server.stop)
    const pending = server.nextConnection()
    const client = rawClient(server.port, throttle)
    cleanups.push(client.destroy)
    if (process.env.PODIUM_TRANSPORT_TEST_TRACE === '1') process.stderr.write('[trace] awaiting open\n')
    const connection = await pending
    if (process.env.PODIUM_TRANSPORT_TEST_TRACE === '1') process.stderr.write('[trace] open\n')
    const sink = new OrderedClientSend(connection.socket, LIMITS, compressBootstrap, budget, {
      noProgressTimeoutMs: 20_000,
      ...options,
    })
    connection.socket.on('close', () => sink.dispose())
    if (process.env.PODIUM_TRANSPORT_TEST_TRACE === '1') {
      const sampler = setInterval(() => {
        const s = sink.stats()
        process.stderr.write(
          `[sample] sent=${s.sentFrames}/${s.sentBytes} paused=${s.paused} pauses=${s.pauses} buffered=${s.socketBufferedBytes} queued=${s.queuedBytes} read=${client.bytesRead()} frames=${client.frames.length}\n`,
        )
      }, 1000)
      cleanups.push(() => clearInterval(sampler))
    }
    return { server, client, connection, sink, budget }
  }

  it('a 50 MB uncompressed bootstrap to a throttled receiver completes, once, in order', async () => {
    const { client, sink, budget } = await connect()
    const world = worldOf(50)
    const outcome = await sink.sendSequence(world.source)
    expect(outcome).toEqual({ ok: true })
    await client.waitForFrames(world.count())
    const stats = sink.stats()
    report('uncompressed-50MB', stats, budget, { chunks: world.count(), bytes: world.bytes() })
    expect(client.frames.map((f) => firstEntityId(f, false))).toEqual(world.chunks)
    expect(stats.failure).toBeUndefined()
    // Backpressure was genuinely exercised, not merely survived.
    expect(stats.pauses).toBeGreaterThan(3)
    // Bun's buffer never exceeds the mark by more than one frame ...
    expect(stats.peakSocketBufferedBytes).toBeLessThan(LIMITS.sendBufferLimitBytes + 8 * MiB)
    // ... and the application never held more than the prepare window.
    expect(stats.peakQueuedBytes).toBeLessThan(3 * 8 * MiB)
    expect(stats.queuedBytes).toBe(0)
    expect(budget.bytes).toBe(0)
  }, 120_000)

  it('the same transfer with negotiated Zstd decodes chunk for chunk', async () => {
    const { client, sink, budget } = await connect()
    sink.enableBootstrapCompression(true)
    const world = worldOf(50)
    const outcome = await sink.sendSequence(world.source)
    expect(outcome).toEqual({ ok: true })
    await client.waitForFrames(world.count())
    const stats = sink.stats()
    report('zstd-50MB', stats, budget, { chunks: world.count(), bytes: world.bytes() })
    expect(client.frames.every((f) => f.opcode === 2)).toBe(true)
    expect(client.frames.map((f) => firstEntityId(f, true))).toEqual(world.chunks)
    expect(stats.sentBytes).toBeLessThan(world.bytes())
    expect(stats.activeCompression).toBe(0)
    expect(budget.bytes).toBe(0)
  }, 120_000)

  it('a receiver that stops reading and resumes gets the rest; one that never resumes is cut off with a reason', async () => {
    const resumed = await connect({ noProgressTimeoutMs: 5_000 })
    // Large enough that it cannot have been handed to the socket in full by
    // the time the receiver stops reading; the pause below is then certain.
    const world = worldOf(50)
    const outcome = resumed.sink.sendSequence(world.source)
    await resumed.client.waitForFrames(2)
    resumed.client.hold()
    await new Promise((r) => setTimeout(r, 800))
    expect(resumed.sink.stats().paused).toBe(true)
    resumed.client.release()
    expect(await outcome).toEqual({ ok: true })
    await resumed.client.waitForFrames(world.count())
    report('stop-resume', resumed.sink.stats(), resumed.budget)

    const dead = await connect({ noProgressTimeoutMs: 400 })
    const stuck = worldOf(50)
    const stuckOutcome = dead.sink.sendSequence(stuck.source)
    await dead.client.waitForFrames(1)
    dead.client.hold()
    expect(await stuckOutcome).toEqual({ ok: false, reason: 'no-progress-timeout' })
    expect(dead.sink.stats().failure).toBe('no-progress-timeout')
    // A paused `net` stream reports the peer's close only once it reads again.
    dead.client.release()
    await dead.client.closed()
    report('never-resumes', dead.sink.stats(), dead.budget)
    expect(dead.budget.bytes).toBe(0)
  }, 60_000)

  it('lossy traffic is dropped under pressure and never ends the reliable transfer', async () => {
    const { client, sink, budget } = await connect()
    const world = worldOf(12)
    const outcome = sink.sendSequence(world.source)
    let refused = 0
    let admitted = 0
    for (let i = 0; i < 200; i++) {
      if (sink.sendLossy({ type: 'pong' })) admitted += 1
      else refused += 1
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(await outcome).toEqual({ ok: true })
    await client.waitForFrames(world.count())
    report('lossy-pressure', sink.stats(), budget, { admitted, refused })
    expect(refused).toBeGreaterThan(0)
    expect(sink.stats().failure).toBeUndefined()
    const bootstraps = client.frames.filter((f) => f.payload.subarray(0, 24).toString().includes('feedBootstrap'))
    expect(bootstraps.map((f) => firstEntityId(f, false))).toEqual(world.chunks)
  }, 60_000)

  it('two clients exhaust a small shared budget and both still finish', async () => {
    const budget = new BootstrapCompressionBudget(6 * MiB, 1)
    const a = await connect({ prepareAheadBytes: 4 * MiB }, budget)
    const b = await connect({ prepareAheadBytes: 4 * MiB }, budget)
    a.sink.enableBootstrapCompression(true)
    b.sink.enableBootstrapCompression(true)
    const worldA = worldOf(10)
    const worldB = worldOf(10)
    let peakBudget = 0
    const sample = setInterval(() => {
      peakBudget = Math.max(peakBudget, budget.bytes)
    }, 1)
    const [oa, ob] = await Promise.all([
      a.sink.sendSequence(worldA.source),
      b.sink.sendSequence(worldB.source),
    ])
    clearInterval(sample)
    expect(oa).toEqual({ ok: true })
    expect(ob).toEqual({ ok: true })
    await a.client.waitForFrames(worldA.count())
    await b.client.waitForFrames(worldB.count())
    report('shared-budget-a', a.sink.stats(), budget, { peakBudget })
    report('shared-budget-b', b.sink.stats(), budget, { peakBudget })
    expect(peakBudget).toBeLessThanOrEqual(budget.maxBytes)
    expect(budget.bytes).toBe(0)
    expect(a.client.frames.map((f) => firstEntityId(f, true))).toEqual(worldA.chunks)
    expect(b.client.frames.map((f) => firstEntityId(f, true))).toEqual(worldB.chunks)
  }, 120_000)

  it('a fast client stays responsive while a slow one receives 50 MB', async () => {
    const slow = await connect()
    const fast = await connect({}, new BootstrapCompressionBudget(), { readMs: 1000, gapMs: 0 })
    const world = worldOf(50)
    const outcome = slow.sink.sendSequence(world.source)
    let worst = 0
    let probes = 0
    while (!slow.sink.stats().failure && slow.sink.stats().sentFrames < world.count()) {
      const before = fast.client.frames.length
      const t0 = performance.now()
      fast.sink.send({ type: 'pong' })
      await fast.client.waitForFrames(before + 1, 5_000)
      worst = Math.max(worst, performance.now() - t0)
      probes += 1
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(await outcome).toEqual({ ok: true })
    report('fast-client-latency', slow.sink.stats(), slow.budget, { probes, worstMs: worst.toFixed(1) })
    expect(probes).toBeGreaterThan(5)
    expect(worst).toBeLessThan(500)
  }, 120_000)
})
