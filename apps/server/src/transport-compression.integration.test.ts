import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib'
import { asSessionId } from '@podium/model'
import { CAP_METADATA_DELTA, WIRE_VERSION } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServerHandle } from './server'
import { startServer } from './server'

const LARGE_JSON = JSON.stringify({
  rows: Array.from({ length: 2_000 }, (_, i) => ({ id: i, value: 'transport-proof-value' })),
})
const LARGE_TEXT = 'transport-compression-proof/'.repeat(4_000)
const priorStateDir = process.env.PODIUM_STATE_DIR
const priorWebDir = process.env.PODIUM_WEB_DIR
const priorMobileWebDir = process.env.PODIUM_MOBILE_WEB_DIR

interface RawHttpResponse {
  status: number
  headers: Map<string, string>
  body: Buffer
}

function decodeChunked(body: Buffer): Buffer {
  const chunks: Buffer[] = []
  let cursor = 0
  while (cursor < body.length) {
    const lineEnd = body.indexOf('\r\n', cursor)
    if (lineEnd < 0) throw new Error('truncated chunk size')
    const sizeToken = body.subarray(cursor, lineEnd).toString('ascii').split(';').at(0) ?? ''
    const size = Number.parseInt(sizeToken, 16)
    cursor = lineEnd + 2
    if (size === 0) return Buffer.concat(chunks)
    chunks.push(body.subarray(cursor, cursor + size))
    cursor += size + 2
  }
  throw new Error('missing final HTTP chunk')
}

async function rawHttp(port: number, path: string): Promise<RawHttpResponse> {
  const socket = createConnection({ host: '127.0.0.1', port })
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new Error(`timed out reading HTTP ${path}`)), 5_000)
    socket.once('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`,
      )
    })
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const headerEnd = bytes.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const head = bytes.subarray(0, headerEnd).toString('latin1')
      const contentLength = /\r\ncontent-length:\s*(\d+)/i.exec(`\r\n${head}`)?.[1]
      if (contentLength !== undefined && bytes.length - headerEnd - 4 >= Number(contentLength)) {
        finish()
        return
      }
      if (
        /\r\ntransfer-encoding:\s*chunked/i.test(`\r\n${head}`) &&
        bytes
          .subarray(headerEnd + 4)
          .subarray(-7)
          .includes(Buffer.from('\r\n0\r\n\r\n'))
      ) {
        finish()
      }
    })
    socket.once('end', () => finish())
    socket.once('error', (error) => finish(error))
  })
  const bytes = Buffer.concat(chunks)
  const headerEnd = bytes.indexOf('\r\n\r\n')
  if (headerEnd < 0) throw new Error('missing HTTP response headers')
  const lines = bytes.subarray(0, headerEnd).toString('latin1').split('\r\n')
  const status = Number(lines.shift()?.split(' ')[1])
  const headers = new Map<string, string>()
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator > 0) {
      headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim())
    }
  }
  const rawBody = bytes.subarray(headerEnd + 4)
  return {
    status,
    headers,
    body:
      headers.get('transfer-encoding')?.toLowerCase() === 'chunked'
        ? decodeChunked(rawBody)
        : rawBody,
  }
}

class SocketReader {
  private bytes = Buffer.alloc(0)
  private waiters: Array<() => void> = []
  private failure: Error | undefined

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk) => {
      this.bytes = Buffer.concat([this.bytes, Buffer.from(chunk)])
      for (const wake of this.waiters.splice(0)) wake()
    })
    socket.on('error', (error) => {
      this.failure = error
      for (const wake of this.waiters.splice(0)) wake()
    })
    socket.on('end', () => {
      this.failure ??= new Error('socket ended before the expected bytes arrived')
      for (const wake of this.waiters.splice(0)) wake()
    })
  }

  async take(length: number): Promise<Buffer> {
    while (this.bytes.length < length) {
      if (this.failure) throw this.failure
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for socket bytes')),
          5_000,
        )
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    const out = this.bytes.subarray(0, length)
    this.bytes = this.bytes.subarray(length)
    return out
  }

  async takeThrough(marker: Buffer): Promise<Buffer> {
    while (true) {
      const end = this.bytes.indexOf(marker)
      if (end >= 0) return this.take(end + marker.length)
      if (this.failure) throw this.failure
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for socket marker')),
          5_000,
        )
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
}

interface RawWebSocket {
  socket: Socket
  reader: SocketReader
  responseHeaders: Map<string, string>
}

async function openRawWebSocket(port: number, path: string): Promise<RawWebSocket> {
  const socket = createConnection({ host: '127.0.0.1', port })
  const reader = new SocketReader(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
      '',
      '',
    ].join('\r\n'),
  )
  const head = (await reader.takeThrough(Buffer.from('\r\n\r\n'))).toString('latin1')
  const lines = head.trim().split('\r\n')
  expect(lines.shift()).toContain('101 Switching Protocols')
  const responseHeaders = new Map<string, string>()
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator > 0) {
      responseHeaders.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim())
    }
  }
  return { socket, reader, responseHeaders }
}

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const length =
    payload.length < 126
      ? Buffer.from([payload.length | 0x80])
      : Buffer.from([0xfe, payload.length >> 8, payload.length & 0xff])
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) {
    masked[i] = (payload.at(i) ?? 0) ^ (mask.at(i % 4) ?? 0)
  }
  return Buffer.concat([Buffer.from([0x81]), length, mask, masked])
}

interface WireFrame {
  rsv1: boolean
  opcode: number
  payload: Buffer
}

async function readWireFrame(reader: SocketReader): Promise<WireFrame> {
  const head = await reader.take(2)
  const first = head.at(0) ?? 0
  const second = head.at(1) ?? 0
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  if (length === 126) length = (await reader.take(2)).readUInt16BE(0)
  if (length === 127) length = Number((await reader.take(8)).readBigUInt64BE(0))
  const mask = masked ? await reader.take(4) : undefined
  const payload = await reader.take(length)
  if (mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (payload.at(i) ?? 0) ^ (mask.at(i % 4) ?? 0)
    }
  }
  return { rsv1: (first & 0x40) !== 0, opcode: first & 0x0f, payload }
}

function frameText(frame: WireFrame): string {
  if (!frame.rsv1) return frame.payload.toString()
  return inflateRawSync(Buffer.concat([frame.payload, Buffer.from([0, 0, 0xff, 0xff])]), {
    finishFlush: constants.Z_SYNC_FLUSH,
  }).toString()
}

async function frameOfType(
  socket: RawWebSocket,
  type: string,
): Promise<{
  frame: WireFrame
  text: string
}> {
  for (let i = 0; i < 40; i++) {
    const frame = await readWireFrame(socket.reader)
    if (frame.opcode !== 1) continue
    const text = frameText(frame)
    if ((JSON.parse(text) as { type?: string }).type === type) return { frame, text }
  }
  throw new Error(`did not receive a ${type} frame`)
}

describe('transport compression on real Bun wires', () => {
  let stateDir: string
  let server: ServerHandle

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-transport-compression-'))
    process.env.PODIUM_STATE_DIR = stateDir
    const webDir = join(stateDir, 'web')
    const mobileDir = join(stateDir, 'mobile')
    const artifactDir = join(stateDir, 'artifacts', 'proof-issue', 'proof-artifact')
    mkdirSync(webDir, { recursive: true })
    mkdirSync(mobileDir, { recursive: true })
    mkdirSync(artifactDir, { recursive: true })
    const desktopHtml = `<html><body>desktop-wire-proof${LARGE_TEXT}</body></html>`
    const mobileHtml = `<html><body>mobile-wire-proof${LARGE_TEXT}</body></html>`
    writeFileSync(join(webDir, 'index.html'), desktopHtml)
    writeFileSync(join(webDir, 'index.html.gz'), gzipSync(desktopHtml))
    writeFileSync(join(mobileDir, 'index.html'), mobileHtml)
    writeFileSync(join(mobileDir, 'index.html.gz'), gzipSync(mobileHtml))
    writeFileSync(join(artifactDir, 'proof.txt'), LARGE_TEXT)
    writeFileSync(join(artifactDir, 'proof.png'), new Uint8Array(64 * 1024).fill(0x89))
    process.env.PODIUM_WEB_DIR = webDir
    process.env.PODIUM_MOBILE_WEB_DIR = mobileDir
    server = await startServer({
      port: 0,
      plugins: [
        {
          name: 'transport-wire-proof',
          register: ({ hono }) => {
            hono.get(
              '/transport-proof/json',
              () => new Response(LARGE_JSON, { headers: { 'content-type': 'application/json' } }),
            )
            hono.get(
              '/transport-proof/image',
              () =>
                new Response(new Uint8Array(64 * 1024).fill(0x89), {
                  headers: { 'content-type': 'image/png' },
                }),
            )
            hono.get(
              '/transport-proof/tiny',
              () => new Response('tiny', { headers: { 'content-type': 'text/plain' } }),
            )
          },
        },
      ],
    })
  })

  afterAll(async () => {
    await server.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorWebDir === undefined) delete process.env.PODIUM_WEB_DIR
    else process.env.PODIUM_WEB_DIR = priorWebDir
    if (priorMobileWebDir === undefined) delete process.env.PODIUM_MOBILE_WEB_DIR
    else process.env.PODIUM_MOBILE_WEB_DIR = priorMobileWebDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('serves encoded desktop/mobile shells and file text while preserving binary identity', async () => {
    const desktop = await rawHttp(server.port, '/')
    expect(desktop.headers.get('content-encoding')).toBe('gzip')
    const desktopDecoded = gunzipSync(desktop.body)
    expect(desktopDecoded.toString()).toContain('desktop-wire-proof')

    const mobile = await rawHttp(server.port, '/mobile/')
    expect(mobile.headers.get('content-encoding')).toBe('gzip')
    const mobileDecoded = gunzipSync(mobile.body)
    expect(mobileDecoded.toString()).toContain('mobile-wire-proof')

    const text = await rawHttp(server.port, '/files/artifact/proof-issue/proof-artifact/proof.txt')
    expect(text.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(text.body).toString()).toBe(LARGE_TEXT)

    const image = await rawHttp(server.port, '/files/artifact/proof-issue/proof-artifact/proof.png')
    expect(image.headers.get('content-encoding')).toBeUndefined()
    expect(image.body).toHaveLength(64 * 1024)
    console.info(
      `[transport-wire] static desktop=${desktop.body.length}/${desktopDecoded.length} mobile=${mobile.body.length}/${mobileDecoded.length} artifact-text=${text.body.length}/${Buffer.byteLength(LARGE_TEXT)} artifact-png=${image.body.length}/${image.body.length}`,
    )
  })

  it('emits gzip bytes for dynamic JSON and identity bytes for tiny/precompressed HTTP data', async () => {
    const cpuStart = process.cpuUsage()
    const wallStart = performance.now()
    const json = await rawHttp(server.port, '/transport-proof/json')
    const cpu = process.cpuUsage(cpuStart)
    expect(json.status).toBe(200)
    expect(json.headers.get('content-encoding')).toBe('gzip')
    expect(json.headers.get('vary')).toContain('Accept-Encoding')
    expect(gunzipSync(json.body).toString()).toBe(LARGE_JSON)
    expect(json.body.length).toBeLessThan(Buffer.byteLength(LARGE_JSON) / 4)

    const tiny = await rawHttp(server.port, '/transport-proof/tiny')
    expect(tiny.headers.get('content-encoding')).toBeUndefined()
    expect(tiny.body.toString()).toBe('tiny')

    const image = await rawHttp(server.port, '/transport-proof/image')
    expect(image.headers.get('content-encoding')).toBeUndefined()
    expect(image.body).toHaveLength(64 * 1024)
    console.info(
      `[transport-wire] dynamic-json=${json.body.length}/${Buffer.byteLength(LARGE_JSON)} cpu=${((cpu.user + cpu.system) / 1_000).toFixed(2)}ms wall=${(performance.now() - wallStart).toFixed(2)}ms`,
    )
  })

  it('negotiates and selects compression per frame on the authenticated daemon wire', async () => {
    const daemon = await openRawWebSocket(server.port, '/daemon')
    expect(daemon.responseHeaders.get('sec-websocket-extensions')).toContain('permessage-deflate')
    const machineId = server.registry.modules.machines.hostMachineId
    daemon.socket.write(
      maskedTextFrame(
        JSON.stringify({
          type: 'hello',
          machineId,
          token: server.bootstrapToken,
          hostname: 'transport-proof',
        }),
      ),
    )
    const hello = await frameOfType(daemon, 'helloOk')
    expect(hello.frame.rsv1).toBe(false)

    const sendCpuStart = process.cpuUsage()
    server.registry.modules.machines.toMachine(machineId, {
      type: 'imageUploadRequest',
      requestId: 'precompressed-proof',
      sessionId: asSessionId(randomUUID()),
      filename: 'proof.png',
      mimeType: 'image/png',
      dataBase64: 'A'.repeat(16 * 1024),
    })
    const image = await frameOfType(daemon, 'imageUploadRequest')
    expect(image.frame.rsv1).toBe(false)

    server.registry.modules.machines.toMachine(machineId, {
      type: 'serverTransferChunkRequest',
      requestId: 'text-proof',
      transferId: randomUUID(),
      path: 'transport-proof.txt',
      offset: 0,
      data: LARGE_TEXT,
    })
    const sendCpu = process.cpuUsage(sendCpuStart)
    const text = await frameOfType(daemon, 'serverTransferChunkRequest')
    expect(text.frame.rsv1).toBe(true)
    expect(text.text).toContain(LARGE_TEXT)
    expect(text.frame.payload.length).toBeLessThan(Buffer.byteLength(text.text) / 10)
    console.info(
      `[transport-wire] daemon-frame=${text.frame.payload.length}/${Buffer.byteLength(text.text)} send-cpu=${((sendCpu.user + sendCpu.system) / 1_000).toFixed(2)}ms`,
    )
    daemon.socket.destroy()
  })

  it('compresses large human-client publications but leaves tiny realtime control identity', async () => {
    const machineId = server.registry.modules.machines.hostMachineId
    const discardDaemonControl = (): void => {}
    server.registry.gateway.attachDaemon(machineId, discardDaemonControl)

    const bootstrapClient = await openRawWebSocket(server.port, '/client')
    bootstrapClient.socket.write(
      maskedTextFrame(
        JSON.stringify({
          type: 'hello',
          clientId: '',
          viewport: { cols: 80, rows: 24, dpr: 1 },
          caps: [CAP_METADATA_DELTA],
          wireVersion: WIRE_VERSION,
        }),
      ),
    )
    const bootstrap = await frameOfType(bootstrapClient, 'feedBootstrap')
    expect(bootstrap.frame.rsv1).toBe(false)
    bootstrapClient.socket.destroy()

    const client = await openRawWebSocket(server.port, '/client')
    expect(client.responseHeaders.get('sec-websocket-extensions')).toContain('permessage-deflate')
    const initial = await frameOfType(client, 'sessionsChanged')
    const initialCount = (JSON.parse(initial.text) as { sessions: unknown[] }).sessions.length

    for (let i = 0; i < 12; i++) {
      server.registry.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: `/transport-proof/${i}/${'repeated-path/'.repeat(60)}`,
        machineId,
      })
    }
    server.registry.modules.sessions.flushBroadcasts()

    const publication = await frameOfType(client, 'sessionsChanged')
    expect(publication.frame.rsv1).toBe(true)
    expect((JSON.parse(publication.text) as { sessions: unknown[] }).sessions).toHaveLength(
      initialCount + 12,
    )
    expect(publication.frame.payload.length).toBeLessThan(
      (Buffer.byteLength(publication.text) * 3) / 4,
    )
    console.info(
      `[transport-wire] client-frame=${publication.frame.payload.length}/${Buffer.byteLength(publication.text)}`,
    )

    client.socket.write(maskedTextFrame(JSON.stringify({ type: 'ping' })))
    const pong = await frameOfType(client, 'pong')
    expect(pong.frame.rsv1).toBe(false)
    server.registry.gateway.detachDaemon(machineId, discardDaemonControl)
    client.socket.destroy()
  })
})
