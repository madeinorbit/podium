import { createServer, type Server } from 'node:http'

/**
 * Receives Claude Code `type: "http"` hook POSTs at /hooks/<podiumSessionId>.
 * The path segment is OUR session id (baked into the per-session settings file
 * at spawn), which is how harness events correlate to Podium sessions without
 * trusting the payload.
 *
 * By default acks 200 {} without steering: hooks run inline in the agent's
 * lifecycle, and Podium must observe, never delay. An optional `respondTo` may
 * return injected context as the body, but it is strictly bounded by a timeout
 * so the agent is never held past it.
 */
export interface HookIngest {
  port: number
  endpointFor(sessionId: string): string
  close(): Promise<void>
}

/**
 * Default is a FIXED, instance-owned port, not ephemeral: hook URLs live in settings files of
 * durable (abduco/tmux) sessions that outlive this process. A daemon restart
 * must come back on the same port or surviving agents post into the void.
 */
export const DEFAULT_HOOK_PORT = 45777

/**
 * Hard cap on a hook request body. The hook port is baked into every spawned
 * agent's settings file, so a misbehaving/compromised agent could POST an
 * arbitrarily large body and OOM/block the daemon. Real hook payloads are small
 * JSON, so 2 MB is generous; anything over is rejected with 413 before parsing.
 */
export const HOOK_BODY_MAX_BYTES = 2 * 1024 * 1024

export function startHookIngest(opts: {
  onPayload: (sessionId: string, payload: unknown) => void
  /** Preferred port; pass 0 for ephemeral (tests). Defaults to DEFAULT_HOOK_PORT. */
  port?: number
  /**
   * Optional bounded response. When provided, the resolved JSON string is sent
   * as the hook response body (Claude Code reads it as e.g. additionalContext);
   * `null`/timeout/throw all fall back to `'{}'`. `onPayload` still fires for
   * every request. Absent → behaves exactly as before (immediate `'{}'`).
   */
  respondTo?: (sessionId: string, payload: unknown) => Promise<string | null>
  /** Max time to await `respondTo` before falling back to `'{}'`. Default 3000. */
  respondTimeoutMs?: number
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
    let total = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      if (aborted) return
      total += c.length
      if (total > HOOK_BODY_MAX_BYTES) {
        // Over the cap: reject without parsing and stop buffering. Drop what we
        // have so a late chunk can't re-trigger onPayload, and tear down the
        // request so a hostile sender can't keep streaming into the daemon.
        aborted = true
        chunks.length = 0
        res.writeHead(413)
        res.end()
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      let payload: unknown
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      // State tracking always fires, fire-and-forget (never blocks the agent).
      try {
        opts.onPayload(sessionId, payload)
      } catch {
        // observer must never throw into the response path
      }
      if (!opts.respondTo) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      // Optional bounded response: await respondTo, but never delay the agent past the timeout.
      const timeoutMs = opts.respondTimeoutMs ?? 3000
      let settled = false
      const finish = (bodyText: string): void => {
        if (settled) return
        settled = true
        try {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(bodyText)
        } catch {
          // The client (agent) may have disconnected during the respondTo await
          // window; a late write onto a destroyed socket throws. Nothing to send,
          // so swallow it — the settled guard still prevents any double-send.
        }
      }
      const timer = setTimeout(() => finish('{}'), timeoutMs)
      timer.unref?.()
      // A client disconnect mid-await cancels the pending response so the
      // timer/promise callback becomes a no-op instead of writing to a closed
      // socket (which would otherwise throw uncaught out of the timer callback).
      res.on('close', () => {
        settled = true
        clearTimeout(timer)
      })
      Promise.resolve()
        .then(() => opts.respondTo!(sessionId, payload))
        .then((body) => {
          clearTimeout(timer)
          finish(typeof body === 'string' && body.length > 0 ? body : '{}')
        })
        .catch(() => {
          clearTimeout(timer)
          finish('{}')
        })
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
    server.once('error', reject)
    server.listen(preferred, '127.0.0.1', finish)
  })
}
