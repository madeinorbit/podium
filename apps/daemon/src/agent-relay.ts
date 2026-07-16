import { createServer, type Server } from 'node:http'
import type { DaemonMessage } from '@podium/protocol'

export interface AgentRelayRequest {
  sessionId: string
  router: string
  proc: string
  input?: unknown
  outsideScope?: boolean
}

export interface AgentRelayResult {
  ok: boolean
  result?: unknown
  error?: string
}

export interface AgentRelayHub {
  relay(req: AgentRelayRequest): Promise<AgentRelayResult>
  onResult(msg: { requestId: string; ok: boolean; result?: unknown; error?: string }): void
  pendingCount(): number
}

/** Correlates daemon-initiated agent-relay requests with the server's results. Mirrors the
 *  server's daemonRequest pattern, but here the DAEMON initiates. Resolve-once, timeout-safe. */
export function createAgentRelayHub(
  send: (msg: DaemonMessage) => void,
  opts?: { timeoutMs?: number },
): AgentRelayHub {
  const timeoutMs = opts?.timeoutMs ?? 30_000
  const pending = new Map<string, (r: AgentRelayResult) => void>()
  let seq = 0
  return {
    relay(req) {
      const requestId = `ir${seq++}`
      return new Promise<AgentRelayResult>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(requestId)) resolve({ ok: false, error: 'agent relay timed out' })
        }, timeoutMs)
        timer.unref?.()
        pending.set(requestId, (r) => {
          clearTimeout(timer)
          resolve(r)
        })
        send({
          type: 'agentRelayRequest',
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
 * agent's environment at spawn (Task 3) so its `podium` CLI can POST here;
 * on a daemon restart we must come back on the same port or already-running
 * agents post into the void. Bind conflicts fail startup so no session can be
 * silently routed to another daemon;
 * ephemeral port 0 remains available when tests request it explicitly.
 */
export const DEFAULT_AGENT_RELAY_PORT = 45778

/**
 * Hard cap on a relay request body. The port is reachable by every spawned
 * agent, so a misbehaving/compromised one could POST an arbitrarily large body
 * and OOM/block the daemon. Real relay payloads are small JSON; 1 MB is generous.
 */
const RELAY_BODY_MAX_BYTES = 1 * 1024 * 1024

/**
 * Loopback HTTP server an agent's `podium` CLI posts to. Unlike the hook
 * ingest (which acks 200 immediately — Podium only observes hook lifecycle),
 * this AWAITS `relay` before responding: the CLI blocks on the round-trip to the
 * server so the agent sees the actual result.
 *
 * `POST /agent/<sessionId>` with JSON `{ router?, proc, input?, outsideScope? }`
 * → `200 { ok, result?|error? }`. The legacy `/issue/<sessionId>` path is still
 * accepted (read-side tolerance for sessions spawned before the rename — the
 * daemon never emits it). Any other method/path → 404; bad JSON or a missing
 * `proc` → 400; over-cap body → 413. `router` defaults to `'issues'`.
 *
 * TRUST MODEL: this endpoint is loopback-only (127.0.0.1) and UNAUTHENTICATED —
 * `sessionId` is taken from the URL path, so any local process can POST as any
 * session. The server still confines every relayed op to that session's
 * worker/subtree capability plus the RELAY_ALLOWED allowlist, but that subtree
 * scoping is a guardrail against accidental cross-scope edits by a well-behaved
 * agent, NOT a sandbox against a co-located adversary who can already forge any
 * sessionId. Hardening here is about not crashing/OOMing on hostile input.
 */
export function startAgentRelayServer(opts: {
  relay: (req: AgentRelayRequest) => Promise<AgentRelayResult>
  /** Preferred port; pass 0 for ephemeral (tests). Defaults to DEFAULT_AGENT_RELAY_PORT. */
  port?: number
}): Promise<{ port: number; endpointFor(sessionId: string): string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    // Accept both the new `/agent/<sid>` path and the legacy `/issue/<sid>` path:
    // an in-flight session spawned before the rename keeps POSTing to `/issue/`
    // after a daemon redeploy. Only `/agent/` is ever emitted (endpointFor).
    const match = /^\/(?:issue|agent)\/([\w.-]+)$/.exec(req.url ?? '')
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
        // Over the cap: drop what we've buffered (parity with hook-ingest) and tear
        // down the request so a hostile sender can't keep streaming into the daemon.
        aborted = true
        chunks.length = 0
        res.writeHead(413)
        res.end()
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
        return
      }
      // Any non-object body is rejected cleanly. Note `JSON.parse('null')` returns
      // `null` (and arrays/numbers/strings/booleans parse fine too) — dereferencing
      // those below would throw a TypeError inside this `end` listener → an
      // uncaughtException that exits the daemon (local crash-loop DoS). Guard first.
      const b = body as { router?: string; proc?: string; input?: unknown; outsideScope?: boolean }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof b.proc !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing proc' }))
        return
      }
      void opts
        .relay({
          sessionId,
          router: b.router ?? 'issues',
          proc: b.proc,
          input: b.input,
          outsideScope: b.outsideScope,
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

  const preferred = opts.port ?? DEFAULT_AGENT_RELAY_PORT
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('agent relay: no port'))
        return
      }
      resolve({
        port: addr.port,
        endpointFor: (sessionId) => `http://127.0.0.1:${addr.port}/agent/${sessionId}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    }
    server.once('error', reject)
    server.listen(preferred, '127.0.0.1', finish)
  })
}
