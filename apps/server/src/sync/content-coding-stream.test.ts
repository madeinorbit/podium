import { connect } from 'node:net'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { expect, it } from 'vitest'
import { pipeSyncBody } from './pipe-sync-body'
import { syncResponseHeaders } from './content-coding'
import { compressHttpResponse } from '../response-compression'

const runtime = globalThis as typeof globalThis & {
  Bun: { serve(options: { hostname: string; port: number; fetch(request: Request): Promise<Response> }): { port: number; stop(force: boolean): void | Promise<void> } }
}

it.each(['identity', 'gzip', 'zstd'] as const)('streams %s through HTTP fetch and raw TCP', async (coding) => {
  let secondProduced = false
  const firstLine = '{"type":"first"}\n'
  const text = firstLine + '{"type":"second"}\n'
  const server = runtime.Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      async function* source() {
        yield new TextEncoder().encode(firstLine)
        await new Promise((resolve) => setTimeout(resolve, 100))
        secondProduced = true
        yield new TextEncoder().encode('{"type":"second"}\n')
      }
      const response = new Response(pipeSyncBody(source(), coding, request.signal), { headers: syncResponseHeaders(coding) })
      expect(await compressHttpResponse(request, response)).toBe(response)
      return response
    },
  })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/sync/delta`, { headers: { 'accept-encoding': coding } })
    // Bun 1.3.14 auto-decodes correctly, but buffers decoded tiny compressed
    // responses. The raw peer below establishes latency for the actual line.
    expect(await response.text()).toBe(text)
    secondProduced = false
    await new Promise<void>((resolve, reject) => {
      let received = Buffer.alloc(0)
      let headersRead = false
      let decoded = ''
      let sawEarlyLine = false
      const decoder = coding === 'gzip' ? createGunzip() : coding === 'zstd' ? createZstdDecompress() : null
      const consume = (bytes: Uint8Array) => {
        decoded += Buffer.from(bytes).toString('utf8')
        if (decoded.includes(firstLine) && !secondProduced) sawEarlyLine = true
      }
      const socket = connect(server.port, '127.0.0.1', () => {
        socket.write(`GET /sync/delta HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${coding}\r\nConnection: close\r\n\r\n`)
      })
      const fail = (error: unknown) => { socket.destroy(); decoder?.destroy(); reject(error) }
      const finish = () => {
        try {
          expect(sawEarlyLine).toBe(true)
          expect(decoded).toBe(text)
          socket.destroy()
          resolve()
        } catch (error) { fail(error) }
      }
      decoder?.on('data', consume)
      decoder?.on('end', finish)
      decoder?.on('error', fail)
      socket.setTimeout(3000, () => fail(new Error('TCP timeout')))
      socket.on('error', fail)
      socket.on('data', (data) => {
        try {
          received = Buffer.concat([received, typeof data === 'string' ? Buffer.from(data) : data])
          if (!headersRead) {
            const boundary = received.indexOf('\r\n\r\n')
            if (boundary < 0) return
            expect(received.subarray(0, boundary).toString().toLowerCase()).toContain('transfer-encoding: chunked')
            received = received.subarray(boundary + 4)
            headersRead = true
          }
          while (true) {
            const end = received.indexOf('\r\n')
            if (end < 0) return
            const length = Number.parseInt(received.subarray(0, end).toString(), 16)
            if (received.length < end + 2 + length + 2) return
            if (length === 0) {
              if (decoder) decoder.end()
              else finish()
              return
            }
            const chunk = received.subarray(end + 2, end + 2 + length)
            if (decoder) decoder.write(chunk)
            else consume(chunk)
            received = received.subarray(end + 2 + length + 2)
          }
        } catch (error) { fail(error) }
      })
    })
  } finally { await server.stop(true) }
}, 10000)
