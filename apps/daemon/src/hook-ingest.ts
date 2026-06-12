import { createServer, type Server } from 'node:http'

/**
 * Receives Claude Code `type: "http"` hook POSTs at /hooks/<podiumSessionId>.
 * The path segment is OUR session id (baked into the per-session settings file
 * at spawn), which is how harness events correlate to Podium sessions without
 * trusting the payload.
 *
 * Always acks 200 {} immediately, before the payload is even parsed: hooks run
 * inline in the agent's lifecycle, and Podium must observe, never delay or steer.
 */
export interface HookIngest {
  port: number
  endpointFor(sessionId: string): string
  close(): Promise<void>
}

/**
 * Default is a FIXED port, not ephemeral: hook URLs live in settings files of
 * durable (abduco/tmux) sessions that outlive this process. A daemon restart
 * must come back on the same port or surviving agents post into the void.
 */
export const DEFAULT_HOOK_PORT = 45777

export function startHookIngest(opts: {
  onPayload: (sessionId: string, payload: unknown) => void
  /** Preferred port; pass 0 for ephemeral (tests). Defaults to DEFAULT_HOOK_PORT. */
  port?: number
}): Promise<HookIngest> {
  const server: Server = createServer((req, res) => {
    const match = /^\/hooks\/([\w.-]+)$/.exec(req.url ?? '')
    if (!match || req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    const sessionId = match[1] as string
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      try {
        opts.onPayload(sessionId, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        // malformed body — already acked; drop
      }
    })
  })

  const preferred = opts.port ?? DEFAULT_HOOK_PORT
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('hook ingest: no port'))
        return
      }
      resolve({
        port: addr.port,
        endpointFor: (sessionId) => `http://127.0.0.1:${addr.port}/hooks/${sessionId}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    }
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferred !== 0) {
        // Degraded mode: pre-restart durable sessions keep posting to the old
        // port and lose state reporting, but new spawns work.
        console.warn(`[podium] hook port ${preferred} in use — falling back to an ephemeral port`)
        server.removeAllListeners('error')
        server.once('error', reject)
        server.listen(0, '127.0.0.1', finish)
        return
      }
      reject(err)
    })
    server.listen(preferred, '127.0.0.1', finish)
  })
}
