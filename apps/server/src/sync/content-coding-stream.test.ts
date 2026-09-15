import { connect } from 'node:net'
import { expect, it } from 'vitest'
import { pipeSyncBody } from './pipe-sync-body'
import { syncResponseHeaders } from './content-coding'
import { compressHttpResponse } from '../response-compression'

it.each(['identity', 'gzip', 'zstd'] as const)('streams %s through HTTP fetch and raw TCP', async (coding) => {
  let secondProduced = false
  const text = '{"type":"first"}\n{"type":"second"}\n'
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      async function* source() {
        yield new TextEncoder().encode('{"type":"first"}\n')
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
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(secondProduced).toBe(false)
    let result = new TextDecoder().decode(first.value)
    while (true) {
      const next = await reader.read()
      if (next.done) break
      result += new TextDecoder().decode(next.value)
    }
    expect(result).toBe(text)
    secondProduced = false
    await new Promise<void>((resolve, reject) => {
      let received = Buffer.alloc(0)
      let sawEarlyBody = false
      const socket = connect(server.port!, '127.0.0.1', () => {
        socket.write(`GET /sync/delta HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${coding}\r\nConnection: close\r\n\r\n`)
      })
      socket.setTimeout(3000, () => socket.destroy(new Error('TCP timeout')))
      socket.on('error', reject)
      socket.on('data', (data) => {
        received = Buffer.concat([received, data])
        const boundary = received.indexOf('\r\n\r\n')
        if (boundary >= 0 && received.length > boundary + 4 && !secondProduced) sawEarlyBody = true
      })
      socket.on('end', () => {
        try { expect(sawEarlyBody).toBe(true); resolve() } catch (error) { reject(error) }
      })
    })
  } finally { await server.stop(true) }
}, 10000)
