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
 *   GET  /v1/login-password
 *       Whether this instance's first admin has a login password yet.
 *       200 {"ok":true,"set":bool}
 *
 *   POST /v1/login-password   {"password": "..."}
 *       Set the first admin's login password on the RUNNING server (POD-3274).
 *       `podium setup` calls it: a password staged in auth.json is only read by
 *       a first boot, so it could neither be set while setup checks the address
 *       nor changed later. Stored as typed, never trimmed (POD-1148).
 *       200 {"ok":true}
 *       400 {"ok":false,"error":"..."}   empty, or not JSON
 *       409 {"ok":false,"error":"..."}   no admin account to hold it
 *
 * Every other method or path is a 404, and a body over 4 KiB a 413.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { ApplyPublicUrlResult } from '@podium/runtime/setup'
import { TunnelHealthReport } from '@podium/runtime/tunnel-health'

export const CONTROL_BODY_MAX_BYTES = 4_096

export interface ControlSocketDeps {
  /** Write the public URL; the caller prods the Connect publisher when it changed. */
  tunnelHealth?: (report: TunnelHealthReport) => void
  diagnostics?: () => unknown
  publishConnect?: () => void
  setPublicUrl(url: string, opts: { confirmUrlChange: boolean }): ApplyPublicUrlResult
  /** The first admin's login password: whether one is set, and setting it. */
  loginPassword?: {
    isSet(): Promise<boolean>
    set(password: string): Promise<{ ok: true } | { ok: false; error: string }>
  }
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

async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const body = await readBody(req)
  if (body === 'too-large') {
    reply(res, 413, { ok: false, error: `body over ${CONTROL_BODY_MAX_BYTES} bytes` })
    return undefined
  }
  let input: unknown
  try {
    input = JSON.parse(body)
  } catch {
    reply(res, 400, { ok: false, error: 'body is not JSON' })
    return undefined
  }
  if (typeof input !== 'object' || input === null) {
    reply(res, 400, { ok: false, error: 'expected a JSON object' })
    return undefined
  }
  return input as Record<string, unknown>
}

export function controlSocketHandler(deps: ControlSocketDeps): RequestListener {
  return (req, res) => {
    void (async () => {
      if (req.url === '/v1/login-password' && deps.loginPassword) {
        if (req.method === 'GET') {
          reply(res, 200, { ok: true, set: await deps.loginPassword.isSet() })
          return
        }
        if (req.method === 'POST') {
          const input = await readJson(req, res)
          if (!input) return
          if (typeof input.password !== 'string' || input.password.trim() === '') {
            reply(res, 400, { ok: false, error: 'expected {"password": non-empty string}' })
            return
          }
          const result = await deps.loginPassword.set(input.password)
          if (result.ok) reply(res, 200, { ok: true })
          else reply(res, 409, { ok: false, error: result.error })
          return
        }
      }
      if (req.method === 'GET' && req.url === '/v1/diagnostics' && deps.diagnostics) {
        reply(res, 200, deps.diagnostics())
        return
      }
      const route = req.url
      if (
        req.method !== 'POST' ||
        !['/v1/public-url', '/v1/tunnel-health', '/v1/connect-publish'].includes(route ?? '')
      ) {
        reply(res, 404, { ok: false, error: 'not found' })
        return
      }
      const input = await readJson(req, res)
      if (!input) return
      if (route === '/v1/tunnel-health') {
        const report = TunnelHealthReport.safeParse(input)
        if (!report.success) {
          reply(res, 400, { ok: false, error: 'Invalid tunnel health report.' })
          return
        }
        if (!deps.tunnelHealth) {
          reply(res, 503, { ok: false, error: 'Tunnel health is unavailable.' })
          return
        }
        deps.tunnelHealth(report.data)
        reply(res, 200, { ok: true })
        return
      }
      if (route === '/v1/connect-publish') {
        if (!deps.publishConnect) {
          reply(res, 503, { ok: false, error: 'Connect publishing is unavailable.' })
          return
        }
        deps.publishConnect()
        reply(res, 200, { ok: true })
        return
      }
      if (typeof input.url !== 'string') {
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
