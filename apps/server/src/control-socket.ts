/**
 * THE SERVER'S CONTROL SOCKET: where a local program asks this server to do
 * something (POD-4640).
 *
 * A user-only unix socket (packages/runtime/src/user-socket.ts): the kernel lets
 * only this OS user connect, so there is no token, and nothing that forwards
 * network traffic to 127.0.0.1 — a Cloudflare tunnel, for one — can reach it.
 * It deliberately answers a SHORT list of routes rather than the whole tRPC
 * surface; each one is a thing a local program needs and a human never types.
 *
 *   POST /v1/public-url   {"url": "...", "confirmUrlChange": true?}
 *       Record this server's public URL and tell Podium Connect at once. The
 *       quick-tunnel utility calls it with each new trycloudflare URL.
 *       200 {"ok":true,"publicUrl":"...","changed":bool}
 *       400 {"ok":false,"error":"..."}   not a URL, or not JSON
 *       409 {"ok":false,"error":"..."}   refused: PODIUM_PUBLIC_URL owns it, this
 *                                        box is not a server, or a different live
 *                                        URL without confirmUrlChange
 *
 * Every other method or path is a 404, and a body over 4 KiB a 413.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { ApplyPublicUrlResult } from '@podium/runtime/setup'

export const CONTROL_BODY_MAX_BYTES = 4_096

export interface ControlSocketDeps {
  /** Write the public URL; the caller prods the Connect publisher when it changed. */
  setPublicUrl(url: string, opts: { confirmUrlChange: boolean }): ApplyPublicUrlResult
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > CONTROL_BODY_MAX_BYTES) {
        over = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(over ? 'too-large' : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function controlSocketHandler(deps: ControlSocketDeps): RequestListener {
  return (req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/v1/public-url') {
        reply(res, 404, { ok: false, error: 'not found' })
        return
      }
      const body = await readBody(req)
      if (body === 'too-large') {
        reply(res, 413, { ok: false, error: `body over ${CONTROL_BODY_MAX_BYTES} bytes` })
        return
      }
      let input: { url?: unknown; confirmUrlChange?: unknown }
      try {
        input = JSON.parse(body) as typeof input
      } catch {
        reply(res, 400, { ok: false, error: 'body is not JSON' })
        return
      }
      if (typeof input !== 'object' || input === null || typeof input.url !== 'string') {
        reply(res, 400, { ok: false, error: 'expected {"url": string}' })
        return
      }
      const result = deps.setPublicUrl(input.url, {
        confirmUrlChange: input.confirmUrlChange === true,
      })
      if (result.ok) {
        reply(res, 200, { ok: true, publicUrl: result.publicUrl, changed: result.changed })
      } else {
        reply(res, result.reason === 'invalid' ? 400 : 409, { ok: false, error: result.error })
      }
    })().catch((error: unknown) => {
      if (!res.headersSent) reply(res, 500, { ok: false, error: (error as Error).message })
    })
  }
}
