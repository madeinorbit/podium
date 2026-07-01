# Issues in Agents — P1b-server: Relay Protocol + Capability Minting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server-side half of the agent relay: the relay protocol messages, per-session capability minting (session cwd → owning issue → `worker`/subtree scope), a server handler that runs a relayed issue op through `createCaller` with that capability (so the P1a scope gate enforces), an allowlist so the relay can't invoke arbitrary routers, and the structural-scope hardening the P1a final review flagged as a P1b prerequisite. Plus the small P1a follow-up cleanups.

**Architecture:** A launched agent's `podium issue` CLI will POST issue ops to its local daemon, which forwards them to the server as an `issueRelayRequest` (daemon→server) and awaits an `issueRelayResult` (server→daemon). This plan builds the **server end**: it resolves the calling session to a capability and invokes the op via `appRouter.createCaller({…, capability, overrideScope})` — the exact seam P1a's middleware guards. The daemon socket plumbing, env injection, and CLI transport are the separate **P1b-edge** plan. Everything here is testable with `createCaller` and direct registry calls; no daemon required.

**Tech Stack:** TypeScript, `@trpc/server@11`, Zod, Vitest, Bun. Protocol lives in `packages/protocol/src/messages.ts`; the registry + relay handler in `apps/server/src/relay.ts`; caller wiring in `apps/server/src/server.ts`; authz in `apps/server/src/issue-authz.ts` + `apps/server/src/router.ts`.

## Global Constraints

- **Authz is the single server-side policy point.** Relayed ops MUST go through `appRouter.createCaller(...).issues[proc](input)` so the P1a `issueCapabilityGuard` runs. Never call `ctx.registry.issues.<method>` directly for a relayed op (that bypasses the gate). Do NOT resurrect the retired `x-podium-issue-*` headers / `PODIUM_ISSUE_TOKEN` / reader-gate.
- **Scoped capabilities are `worker`-role only** (never `admin`), scope `{kind:'subtree',rootId}` when the session owns an issue, else `{kind:'none'}`. An unknown session gets `{kind:'none'}` (most-restricted).
- **Relay allowlist:** a relayed request may invoke `issues.*` (all — the capability middleware gates them) and `repos.inferFromPath` only. Any other `router.proc` is rejected. This prevents a relayed agent from reaching ungated routers (sessions, spawn, kill, …).
- **No circular imports:** `relay.ts` must NOT import `appRouter` (router.ts already depends on relay.ts's types). The caller factory is injected from `server.ts`.
- **TDD, DRY, YAGNI, frequent commits.** Reuse the in-memory test harness from `router.issues.test.ts` / `issue-authz-gate.test.ts`.
- **Live-source safety:** all work stays in the worktree `issue/5-issues-in-agents`.

---

### Task 1: P1a follow-up cleanups

**Files:**
- Modify: `apps/server/src/issue-authz.ts`, `apps/server/src/issue-authz.test.ts`, `apps/server/src/router.ts`, `apps/server/src/issues.ts`, `apps/server/src/issues.test.ts`
- Test: the two test files above.

**Interfaces:**
- Consumes: `authorize` (P1a); `IssueService.get`, `IssueWire` (`deps: {toId,type}[]`, `blocked`, `closedReason`, `parentId`, `seq`).
- Produces: `can()` removed (or re-annotated); `prime()` renders structural blockers as `#seq` and parent as `#seq`; a unit test pinning override-does-not-bypass-role.

- [ ] **Step 1: Confirm `can()` is dead, then write the failing/updated tests**

Run `grep -rn "\bcan(" apps/server/src --include=*.ts | grep -v test` — expect NO production hits (only `authorize` is used). If any production hit exists, STOP and report; do not delete.

Add to `apps/server/src/issue-authz.test.ts` (override must not bypass a role denial):

```typescript
it('override never bypasses a role denial', () => {
  const viewer: Capability = { role: 'viewer', scope: { kind: 'all' } }
  expect(authorize(viewer, 'write', { id: 'X' }, { override: true })).toBe('forbidden')
})
```

Add to `apps/server/src/issues.test.ts` (structural blockers + parent rendered as #seq):

```typescript
it('prime renders structural blockers and parent as #seq', () => {
  const svc = makeService()
  const epic = svc.create({ repoPath: '/r', title: 'Epic', startNow: false })
  const dep = svc.create({ repoPath: '/r', title: 'Dep', startNow: false })
  const me = svc.create({ repoPath: '/r', title: 'Me', startNow: false, parentId: epic.id })
  svc.addDep(me.id, dep.id, 'blocks')
  const out = svc.prime({ repoPath: '/r', boundIssueId: me.id })
  expect(out).toContain(`Parent epic: #${epic.seq}`)
  expect(out).toContain(`Blocked by: #${dep.seq}`)
})
```

(Adapt `makeService`/`addDep` to the file's real helpers — Task-2 of P1a used `harness()` and the service exposes `addDep(fromId, toId, type)`. If the dep-add method has a different name, use the one the file's other tests use.)

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/issue-authz.test.ts apps/server/src/issues.test.ts -t "override never|structural blockers"`
Expected: the override test passes already (structural guarantee) OR fails if a regression — keep it as a lock; the prime test FAILS (parent prints raw id; blockers use `blockedBy`).

- [ ] **Step 3: Delete dead `can()` and fix `prime` rendering**

In `apps/server/src/issue-authz.ts`, delete the `can` function (the whole `export function can(...) {...}` block) and any now-unused local it referenced only. In `apps/server/src/issue-authz.test.ts`, delete the `can`-specific test block(s) and the `can` import. In `apps/server/src/router.ts`, remove any stale comment that says the guard uses `can` / that per-issue scope "lands later" (it's implemented now).

In `apps/server/src/issues.ts` `prime()`, replace the bound-issue parent + blockers rendering:

```typescript
    if (me) {
      const kids = this.list(me.repoPath).filter(
        (i) => i.parentId === me.id && i.stage !== 'done' && !i.closedReason,
      )
      const blockers = (me.deps ?? [])
        .filter((d) => d.type === 'blocks')
        .map((d) => {
          const b = this.get(d.toId)
          return b ? `#${b.seq}` : d.toId
        })
      const parent = me.parentId ? this.get(me.parentId) : null
      return [
        `You are working on #${me.seq}: ${me.title}`,
        me.acceptance ? `Acceptance: ${me.acceptance}` : null,
        me.parentId ? `Parent epic: #${parent?.seq ?? me.parentId}` : null,
        kids.length ? `Open children:\n${kids.map((k) => `  - #${k.seq} ${k.title}`).join('\n')}` : null,
        blockers.length ? `Blocked by: ${blockers.join(', ')}` : null,
        '',
        ...rules,
      ]
        .filter((l) => l !== null)
        .join('\n')
    }
```

(Verify `IssueWire.deps` is `{ toId: string; type: string }[]`. If the wire exposes blocks differently, use the real field; the test asserts `Blocked by: #<seq>` from a structural `blocks` dep.)

- [ ] **Step 4: Run to verify pass; reflow long lines**

Run: `bun run vitest run apps/server/src/issue-authz.test.ts apps/server/src/issues.test.ts apps/server/src/router.issues.test.ts apps/server/src/issue-commands.test.ts`
Expected: PASS. Then ensure no line you touched exceeds 100 cols (reflow by hand; do NOT run `bun run format` on whole files — it would churn pre-existing formatting). Run `bunx tsc --noEmit -p apps/server` (or the repo's typecheck) → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issue-authz.ts apps/server/src/issue-authz.test.ts apps/server/src/router.ts apps/server/src/issues.ts apps/server/src/issues.test.ts
git commit -m "refactor(authz): remove dead can(); prime uses structural blockers + #seq; lock override-vs-role"
```

---

### Task 2: Relay protocol messages

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts` (or the protocol package's existing test file; create a focused one if none exists for message parsing)

**Interfaces:**
- Produces:
  - `IssueRelayRequestMessage` (daemon→server): `{ type:'issueRelayRequest', requestId, sessionId, router, proc, input?, outsideScope? }`, added to the `DaemonMessage` union.
  - `IssueRelayResultMessage` (server→daemon): `{ type:'issueRelayResult', requestId, ok, result?, error? }`, added to the `ControlMessage` union.

- [ ] **Step 1: Write the failing parse test**

Add to the protocol test file:

```typescript
import { parseDaemonMessage, parseControlMessage } from './messages'

it('round-trips an issueRelayRequest (daemon→server)', () => {
  const m = parseDaemonMessage(
    JSON.stringify({
      type: 'issueRelayRequest', requestId: 'ir0', sessionId: 's1',
      router: 'issues', proc: 'ready', input: { repoPath: '/r' },
    }),
  )
  expect(m.type).toBe('issueRelayRequest')
})

it('round-trips an issueRelayResult (server→daemon)', () => {
  const m = parseControlMessage(
    JSON.stringify({ type: 'issueRelayResult', requestId: 'ir0', ok: true, result: 'x' }),
  )
  expect(m.type).toBe('issueRelayResult')
})
```

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run packages/protocol/src/messages.test.ts -t issueRelay`
Expected: FAIL — `parse` throws (unknown discriminator `issueRelayRequest` / `issueRelayResult`).

- [ ] **Step 3: Declare the messages and add to the unions**

In `packages/protocol/src/messages.ts`, near the other request/result messages, add:

```typescript
export const IssueRelayRequestMessage = z.object({
  type: z.literal('issueRelayRequest'),
  requestId: z.string(),
  sessionId: z.string(),
  router: z.string(),
  proc: z.string(),
  input: z.unknown().optional(),
  outsideScope: z.boolean().optional(),
})

export const IssueRelayResultMessage = z.object({
  type: z.literal('issueRelayResult'),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})
```

Add `IssueRelayRequestMessage,` to the `DaemonMessage` discriminated union array and `IssueRelayResultMessage,` to the `ControlMessage` discriminated union array.

- [ ] **Step 4: Run to verify pass**

Run: `bun run vitest run packages/protocol/src/messages.test.ts -t issueRelay`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): add issueRelayRequest/issueRelayResult relay messages"
```

---

### Task 3: Structural scope hardening (P1b prerequisite)

**Files:**
- Modify: `apps/server/src/router.ts`
- Test: `apps/server/src/router.issues.test.ts`

**Interfaces:**
- Consumes: `PROC_ACTION` (P1a), `SCOPED_TARGET` (P1a).
- Produces: `SCOPED_TARGET` covers every `write`+`manage` proc that targets an existing issue; a regression test ties coverage to `PROC_ACTION` so a future write/manage proc can't silently escape the scope gate.

- [ ] **Step 1: Write the failing coverage test**

Add to `apps/server/src/router.issues.test.ts`:

```typescript
import { PROC_ACTION } from './issue-authz'
import { SCOPED_TARGET } from './router'

// Procs that mutate but have NO single existing-issue target (additive / not-an-issue):
const NO_TARGET = new Set(['create', 'linearSearch'])

it('every write/manage proc that targets an existing issue is scope-gated', () => {
  const need = Object.entries(PROC_ACTION)
    .filter(([, a]) => a === 'write' || a === 'manage')
    .map(([p]) => p)
    .filter((p) => !NO_TARGET.has(p))
  const missing = need.filter((p) => !(p in SCOPED_TARGET))
  expect(missing).toEqual([])
})
```

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/router.issues.test.ts -t "scope-gated"`
Expected: FAIL — `missing` lists the manage procs (`archive`, `delete`, `setLabels`, `depRemove`, `reparent`, `supersede`, `duplicate`).

- [ ] **Step 3: Extend `SCOPED_TARGET` with the manage procs**

In `apps/server/src/router.ts`, add the manage-proc extractors to `SCOPED_TARGET` (verify each proc's real input field names against its resolver in this file, and adjust if they differ):

```typescript
  archive: (i) => i.id as string,
  delete: (i) => i.id as string,
  setLabels: (i) => i.id as string,
  reparent: (i) => i.id as string,
  depRemove: (i) => i.fromId as string,
  supersede: (i) => i.oldId as string,
  duplicate: (i) => i.id as string,
```

(If e.g. `supersede`'s input uses `id`/`newId` rather than `oldId`, use the field that names the issue being superseded — the mutated subject. Confirm from the resolver.)

- [ ] **Step 4: Run to verify pass**

Run: `bun run vitest run apps/server/src/router.issues.test.ts`
Expected: PASS (coverage test green; existing scope tests still green).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/router.ts apps/server/src/router.issues.test.ts
git commit -m "fix(authz): scope-gate all write/manage procs; test ties SCOPED_TARGET to PROC_ACTION"
```

---

### Task 4: `issueForCwd` + `capabilityForSession`

**Files:**
- Modify: `apps/server/src/issues.ts` (add `issueForCwd`), `apps/server/src/relay.ts` (add `capabilityForSession`)
- Test: `apps/server/src/issues.test.ts`, `apps/server/src/router.issues.test.ts`

**Interfaces:**
- Consumes: `IssueService` `rows` (IssueRow has `worktreePath`), `isMemberCwd` (`apps/server/src/issue-util.ts`), the registry's `sessions` map + `this.issues`, `Capability` (`./issue-authz`).
- Produces:
  - `IssueService.issueForCwd(cwd: string): string | null` — the id of the issue whose worktree contains `cwd`, else null.
  - `SessionRegistry.capabilityForSession(sessionId: string): Capability` — `worker`/subtree if the session's cwd is inside an issue worktree, else `worker`/none.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/issues.test.ts`:

```typescript
it('issueForCwd resolves a cwd inside an issue worktree', async () => {
  const svc = makeService()
  const i = svc.create({ repoPath: '/r', title: 'W', startNow: false })
  await svc.start(i.id) // sets worktreePath
  const wt = svc.get(i.id)!.worktreePath as string
  expect(svc.issueForCwd(wt)).toBe(i.id)
  expect(svc.issueForCwd(`${wt}/sub/dir`)).toBe(i.id)
  expect(svc.issueForCwd('/somewhere/else')).toBeNull()
})
```

(If the test harness's `repoOp` stub makes `start()` awkward, set `worktreePath` via whatever path the file's existing start/worktree tests use. The behavior under test is cwd→issue resolution.)

Add to `apps/server/src/router.issues.test.ts` (uses the in-memory registry):

```typescript
it('capabilityForSession returns subtree cap for a session in an issue worktree, else none', async () => {
  const i = await registry.issues.start((await someIssueInRepo()).id) // create+start an issue; see file helpers
  const wt = registry.issues.get(i.id)!.worktreePath as string
  const sid = registry.createSession({ cwd: wt, agentKind: 'shell' }) // or the file's session-creation helper
  const cap = registry.capabilityForSession(sid)
  expect(cap).toEqual({ role: 'worker', scope: { kind: 'subtree', rootId: i.id } })

  const sid2 = registry.createSession({ cwd: '/unowned', agentKind: 'shell' })
  expect(registry.capabilityForSession(sid2)).toEqual({ role: 'worker', scope: { kind: 'none' } })

  expect(registry.capabilityForSession('no-such-session')).toEqual({ role: 'worker', scope: { kind: 'none' } })
})
```

(Adapt session creation to the registry's real API — `createSession` returns a session id or object; use what `relay.ts` exposes. The three assertions are the contract.)

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/issues.test.ts apps/server/src/router.issues.test.ts -t "issueForCwd|capabilityForSession"`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement**

In `apps/server/src/issues.ts` `IssueService`:

```typescript
/** The id of the issue whose worktree contains `cwd`, or null. Used to mint per-agent scope. */
issueForCwd(cwd: string): string | null {
  for (const r of this.rows.values()) {
    if (isMemberCwd(r.worktreePath, cwd)) return r.id
  }
  return null
}
```

Add the import at the top of `issues.ts` if not present: `import { isMemberCwd } from './issue-util'`.

In `apps/server/src/relay.ts` `SessionRegistry`:

```typescript
/** The capability a relayed agent session presents: worker, scoped to the issue whose
 *  worktree it runs in (subtree), else 'none' (may read + create, but writing an existing
 *  issue needs --outside-scope). Unknown session → most-restricted. */
capabilityForSession(sessionId: string): Capability {
  const s = this.sessions.get(sessionId)
  if (!s) return { role: 'worker', scope: { kind: 'none' } }
  const issueId = this.issues.issueForCwd(s.cwd)
  return issueId
    ? { role: 'worker', scope: { kind: 'subtree', rootId: issueId } }
    : { role: 'worker', scope: { kind: 'none' } }
}
```

Add `import type { Capability } from './issue-authz'` to `relay.ts` if not present.

- [ ] **Step 4: Run to verify pass**

Run: `bun run vitest run apps/server/src/issues.test.ts apps/server/src/router.issues.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issues.ts apps/server/src/relay.ts apps/server/src/issues.test.ts apps/server/src/router.issues.test.ts
git commit -m "feat(relay): mint per-session issue capability from cwd (issueForCwd + capabilityForSession)"
```

---

### Task 5: Server relay handler + allowlist + caller wiring

**Files:**
- Modify: `apps/server/src/relay.ts` (relay handler + `makeIssueCaller` field + dispatch case), `apps/server/src/server.ts` (inject the caller factory)
- Test: `apps/server/src/relay-issue-relay.test.ts` (new)

**Interfaces:**
- Consumes: `capabilityForSession` (Task 4); `toMachine`; `onDaemonMessageFrom`; the `IssueRelay*` messages (Task 2).
- Produces:
  - `SessionRegistry.makeIssueCaller?: (capability: Capability, overrideScope?: boolean) => { issues: Record<string, (i: unknown) => Promise<unknown>>; repos: Record<string, (i: unknown) => Promise<unknown>> }` — set by `server.ts`.
  - `onDaemonMessageFrom` handles `issueRelayRequest` → runs the op via the caller with the minted capability → replies `issueRelayResult`.
  - `RELAY_ALLOWED` allowlist: `issues.*` + `repos.inferFromPath` only.

- [ ] **Step 1: Write the failing integration test**

Create `apps/server/src/relay-issue-relay.test.ts` (reuse the in-memory registry pattern; drive the relay by calling `onDaemonMessageFrom` and capturing the reply via a stubbed daemon send):

```typescript
import { describe, it, expect } from 'vitest'
import { appRouter } from './router'
// ... import the registry/harness builders used by router.issues.test.ts ...

// Helper: install a caller factory identical to server.ts wiring.
function wireCaller(registry: any, repos: any, superagent: any) {
  registry.makeIssueCaller = (capability: any, overrideScope?: boolean) =>
    appRouter.createCaller({ registry, repos, superagent, capability, overrideScope })
}

// Helper: capture the issueRelayResult the registry sends back to a machine.
function captureReply(registry: any, machineId: string): Promise<any> {
  return new Promise((resolve) => {
    registry.attachDaemon(machineId, (msg: any) => {
      if (msg.type === 'issueRelayResult') resolve(msg)
    })
  })
}

it('relays a scoped op through the capability gate', async () => {
  // set up registry with issues A (subtree root) and B (unrelated), a session in A's worktree = sessionId sA
  // wireCaller(...)
  const machineId = 'm1'
  const reply = captureReply(registry, machineId)
  registry.onDaemonMessageFrom(machineId, {
    type: 'issueRelayRequest', requestId: 'ir1', sessionId: sA,
    router: 'issues', proc: 'update', input: { id: B.id, patch: { notes: 'x' } },
  })
  const r = await reply
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/outside your subtree/)
})

it('override lets a scoped op write outside its subtree', async () => {
  const reply = captureReply(registry, 'm1')
  registry.onDaemonMessageFrom('m1', {
    type: 'issueRelayRequest', requestId: 'ir2', sessionId: sA,
    router: 'issues', proc: 'update', input: { id: B.id, patch: { notes: 'x' } }, outsideScope: true,
  })
  expect((await reply).ok).toBe(true)
})

it('rejects a non-allowlisted router', async () => {
  const reply = captureReply(registry, 'm1')
  registry.onDaemonMessageFrom('m1', {
    type: 'issueRelayRequest', requestId: 'ir3', sessionId: sA,
    router: 'sessions', proc: 'kill', input: { id: 'whatever' },
  })
  const r = await reply
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/not permitted via relay/)
})

it('relays prime bound to the session capability', async () => {
  const reply = captureReply(registry, 'm1')
  registry.onDaemonMessageFrom('m1', {
    type: 'issueRelayRequest', requestId: 'ir4', sessionId: sA,
    router: 'issues', proc: 'prime', input: { repoPath },
  })
  const r = await reply
  expect(r.ok).toBe(true)
  expect(String(r.result)).toContain(A.title)
})
```

(Fill the setup comments using the same builders the other relay/router tests use. `attachDaemon(machineId, send)` is the registry method that registers a daemon's send fn — confirmed in `wsServer.ts`. If a test needs the daemon attached before the request, call `attachDaemon` first, then `onDaemonMessageFrom`.)

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/relay-issue-relay.test.ts`
Expected: FAIL — no `issueRelayRequest` handling; no reply is sent.

- [ ] **Step 3: Implement the handler + allowlist in `relay.ts`**

Add near the top of `relay.ts` (module scope):

```typescript
/** Routers/procs a relayed agent may invoke. issues.* is capability-gated by the router
 *  middleware; everything else must be explicitly listed. `null` = any proc on that router. */
const RELAY_ALLOWED: Record<string, Set<string> | null> = {
  issues: null,
  repos: new Set(['inferFromPath']),
}
```

Add the field to the `SessionRegistry` class:

```typescript
/** Injected by server.ts: builds a tRPC caller bound to a capability (the scope-gate seam).
 *  Left undefined in tests that don't exercise the relay. */
makeIssueCaller?: (
  capability: Capability,
  overrideScope?: boolean,
) => { [router: string]: Record<string, (i: unknown) => Promise<unknown>> | undefined }
```

Add the dispatch case inside `onDaemonMessageFrom`'s switch:

```typescript
case 'issueRelayRequest': {
  void this.runIssueRelay(machineId, msg)
  break
}
```

Add the method:

```typescript
private async runIssueRelay(
  machineId: string,
  msg: Extract<DaemonMessage, { type: 'issueRelayRequest' }>,
): Promise<void> {
  const reply = (r: { ok: boolean; result?: unknown; error?: string }): void =>
    this.toMachine(machineId, { type: 'issueRelayResult', requestId: msg.requestId, ...r })
  try {
    const allowed = RELAY_ALLOWED[msg.router]
    if (allowed === undefined || (allowed !== null && !allowed.has(msg.proc))) {
      reply({ ok: false, error: `${msg.router}.${msg.proc} is not permitted via relay` })
      return
    }
    const make = this.makeIssueCaller
    if (!make) {
      reply({ ok: false, error: 'issue relay is not configured' })
      return
    }
    const caller = make(this.capabilityForSession(msg.sessionId), msg.outsideScope)
    const fn = caller[msg.router]?.[msg.proc]
    if (!fn) {
      reply({ ok: false, error: `no such procedure: ${msg.router}.${msg.proc}` })
      return
    }
    reply({ ok: true, result: await fn(msg.input) })
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
```

- [ ] **Step 4: Wire the caller factory in `server.ts`**

In `apps/server/src/server.ts`, where `registry`, `repos`, `superagent` are all in scope (near the existing `appRouter.createCaller(... capability: OPERATOR ...)` wiring), add:

```typescript
registry.makeIssueCaller = (capability, overrideScope) =>
  appRouter.createCaller({ registry, repos, superagent, capability, overrideScope }) as unknown as {
    [router: string]: Record<string, (i: unknown) => Promise<unknown>> | undefined
  }
```

- [ ] **Step 5: Run to verify pass; typecheck; commit**

Run: `bun run vitest run apps/server/src/relay-issue-relay.test.ts apps/server/src/router.issues.test.ts`
Expected: PASS. Then `bunx tsc --noEmit -p apps/server` (or the repo typecheck) → clean.

```bash
git add apps/server/src/relay.ts apps/server/src/server.ts apps/server/src/relay-issue-relay.test.ts
git commit -m "feat(relay): server handles issueRelayRequest via capability-scoped createCaller + allowlist"
```

---

## Self-Review

**Spec coverage (P1b-server portion of the design):**
- §2/§4 daemon-relayed capability seam (server end) → Tasks 2 (messages), 4 (capability minting), 5 (handler via createCaller). ✓
- §5 `--outside-scope` reaches the gate → `outsideScope` on the request message (Task 2) → `overrideScope` into `createCaller` (Task 5). ✓
- §7 unbound agent = read + create, existing-issue write needs override → `capabilityForSession` returns `{kind:'none'}` for unbound (Task 4), enforced by P1a authz. ✓
- P1a final-review **Important** (structural scope; no manage-tier hole) → Task 3. ✓
- P1a final-review Minors (dead `can()`, override-vs-role test, prime blocker fidelity, parent #seq) → Task 1. ✓
- **Deferred to P1b-edge:** the daemon loopback server + pending-map, env injection (`PODIUM_SESSION_ID`/`PODIUM_ISSUE_RELAY`), the CLI relay transport, and the end-to-end verification. Not in this plan by design.

**Placeholder scan:** none — every step has concrete code/commands. Test setup steps that say "reuse the file's helpers" name the exact contract asserted; they are not TODOs.

**Type consistency:** `IssueRelayRequestMessage` fields (`router`,`proc`,`input?`,`outsideScope?`,`sessionId`,`requestId`) match the handler's reads in Task 5 and the parse test in Task 2. `makeIssueCaller` signature (capability, overrideScope) → indexable-by-router return matches its use in `runIssueRelay` (`caller[msg.router]?.[msg.proc]`) and the `server.ts` wiring. `capabilityForSession` return type `Capability` matches `makeIssueCaller`'s first param. `RELAY_ALLOWED` (`issues: null`, `repos: {inferFromPath}`) matches the allowlist check. `issueForCwd`/`isMemberCwd` field usage matches P1a.

**Note:** Task 5's caller invocation goes through `appRouter.createCaller(...).issues[proc]`, so the P1a `issueCapabilityGuard` middleware runs on every relayed issue op — the scope gate is enforced, not re-implemented. `repos.inferFromPath` is ungated but allowlisted read-only.
