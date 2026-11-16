/**
 * THE LOOPBACK LISTENER FOR SIGN IN WITH CHATGPT (credential management §11;
 * epic Task 14).
 *
 * OpenAI sends the browser back to `http://127.0.0.1:<port>/auth/callback`,
 * which is this computer when the person signs in here. The server asks this
 * daemon to listen there (`oauthLoopbackRequest`); the first request on the
 * callback path is relayed to the server as `oauthLoopbackCallback`, with the
 * query's `code`, `state`, issued `client_id`, `scope` or `error` and nothing
 * else, and the browser is told to return to Podium. The server exchanges the
 * code; no token ever reaches this daemon.
 *
 * One listener per port: a newer request for the same port replaces the older
 * one. A listener closes at its first callback or when its time is up. The
 * code is never logged.
 */

import { createServer, type Server } from 'node:http'
import type { OauthLoopbackRequestMessage } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'

type Send = (msg: DaemonMessage) => void

interface Listener {
  requestId: string
  server: Server
  timer: ReturnType<typeof setTimeout>
}

const listeners = new Map<number, Listener>()

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>' +
  `</head><body><h1>${title}</h1><p>${body}</p></body></html>`

const DONE_PAGE = PAGE(
  'Return to Podium',
  'Podium received your sign-in and is finishing it. You can close this tab and return to Podium.',
)

const CALLBACK_FIELDS = [
  ['code', 'code', 4096],
  ['state', 'state', 512],
  ['client_id', 'clientId', 256],
  ['scope', 'scope', 1024],
  ['error', 'error', 128],
  ['error_description', 'errorDescription', 1024],
] as const

function close(port: number, requestId?: string): void {
  const listener = listeners.get(port)
  if (!listener || (requestId !== undefined && listener.requestId !== requestId)) return
  listeners.delete(port)
  clearTimeout(listener.timer)
  listener.server.close()
  listener.server.closeAllConnections?.()
}

/** Listen for one OAuth callback on `127.0.0.1:<port>`, answering the request at once. */
export async function startOauthLoopback(
  msg: OauthLoopbackRequestMessage,
  send: Send,
): Promise<void> {
  close(msg.port)
  let relayed = false
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const query = url.searchParams
    if (
      relayed ||
      req.method !== 'GET' ||
      url.pathname !== msg.path ||
      (!query.has('state') && !query.has('error'))
    ) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    relayed = true
    const fields: Record<string, string> = {}
    for (const [param, key, max] of CALLBACK_FIELDS) {
      const value = query.get(param)
      if (value) fields[key] = value.slice(0, max)
    }
    send({ type: 'oauthLoopbackCallback', requestId: msg.requestId, ...fields })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(DONE_PAGE, () => close(msg.port, msg.requestId))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(msg.port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    send({
      type: 'oauthLoopbackResult',
      requestId: msg.requestId,
      listening: false,
      error:
        code === 'EADDRINUSE'
          ? `Port ${msg.port} on this machine is in use by another program.`
          : `This machine could not listen on port ${msg.port} (${code ?? 'error'}).`,
    })
    return
  }
  const timer = setTimeout(() => close(msg.port, msg.requestId), msg.ttlMs)
  timer.unref?.()
  listeners.set(msg.port, { requestId: msg.requestId, server, timer })
  send({ type: 'oauthLoopbackResult', requestId: msg.requestId, listening: true })
}

/** Close every listener (daemon shutdown, tests). */
export function closeOauthLoopbacks(): void {
  for (const port of [...listeners.keys()]) close(port)
}
