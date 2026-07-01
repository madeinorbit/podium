import { createServer, type Server } from 'node:http'
import type { DaemonMessage } from '@podium/protocol'

export interface IssueRelayRequest {
  sessionId: string
  router: string
  proc: string
  input?: unknown
  outsideScope?: boolean
}

export interface IssueRelayResult {
  ok: boolean
  result?: unknown
  error?: string
}

export interface IssueRelayHub {
  relay(req: IssueRelayRequest): Promise<IssueRelayResult>
  onResult(msg: { requestId: string; ok: boolean; result?: unknown; error?: string }): void
  pendingCount(): number
}

/** Correlates daemon-initiated issue-relay requests with the server's results. Mirrors the
 *  server's daemonRequest pattern, but here the DAEMON initiates. Resolve-once, timeout-safe. */
export function createIssueRelayHub(
  send: (msg: DaemonMessage) => void,
  opts?: { timeoutMs?: number },
): IssueRelayHub {
  const timeoutMs = opts?.timeoutMs ?? 30_000
  const pending = new Map<string, (r: IssueRelayResult) => void>()
  let seq = 0
  return {
    relay(req) {
      const requestId = `ir${seq++}`
      return new Promise<IssueRelayResult>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(requestId)) resolve({ ok: false, error: 'issue relay timed out' })
        }, timeoutMs)
        timer.unref?.()
        pending.set(requestId, (r) => {
          clearTimeout(timer)
          resolve(r)
        })
        send({
          type: 'issueRelayRequest',
          requestId,
          sessionId: req.sessionId,
          router: req.router,
          proc: req.proc,
          ...(req.input !== undefined ? { input: req.input } : {}),
          ...(req.outsideScope ? { outsideScope: true } : {}),
        })
      })
    },
    onResult(msg) {
      const resolve = pending.get(msg.requestId)
      if (!resolve) return // unknown / duplicate / late — ignore
      pending.delete(msg.requestId)
      resolve({
        ok: msg.ok,
        ...(msg.result !== undefined ? { result: msg.result } : {}),
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      })
    },
    pendingCount: () => pending.size,
  }
}

/**
 * Fixed default port, mirroring the hook ingest. The port is injected into an
 * agent's environment at spawn (Task 3) so its `podium issue` CLI can POST here;
 * on a daemon restart we must come back on the same port or already-running
 * agents post into the void. Ephemeral fallback on EADDRINUSE keeps new spawns
 * working even if the port is taken.
 */
export const DEFAULT_ISSUE_RELAY_PORT = 45778

/**
 * Hard cap on a relay request body. The port is reachable by every spawned
 * agent, so a misbehaving/compromised one could POST an arbitrarily large body
 * and OOM/block the daemon. Real issue payloads are small JSON; 1 MB is generous.
 */
const RELAY_BODY_MAX_BYTES = 1 * 1024 * 1024

/**
 * Loopback HTTP server an agent's `podium issue` CLI posts to. Unlike the hook
 * ingest (which acks 200 immediately — Podium only observes hook lifecycle),
 * this AWAITS `relay` before responding: the CLI blocks on the round-trip to the
 * server so the agent sees the actual tracker result.
 *
 * `POST /issue/<sessionId>` with JSON `{ router?, proc, input?, outsideScope? }`
 * → `200 { ok, result?|error? }`. Any other method/path → 404; bad JSON or a
 * missing `proc` → 400; over-cap body → 413. `router` defaults to `'issues'`.
 */
export function startIssueRelayServer(opts: {
  relay: (req: IssueRelayRequest) => Promise<IssueRelayResult>
  /** Preferred port; pass 0 for ephemeral (tests). Defaults to DEFAULT_ISSUE_RELAY_PORT. */
  port?: number
}): Promise<{ port: number; endpointFor(sessionId: string): string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const match = /^\/issue\/([\w.-]+)$/.exec(req.url ?? '')
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
      if (total > RELAY_BODY_MAX_BYTES) {
        aborted = true
        res.writeHead(413)
        res.end()
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      let body: { router?: string; proc?: string; input?: unknown; outsideScope?: boolean }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
        return
      }
      if (!body.proc) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing proc' }))
        return
      }
      void opts
        .relay({
          sessionId,
          router: body.router ?? 'issues',
          proc: body.proc,
          input: body.input,
          outsideScope: body.outsideScope,
        })
        .then((r) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(r))
        })
        .catch((err) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          )
        })
    })
  })

  const preferred = opts.port ?? DEFAULT_ISSUE_RELAY_PORT
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('issue relay: no port'))
        return
      }
      resolve({
        port: addr.port,
        endpointFor: (sessionId) => `http://127.0.0.1:${addr.port}/issue/${sessionId}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    }
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferred !== 0) {
        console.warn(`[podium] issue-relay port ${preferred} in use — falling back to ephemeral`)
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
