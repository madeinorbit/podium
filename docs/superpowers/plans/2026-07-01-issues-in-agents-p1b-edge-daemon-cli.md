# Issues in Agents — P1b-edge: Daemon Relay + CLI Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a launched agent's `podium issue <verb>` CLI to the P1b-server relay handler through its local daemon, so an agent gets a worker/subtree capability without ever holding server credentials. Adds: a daemon relay hub (request/response over the existing WS), a blocking loopback HTTP endpoint the CLI posts to, spawn-time env injection, and a CLI relay transport. Ends with an end-to-end check.

**Architecture:** `podium issue <verb>` (agent) → `POST http://127.0.0.1:<relayPort>/issue/<sessionId>` (local daemon) → daemon sends `issueRelayRequest` over its authed server WS → server `runIssueRelay` mints the capability + runs the op via `createCaller` (P1b-server) → `issueRelayResult` back → daemon resolves the blocked POST → CLI prints. The session id is baked into the endpoint URL at spawn (env-bound, never a CLI arg), so an agent can't assume another session's scope.

**Tech Stack:** TypeScript, Node `http`, `ws`, Zod, Vitest, Bun. Daemon: `apps/daemon/src/daemon.ts` + a new `apps/daemon/src/issue-relay.ts`. CLI: `scripts/issue-cli.ts` + `apps/server/src/issue-client.ts`. Protocol messages already exist (P1b-server): `IssueRelayRequestMessage` (daemon→server) / `IssueRelayResultMessage` (server→daemon).

## Global Constraints

- **Session id is env-bound, never CLI-overridable.** The daemon injects `PODIUM_SESSION_ID` and `PODIUM_ISSUE_RELAY` (a URL with the session id in its path) at spawn. The CLI reads the relay URL from env; it does NOT accept a `--session`/`--sessionId` flag. (Security: prevents an agent assuming another session's scope.)
- **Daemon dedup:** the relay hub keys pending requests by `requestId` and MUST ignore an unknown/duplicate/late `issueRelayResult` (resolve-once).
- **Loopback only + bounded:** the relay HTTP server binds `127.0.0.1`, caps request-body size like hook-ingest, and 404s any path but `POST /issue/<sessionId>`.
- **No server creds in agents.** The agent reaches only its local daemon; the daemon holds the one authed server connection.
- **Reuse P1b-server:** all authz/scoping is server-side; this plan adds no policy. The relay carries `{router, proc, input?, outsideScope?}`; the server allowlist (`issues.*` + `repos.inferFromPath`) already restricts it.
- **TDD, DRY, YAGNI, frequent commits. Live-source safety:** all work in worktree `issue/5-issues-in-agents`; never touch the `main` checkout. The daemon relay's default port must be FIXED (like `DEFAULT_HOOK_PORT`) so it survives a daemon restart, with an ephemeral fallback for tests.

---

### Task 1: Daemon relay hub (pending-map + dispatch)

**Files:**
- Create: `apps/daemon/src/issue-relay.ts`
- Test: `apps/daemon/src/issue-relay.test.ts`
- Modify: `apps/daemon/src/daemon.ts` (add the `issueRelayResult` dispatch case) — done in Step 5 of this task.

**Interfaces:**
- Consumes: `send: (msg: DaemonMessage) => void` (the daemon's existing outbound send); the `IssueRelay*` message types from `@podium/protocol`.
- Produces:
  - `createIssueRelayHub(send, opts?: { timeoutMs?: number }): IssueRelayHub`
  - `interface IssueRelayHub { relay(req: { sessionId: string; router: string; proc: string; input?: unknown; outsideScope?: boolean }): Promise<{ ok: boolean; result?: unknown; error?: string }>; onResult(msg: { requestId: string; ok: boolean; result?: unknown; error?: string }): void; pendingCount(): number }`

- [ ] **Step 1: Write the failing tests**

Create `apps/daemon/src/issue-relay.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createIssueRelayHub } from './issue-relay'

describe('issue relay hub', () => {
  it('sends an issueRelayRequest and resolves on the matching result', async () => {
    const sent: any[] = []
    const hub = createIssueRelayHub((m) => sent.push(m))
    const p = hub.relay({ sessionId: 's1', router: 'issues', proc: 'ready', input: { repoPath: '/r' } })
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('issueRelayRequest')
    expect(sent[0].sessionId).toBe('s1')
    expect(hub.pendingCount()).toBe(1)
    hub.onResult({ requestId: sent[0].requestId, ok: true, result: 'DATA' })
    expect(await p).toEqual({ ok: true, result: 'DATA' })
    expect(hub.pendingCount()).toBe(0)
  })

  it('ignores an unknown or duplicate/late result', async () => {
    const sent: any[] = []
    const hub = createIssueRelayHub((m) => sent.push(m))
    const p = hub.relay({ sessionId: 's1', router: 'issues', proc: 'ready' })
    hub.onResult({ requestId: 'nope', ok: true, result: 'x' }) // unknown → ignored
    hub.onResult({ requestId: sent[0].requestId, ok: false, error: 'boom' })
    const r = await p
    expect(r).toEqual({ ok: false, error: 'boom' })
    hub.onResult({ requestId: sent[0].requestId, ok: true, result: 'late' }) // late → no throw, no effect
    expect(hub.pendingCount()).toBe(0)
  })

  it('times out with ok:false when no result arrives', async () => {
    vi.useFakeTimers()
    const hub = createIssueRelayHub(() => {}, { timeoutMs: 1000 })
    const p = hub.relay({ sessionId: 's1', router: 'issues', proc: 'ready' })
    vi.advanceTimersByTime(1001)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/timed out/)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/daemon/src/issue-relay.test.ts`
Expected: FAIL — `createIssueRelayHub` not found.

- [ ] **Step 3: Implement the hub**

Create `apps/daemon/src/issue-relay.ts`:

```typescript
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
      resolve({ ok: msg.ok, ...(msg.result !== undefined ? { result: msg.result } : {}), ...(msg.error !== undefined ? { error: msg.error } : {}) })
    },
    pendingCount: () => pending.size,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run vitest run apps/daemon/src/issue-relay.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the dispatch case in `daemon.ts`**

In `apps/daemon/src/daemon.ts`, construct the hub once (near where `send` and other per-connection state live — the hub needs `send`): `const issueRelayHub = createIssueRelayHub(send)`. Add the import. In `handleControlMessage`'s `switch (msg.type)`, add:

```typescript
case 'issueRelayResult':
  issueRelayHub.onResult(msg)
  break
```

(The hub instance must be reachable from both `handleControlMessage` and the loopback server in Task 2 — define it in the same scope as `ingest`.)

- [ ] **Step 6: Run daemon tests + typecheck; commit**

Run: `bun run vitest run apps/daemon/src/issue-relay.test.ts` and the repo typecheck for the daemon package.
Expected: PASS / clean.

```bash
git add apps/daemon/src/issue-relay.ts apps/daemon/src/issue-relay.test.ts apps/daemon/src/daemon.ts
git commit -m "feat(daemon): issue-relay hub (pending-map, resolve-once, timeout) + result dispatch"
```

---

### Task 2: Daemon loopback issue-relay HTTP server

**Files:**
- Modify: `apps/daemon/src/issue-relay.ts` (add `startIssueRelayServer`), `apps/daemon/src/daemon.ts` (start it)
- Test: `apps/daemon/src/issue-relay.test.ts`

**Interfaces:**
- Consumes: the hub's `relay(req)`.
- Produces: `startIssueRelayServer(opts: { relay: (req: IssueRelayRequest) => Promise<IssueRelayResult>; port?: number }): Promise<{ port: number; endpointFor(sessionId: string): string; close(): Promise<void> }>`. Endpoint: `POST /issue/<sessionId>` with JSON body `{ router?, proc, input?, outsideScope? }`; responds `200` `{ ok, result?|error? }` after the relay resolves. `router` defaults to `'issues'`.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/issue-relay.test.ts`:

```typescript
import { startIssueRelayServer } from './issue-relay'

it('POST /issue/<sessionId> relays and returns the result', async () => {
  const seen: any[] = []
  const srv = await startIssueRelayServer({
    port: 0,
    relay: async (req) => {
      seen.push(req)
      return { ok: true, result: `ran ${req.proc}` }
    },
  })
  try {
    const res = await fetch(srv.endpointFor('sX'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proc: 'ready', input: { repoPath: '/r' } }),
    })
    const body = await res.json()
    expect(body).toEqual({ ok: true, result: 'ran ready' })
    expect(seen[0]).toMatchObject({ sessionId: 'sX', router: 'issues', proc: 'ready' })
  } finally {
    await srv.close()
  }
})

it('rejects a non-POST or bad path with 404', async () => {
  const srv = await startIssueRelayServer({ port: 0, relay: async () => ({ ok: true }) })
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/nope`, { method: 'GET' })
    expect(res.status).toBe(404)
  } finally {
    await srv.close()
  }
})
```

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/daemon/src/issue-relay.test.ts -t "POST /issue"`
Expected: FAIL — `startIssueRelayServer` not found.

- [ ] **Step 3: Implement the server**

Add to `apps/daemon/src/issue-relay.ts` (mirrors `startHookIngest`'s structure, but AWAITS `relay` before responding; import `createServer, type Server` from `node:http`):

```typescript
import { createServer, type Server } from 'node:http'

export const DEFAULT_ISSUE_RELAY_PORT = 45778
const RELAY_BODY_MAX_BYTES = 1 * 1024 * 1024

export function startIssueRelayServer(opts: {
  relay: (req: IssueRelayRequest) => Promise<IssueRelayResult>
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
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
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
```

- [ ] **Step 4: Start it in `daemon.ts`**

In `apps/daemon/src/daemon.ts`, after `ingest` is started and `issueRelayHub` is constructed, start the server and keep the handle in scope for env injection (Task 3) and shutdown:

```typescript
const issueRelay = await startIssueRelayServer({ relay: (req) => issueRelayHub.relay(req) })
```

Add the import; ensure `issueRelay.close()` is called wherever `ingest.close()` is on daemon shutdown.

- [ ] **Step 5: Run to verify pass; typecheck; commit**

Run: `bun run vitest run apps/daemon/src/issue-relay.test.ts` → PASS; daemon typecheck clean.

```bash
git add apps/daemon/src/issue-relay.ts apps/daemon/src/daemon.ts
git commit -m "feat(daemon): loopback issue-relay HTTP endpoint (POST /issue/<sessionId>, blocking)"
```

---

### Task 3: Spawn-time env injection

**Files:**
- Modify: `apps/daemon/src/daemon.ts`
- Test: `apps/daemon/src/daemon-env.test.ts` (new; test a small extracted helper)

**Interfaces:**
- Produces: a pure helper `issueRelayEnv(sessionId: string, endpoint: string): Record<string, string>` returning `{ PODIUM_SESSION_ID, PODIUM_ISSUE_RELAY }`, folded into `spawnOpts.env` at spawn.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/daemon-env.test.ts`:

```typescript
import { it, expect } from 'vitest'
import { issueRelayEnv } from './daemon'

it('issueRelayEnv binds the session id into env + relay URL', () => {
  const env = issueRelayEnv('sess-42', 'http://127.0.0.1:45778/issue/sess-42')
  expect(env).toEqual({
    PODIUM_SESSION_ID: 'sess-42',
    PODIUM_ISSUE_RELAY: 'http://127.0.0.1:45778/issue/sess-42',
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/daemon/src/daemon-env.test.ts`
Expected: FAIL — `issueRelayEnv` not exported.

- [ ] **Step 3: Implement + inject**

In `apps/daemon/src/daemon.ts`, export the helper:

```typescript
export function issueRelayEnv(sessionId: string, endpoint: string): Record<string, string> {
  return { PODIUM_SESSION_ID: sessionId, PODIUM_ISSUE_RELAY: endpoint }
}
```

In the spawn handler where `spawnOpts` is built (the `env` currently only carries `CLAUDE_CODE_SUBAGENT_MODEL`), merge the relay env for every spawned agent:

```typescript
    const spawnOpts = {
      label,
      cmd: cmd.cmd,
      args: [...cmd.args, ...extraArgs],
      cwd: cmd.cwd,
      cols: msg.geometry.cols,
      rows: msg.geometry.rows,
      env: {
        ...issueRelayEnv(msg.sessionId, issueRelay.endpointFor(msg.sessionId)),
        ...(msg.subagentModel ? { CLAUDE_CODE_SUBAGENT_MODEL: msg.subagentModel } : {}),
      },
    }
```

(Confirm the spawn backends spread `spawnOpts.env` into the child environment — they should already, since `CLAUDE_CODE_SUBAGENT_MODEL` rode this way. If a backend replaces rather than extends `process.env`, ensure it merges.)

- [ ] **Step 4: Run to verify pass; typecheck; commit**

Run: `bun run vitest run apps/daemon/src/daemon-env.test.ts` → PASS; daemon typecheck clean.

```bash
git add apps/daemon/src/daemon.ts apps/daemon/src/daemon-env.test.ts
git commit -m "feat(daemon): inject PODIUM_SESSION_ID + PODIUM_ISSUE_RELAY into every spawned agent"
```

---

### Task 4: CLI relay transport

**Files:**
- Modify: `apps/server/src/issue-client.ts` (add `makeRelayIssueClient`), `scripts/issue-cli.ts` (switch on env + `--outside-scope`)
- Test: `apps/server/src/issue-client.test.ts`, `scripts/issue-cli.test.ts`

**Interfaces:**
- Consumes: `IssueTrpc` shape (`client.<router>.<proc>.query|mutate(input)`); env `PODIUM_ISSUE_RELAY`.
- Produces:
  - `makeRelayIssueClient(endpoint: string, opts?: { outsideScope?: boolean; fetchImpl?: typeof fetch }): IssueTrpc` — a Proxy that turns `client.<router>.<proc>.query|mutate(input)` into `POST endpoint {router, proc, input, outsideScope?}`, returning `result` on `ok`, throwing `Error(error)` on `!ok`.
  - `issueCliMain` uses the relay client when `PODIUM_ISSUE_RELAY` is set; parses `--outside-scope`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/issue-client.test.ts`:

```typescript
import { createServer } from 'node:http'
import { makeRelayIssueClient } from './issue-client'

it('relay client POSTs router/proc/input and returns result', async () => {
  const received: any[] = []
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: [{ seq: 1, title: 'X' }] }))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as any).port
  try {
    const client = makeRelayIssueClient(`http://127.0.0.1:${port}/issue/s1`, { outsideScope: true })
    const rows = await (client as any).issues.ready.query({ repoPath: '/r' })
    expect(rows).toEqual([{ seq: 1, title: 'X' }])
    expect(received[0]).toEqual({ router: 'issues', proc: 'ready', input: { repoPath: '/r' }, outsideScope: true })
  } finally {
    srv.close()
  }
})

it('relay client throws the server error on ok:false', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'outside your subtree' }))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as any).port
  try {
    const client = makeRelayIssueClient(`http://127.0.0.1:${port}/issue/s1`)
    await expect((client as any).issues.update.mutate({ id: 'B' })).rejects.toThrow(/outside your subtree/)
  } finally {
    srv.close()
  }
})
```

Add to `scripts/issue-cli.test.ts`:

```typescript
it('parses --outside-scope', () => {
  const { args } = parseIssueArgs(['update', '--id=B', '--outside-scope'])
  expect(args.outsideScope).toBe(true)
})
```

(If `parseIssueArgs` isn't exported, export it, or assert `--outside-scope` behavior through `runIssueCli` with a fake client — follow the file's existing test style.)

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/issue-client.test.ts scripts/issue-cli.test.ts -t "relay|outside-scope"`
Expected: FAIL — `makeRelayIssueClient` not found; `outsideScope` not parsed.

- [ ] **Step 3: Implement the relay client**

Add to `apps/server/src/issue-client.ts`:

```typescript
import type { IssueTrpc } from './issue-client' // (self-type; if IssueTrpc is declared here, drop this line)

/** IssueTrpc client that relays each call to the local daemon's issue endpoint (agent path).
 *  `client.<router>.<proc>.query|mutate(input)` → POST {router, proc, input, outsideScope?}. */
export function makeRelayIssueClient(
  endpoint: string,
  opts?: { outsideScope?: boolean; fetchImpl?: typeof fetch },
): IssueTrpc {
  const doFetch = opts?.fetchImpl ?? fetch
  const call = (router: string, proc: string) => async (input: unknown): Promise<unknown> => {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        router,
        proc,
        ...(input !== undefined ? { input } : {}),
        ...(opts?.outsideScope ? { outsideScope: true } : {}),
      }),
    })
    const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
    if (!body.ok) throw new Error(body.error ?? 'issue relay failed')
    return body.result
  }
  const procProxy = (router: string) =>
    new Proxy(
      {},
      {
        get: (_t, proc) => {
          if (typeof proc !== 'string') return undefined
          const fn = call(router, proc)
          return { mutate: fn, query: fn }
        },
      },
    )
  return new Proxy(
    {},
    { get: (_t, router) => (typeof router === 'string' ? procProxy(router) : undefined) },
  ) as unknown as IssueTrpc
}
```

(If `IssueTrpc` is declared in this file, reference it directly and delete the self-import line.)

- [ ] **Step 4: Switch the CLI on env + parse the flag**

In `scripts/issue-cli.ts`: in `parseIssueArgs`, ensure `--outside-scope` sets `args.outsideScope = true` (it likely already collects `--flag` booleans; confirm the key name is `outsideScope`). In `issueCliMain`, choose the client by env:

```typescript
export async function issueCliMain(argv: string[]): Promise<void> {
  const relay = process.env.PODIUM_ISSUE_RELAY
  const outsideScope = argv.includes('--outside-scope')
  const client = relay
    ? makeRelayIssueClient(relay, { outsideScope })
    : makeIssueClient(`http://localhost:${Number(process.env.PODIUM_PORT) || 18787}`)
  try {
    console.log(await runIssueCli(argv, client))
  } catch (err) {
    console.error(`podium issue: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
```

Add the `makeRelayIssueClient` import. Do NOT add a `--session` flag — the session id is bound in the relay URL (env).

- [ ] **Step 5: Run to verify pass; typecheck; commit**

Run: `bun run vitest run apps/server/src/issue-client.test.ts scripts/issue-cli.test.ts` → PASS; typecheck clean.

```bash
git add apps/server/src/issue-client.ts apps/server/src/issue-client.test.ts scripts/issue-cli.ts scripts/issue-cli.test.ts
git commit -m "feat(cli): relay transport — agent podium issue calls ride the daemon (env-bound session)"
```

---

### Task 5: End-to-end verification (isolated podium)

**Files:**
- Test: `apps/server/src/issue-relay-e2e.test.ts` (new integration test) OR a scripted check under `scripts/` — whichever matches the repo's existing integration-test placement.

**Interfaces:**
- Consumes: everything above + the isolated-podium harness pattern (`PODIUM_PORT` + `PODIUM_STATE_DIR` + `hooks{port:0}` + `PODIUM_NO_SCOPE` + `PODIUM_PTY_BACKEND=node-pty`).

- [ ] **Step 1: Write the e2e test**

Create an integration test that stands up an isolated server + daemon in-process (reuse the harness the existing `issue-cli.e2e.test.ts` uses if present — check `apps/server/src/issue-cli.e2e.test.ts`), then:

```typescript
// Pseudocode contract — implement against the real harness:
// 1. Start isolated server+daemon (PODIUM_PORT, PODIUM_STATE_DIR=tmp, hooks port 0, node-pty).
// 2. Create issue A (repo /tmp/repo) and start it → gives worktree wtA. Create unrelated issue B.
// 3. Register a session whose cwd = wtA (the harness's session-create), capture its sessionId.
// 4. Point a relay client at the daemon's issue endpoint for that sessionId
//    (or set PODIUM_ISSUE_RELAY and run runIssueCli).
// 5. Assert:
//    - `podium issue prime`  → output contains A's title (bound to A's subtree).
//    - `podium issue ready`  → returns JSON (no auth error).
//    - `podium issue create --title "Found bug"` → succeeds (worker may create).
//    - `podium issue update --id <B>` → fails with /outside your subtree/.
//    - same update with --outside-scope → succeeds.
```

Write it with real assertions against the harness. If a full server+daemon+PTY e2e is too heavy for the unit suite, gate it behind the same describe/skip guard the repo uses for `*.e2e.test.ts`, and additionally add a lighter integration test that drives `runIssueCli(argv, makeRelayIssueClient(endpoint))` against a real daemon relay server whose `relay` is wired to a real `SessionRegistry.runIssueRelay` (server side) — exercising the whole chain minus the PTY.

- [ ] **Step 2: Run it**

Run: the e2e/integration file (respecting the repo's e2e gating).
Expected: PASS — all five assertions.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/issue-relay-e2e.test.ts
git commit -m "test(relay): end-to-end agent issue relay (prime/ready/create/scope/override) via isolated podium"
```

---

## Self-Review

**Spec coverage (P1b-edge portion of the design):**
- §2 transport: agent CLI → local daemon → server → back → CLI → Tasks 1 (hub), 2 (loopback), 4 (CLI). ✓
- §2 env-bound session id (not CLI-overridable) → Task 3 (`issueRelayEnv`, injected at spawn) + Task 4 (no `--session` flag; relay URL carries the id). ✓
- §5 `--outside-scope` → Task 4 (parsed, sent in body) → P1b-server threads to `overrideScope`. ✓
- Final-review binding #1 (env-bound session) → Task 3. Binding #2 (dedup by requestId) → Task 1 `onResult` ignores unknown/duplicate/late. ✓
- End-to-end proof → Task 5. ✓

**Placeholder scan:** Task 5's e2e body is intentionally a contract (the harness wiring is repo-specific); every other step has concrete code + commands. Task 5 names the exact five assertions and the fallback lighter integration test — not a TODO.

**Type consistency:** `IssueRelayRequest`/`IssueRelayResult` (Task 1) are the hub's and server's shared shape; `relay(req)` param matches `startIssueRelayServer`'s `relay` callback (Task 2) and the POST body (`router?`,`proc`,`input?`,`outsideScope?`). `issueRelayEnv` returns exactly `PODIUM_SESSION_ID`/`PODIUM_ISSUE_RELAY`, consumed by the CLI (Task 4). The daemon message `type:'issueRelayRequest'` and dispatch `case 'issueRelayResult'` match the P1b-server protocol messages.

**Cross-plan seam:** the daemon sends `issueRelayRequest` (P1b-server added it to `DaemonMessage`); the server's `runIssueRelay` (P1b-server) replies `issueRelayResult` (in `ControlMessage`), which the daemon's Task-1 dispatch resolves. No new protocol needed here.
