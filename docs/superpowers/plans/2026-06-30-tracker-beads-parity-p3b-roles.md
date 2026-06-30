# Tracker → beads Parity — P3b: Roles (reader/worker/maintainer) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the tracker so not every caller can do everything — a server-side **reader / worker / maintainer** model on the `issues.*` tRPC procedures, enforced for the CLI (and the in-process MCP), without changing the sensitive relay→daemon spawn protocol.

**Architecture:** A pure role model (`issue-roles.ts`): a rank order + a per-procedure minimum-role map + a pure `resolveRole(cred, env)`. The server mints a **maintainer token** at boot (a `readOrCreateMaintainerToken` mirroring `readOrCreateDaemonSecret`). `createContext` resolves the caller's role from two request headers — `x-podium-issue-token` (maintainer token ⇒ maintainer) and `x-podium-issue-cwd` (a path inside any issue's worktree ⇒ worker, else reader) — and a tRPC middleware (`issueRoleGuard`) enforces the per-procedure minimum on every `issues.*` call. The CLI presents the maintainer token (from the state-dir file, so the trusted operator is maintainer) + its cwd (so an agent in an issue's worktree gets worker). The in-process MCP issue tools present the maintainer token (the orchestrator is trusted).

**Tech Stack:** TypeScript, Bun, tRPC v11 (`t.middleware`, `TRPCError`), `@hono/trpc-server` v0.3.4 (`createContext(opts, c)` with Hono context), zod, vitest.

## Global Constraints

- **Runtime/tests:** Bun; `npx vitest run <path>`. Role-model + guard tests use `appRouter.createCaller(ctx)` with an explicit `role` (no server). The e2e (P3a) must be updated to present the maintainer token (it now hits the gate).
- **Fail-safe default:** no credentials ⇒ `reader` (read-only). Only a valid maintainer token ⇒ `maintainer`; a cwd inside an issue worktree ⇒ `worker`.
- **Tier model (v1):** `reader` < `worker` < `maintainer`. Worker scoping is **tier-only in v1** (a worker may run worker-tier ops on any issue); per-issue/per-repo scoping and spawn-time worker-token injection are explicit follow-ons (NOT in this plan).
- **Gate applies to `issues.*` ONLY.** Other routers (sessions/repos/superagent) are unaffected — they receive the `role` in ctx but don't check it.
- **Additive:** adding `role` to `Context` + the guard must not change any existing non-issue behavior. The only `createContext`/`createCaller` site is `server.ts` (verify with grep).
- **Commits:** conventional, one per task, scope `tracker`. **Isolation:** worktree only; never the main checkout; no PTY/agent e2e beyond the existing isolated server smoke. **Dense style:** no broad biome reformat of pre-existing files; keep new files biome-clean.

---

### Task 1: Role model + maintainer token

**Files:**
- Create: `apps/server/src/issue-roles.ts` — `Role`, `ROLE_RANK`, `PROC_MIN_ROLE`, `resolveRole`.
- Modify: `apps/server/src/local-machine.ts` — add `readOrCreateMaintainerToken`.
- Test: `apps/server/src/issue-roles.test.ts` (create).

**Interfaces:**
- Produces `type Role = 'reader' | 'worker' | 'maintainer'`; `const ROLE_RANK: Record<Role, number>` (reader 0, worker 1, maintainer 2); `const PROC_MIN_ROLE: Record<string, Role>` (issues procedure name → minimum role; unlisted ⇒ `reader`); pure `resolveRole(cred: { token?: string; cwd?: string }, env: { maintainerToken: string; issueWorktrees: string[] }): Role`.
- Produces `readOrCreateMaintainerToken(dir?): string` (mirrors `readOrCreateDaemonSecret`; file `issue-maintainer.token`).

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/issue-roles.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PROC_MIN_ROLE, resolveRole, ROLE_RANK } from './issue-roles'

describe('resolveRole', () => {
  const env = { maintainerToken: 'MAINT', issueWorktrees: ['/repo/.worktrees/issue-1-foo'] }
  it('maintainer token wins', () => {
    expect(resolveRole({ token: 'MAINT' }, env)).toBe('maintainer')
  })
  it('cwd inside an issue worktree ⇒ worker', () => {
    expect(resolveRole({ cwd: '/repo/.worktrees/issue-1-foo' }, env)).toBe('worker')
    expect(resolveRole({ cwd: '/repo/.worktrees/issue-1-foo/src' }, env)).toBe('worker')
  })
  it('no credentials ⇒ reader (fail-safe)', () => {
    expect(resolveRole({}, env)).toBe('reader')
    expect(resolveRole({ cwd: '/elsewhere' }, env)).toBe('reader')
    expect(resolveRole({ token: 'wrong' }, env)).toBe('reader')
  })
  it('an empty maintainerToken never authenticates', () => {
    expect(resolveRole({ token: '' }, { maintainerToken: '', issueWorktrees: [] })).toBe('reader')
  })
})

describe('PROC_MIN_ROLE', () => {
  it('queries are reader, work ops are worker, structural ops are maintainer', () => {
    expect(PROC_MIN_ROLE.list ?? 'reader').toBe('reader')
    expect(PROC_MIN_ROLE.claim).toBe('worker')
    expect(PROC_MIN_ROLE.create).toBe('maintainer')
    expect(PROC_MIN_ROLE.archive).toBe('maintainer')
    expect(ROLE_RANK.maintainer).toBeGreaterThan(ROLE_RANK.worker)
    expect(ROLE_RANK.worker).toBeGreaterThan(ROLE_RANK.reader)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issue-roles.test.ts`
Expected: FAIL — cannot find `./issue-roles`.

- [ ] **Step 3: Implement**

Create `apps/server/src/issue-roles.ts`:

```ts
export type Role = 'reader' | 'worker' | 'maintainer'

export const ROLE_RANK: Record<Role, number> = { reader: 0, worker: 1, maintainer: 2 }

/** Minimum role to call each issues.* procedure. Unlisted ⇒ 'reader'. Tunable policy. */
export const PROC_MIN_ROLE: Record<string, Role> = {
  // worker — do the work on issues
  claim: 'worker',
  update: 'worker',
  addComment: 'worker',
  defer: 'worker',
  close: 'worker',
  start: 'worker',
  addSession: 'worker',
  addShell: 'worker',
  action: 'worker',
  applySuggestion: 'worker',
  dismissSuggestion: 'worker',
  refreshAssistant: 'worker',
  depAdd: 'worker',
  // maintainer — structural / destructive / cross-cutting
  create: 'maintainer',
  archive: 'maintainer',
  setLabels: 'maintainer',
  depRemove: 'maintainer',
  reparent: 'maintainer',
  supersede: 'maintainer',
  duplicate: 'maintainer',
}

/** Pure role resolution. maintainer iff token matches; worker iff cwd is inside an issue
 *  worktree; reader otherwise (fail-safe). */
export function resolveRole(
  cred: { token?: string; cwd?: string },
  env: { maintainerToken: string; issueWorktrees: string[] },
): Role {
  if (cred.token && env.maintainerToken && cred.token === env.maintainerToken) return 'maintainer'
  const cwd = cred.cwd
  if (cwd && env.issueWorktrees.some((w) => cwd === w || cwd.startsWith(w.endsWith('/') ? w : `${w}/`))) {
    return 'worker'
  }
  return 'reader'
}
```

In `apps/server/src/local-machine.ts`, add (mirroring `readOrCreateDaemonSecret`; reuse its imports — `join`, `readFileSync`, `writeFileSync`, `mkdirSync`, `randomBytes`, `stateDir`):

```ts
/** The maintainer capability token for the issue tracker — read (or created 0600) from the
 *  state dir. A local operator who can read this file gets maintainer; agents that can't,
 *  don't. Mirrors readOrCreateDaemonSecret (same wx-race handling). */
export function readOrCreateMaintainerToken(dir: string = stateDir()): string {
  const path = join(dir, 'issue-maintainer.token')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return existing
  } catch {
    // not created yet
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path, token, { mode: 0o600, flag: 'wx' })
    return token
  } catch {
    return readFileSync(path, 'utf8').trim()
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run apps/server/src/issue-roles.test.ts` then `bun run typecheck`. Also `npx biome check apps/server/src/issue-roles.ts` → exit 0. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issue-roles.ts apps/server/src/issue-roles.test.ts apps/server/src/local-machine.ts
git commit -m "feat(tracker): role model + maintainer token"
```

---

### Task 2: `createContext` role wiring + `issues.*` role gate

**Files:**
- Modify: `apps/server/src/router.ts` — `Context` += `role`; `issueProc` = guarded procedure; use it for every `issues.*` procedure; import `TRPCError` + role types.
- Modify: `apps/server/src/issues.ts` — add `worktreePaths(): string[]` to `IssueService`.
- Modify: `apps/server/src/server.ts` — mint maintainer token; resolve role in `createContext`.
- Test: `apps/server/src/issue-roles-gate.test.ts` (create) — `createCaller` per role × procedure.

**Interfaces:**
- Consumes: `Role`/`ROLE_RANK`/`PROC_MIN_ROLE`/`resolveRole` (Task 1), `readOrCreateMaintainerToken` (Task 1).
- Produces: `Context` gains `role: Role`. `IssueService.worktreePaths(): string[]` (non-null worktree paths of all issues). All `issues.*` procedures enforce `ROLE_RANK[ctx.role] >= PROC_MIN_ROLE[proc]` (via `issueProc`), throwing `TRPCError({code:'FORBIDDEN'})` otherwise.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/issue-roles-gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { SessionStore } from './store'
import { SessionRegistry } from './registry'
import { RepoRegistry } from './repo-registry'
import { SuperagentService } from './superagent'
import type { Role } from './issue-roles'

function caller(role: Role) {
  const store = new SessionStore(':memory:')
  const registry = new SessionRegistry(store)
  const repos = new RepoRegistry(registry, store)
  const superagent = new SuperagentService(registry, repos, store)
  return appRouter.createCaller({ registry, repos, superagent, role })
}

describe('issues.* role gate', () => {
  it('reader may query but not mutate', async () => {
    const c = caller('reader')
    await expect(c.issues.list({})).resolves.toBeDefined() // reader OK
    await expect(c.issues.create({ repoPath: '/r', title: 'x', startNow: false })).rejects.toThrow(/FORBIDDEN|role/i)
  })
  it('worker may claim/update but not create', async () => {
    const c = caller('worker')
    await expect(c.issues.create({ repoPath: '/r', title: 'x', startNow: false })).rejects.toThrow(/FORBIDDEN|role/i)
    // a worker-tier call reaches the service (then errors on unknown id, not on the gate):
    await expect(c.issues.claim({ id: 'iss_missing', assignee: 'a' })).rejects.not.toThrow(/FORBIDDEN/i)
  })
  it('maintainer may create', async () => {
    const c = caller('maintainer')
    const w = await c.issues.create({ repoPath: '/r', title: 'x', startNow: false })
    expect(w.seq).toBe(1)
  })
})
```

(Verify the import paths for `SessionRegistry`/`RepoRegistry`/`SuperagentService` against the actual files; adjust if the constructor signatures differ. If constructing `SessionRegistry`/`SuperagentService` starts background timers, call any available dispose in an afterEach, or keep the test minimal — these are `:memory:` and short-lived.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issue-roles-gate.test.ts`
Expected: FAIL — `createCaller` ctx missing `role` (type error) / no gate (create succeeds for reader).

- [ ] **Step 3: Implement the gate**

In `apps/server/src/router.ts`:

1. Extend the imports: `import { TRPCError } from '@trpc/server'` (if not already) and `import { PROC_MIN_ROLE, ROLE_RANK, type Role } from './issue-roles'`.
2. Add `role: Role` to the `Context` interface (the one passed to `initTRPC.context<Context>()`).
3. After `const t = initTRPC.context<Context>().create()`, define the guard + guarded procedure:

```ts
/** Enforce the per-procedure minimum role for every issues.* call. */
const issueRoleGuard = t.middleware(({ ctx, path, next }) => {
  const proc = path.split('.').pop() ?? ''
  const need = PROC_MIN_ROLE[proc] ?? 'reader'
  if (ROLE_RANK[ctx.role] < ROLE_RANK[need]) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `role '${ctx.role}' may not '${proc}' (needs '${need}')` })
  }
  return next()
})
const issueProc = t.procedure.use(issueRoleGuard)
```

4. In the `issues: t.router({ ... })` block, replace every `t.procedure` with `issueProc` (scoped to that block ONLY — do not touch other routers). Each procedure keeps its `.input(...).query/mutation(...)` unchanged.

In `apps/server/src/issues.ts`, add to `IssueService`:

```ts
  /** Worktree paths of all issues (for cwd-based worker-role resolution). */
  worktreePaths(): string[] {
    return [...this.rows.values()].map((r) => r.worktreePath).filter((p): p is string => !!p)
  }
```

In `apps/server/src/server.ts`:

1. Import `readOrCreateMaintainerToken` from `./local-machine` and `resolveRole` from `./issue-roles`.
2. Mint the maintainer token near the bootstrap token: `const maintainerToken = readOrCreateMaintainerToken()`.
3. Change the `createContext` to read headers from the Hono context and resolve the role:

```ts
    trpcServer({
      router: appRouter,
      createContext: (_opts, c) => ({
        registry,
        repos,
        superagent,
        role: resolveRole(
          { token: c.req.header('x-podium-issue-token'), cwd: c.req.header('x-podium-issue-cwd') },
          { maintainerToken, issueWorktrees: registry.issues.worktreePaths() },
        ),
      }),
    }),
```

(Confirm the `@hono/trpc-server` `createContext` signature passes the Hono context as the 2nd arg `c`; v0.3.4 does. If the arg order differs, read the type and adjust.)

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run apps/server/src/issue-roles-gate.test.ts apps/server/src/issues.test.ts` then `bun run typecheck`. Expected: PASS; clean. The existing `apps/server/src/issue-cli.e2e.test.ts` will now FAIL (its no-credential CLI calls create/claim/close as reader) — that is fixed in Task 3; for now confirm the gate test + unit suite pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/router.ts apps/server/src/issues.ts apps/server/src/server.ts apps/server/src/issue-roles-gate.test.ts
git commit -m "feat(tracker): enforce reader/worker/maintainer gate on issues procedures"
```

---

### Task 3: CLI + MCP present credentials (+ fix the e2e for the gate)

**Files:**
- Modify: `apps/server/src/issue-client.ts` — `makeIssueClient(baseUrl, cred?)` adds `x-podium-issue-token` / `x-podium-issue-cwd` headers.
- Modify: `scripts/issue-cli.ts` — `issueCliMain` reads the maintainer token file (if readable) + `process.cwd()` and passes them.
- Modify: `apps/server/src/server.ts` — the in-process MCP issue client presents the maintainer token.
- Modify: `apps/server/src/issue-cli.e2e.test.ts` — present the maintainer token so the gated flow works.
- Test: `apps/server/src/issue-client.test.ts` (create) — header wiring; plus the updated e2e.

**Interfaces:**
- `makeIssueClient(baseUrl: string, cred?: { token?: string; cwd?: string })` — when `cred` is given, `httpBatchLink({ url, headers: () => ({ ...(token?{'x-podium-issue-token':token}:{}) , ...(cwd?{'x-podium-issue-cwd':cwd}:{}) }) })`.
- Consumes: `readOrCreateMaintainerToken` (read the file path without creating, in the CLI) — actually the CLI should READ the token if present but NOT create it (creating is the server's job); use a `readMaintainerToken(dir?): string | undefined` helper (add to `local-machine.ts`) that returns the file content or undefined.

- [ ] **Step 1: Write the failing test**

Add `readMaintainerToken` to the plan's Task-1 file conceptually, but implement here. Create `apps/server/src/issue-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeIssueClient } from './issue-client'

describe('makeIssueClient credentials', () => {
  it('builds a client (smoke) with and without creds', () => {
    expect(makeIssueClient('http://localhost:1')).toBeDefined()
    expect(makeIssueClient('http://localhost:1', { token: 't', cwd: '/x' })).toBeDefined()
  })
})
```

(The header wiring itself is verified end-to-end by the updated e2e in Step 3; this unit test is a construction smoke since `httpBatchLink` headers are only sent on a real request.)

Update `apps/server/src/issue-cli.e2e.test.ts`: in `beforeAll`, after creating the temp `stateDir` and BEFORE `startServer`, the server will mint the maintainer token into `stateDir`. In the test body, read it and pass it to `makeIssueClient` so the gated create/claim/close succeed:

```ts
import { readMaintainerToken } from './local-machine'
// … inside the test, after startServer:
const token = readMaintainerToken(stateDir)
const client = makeIssueClient(baseUrl, { token, cwd: '/repo' })
```

(The maintainer token grants full access; the rest of the e2e assertions are unchanged.)

- [ ] **Step 2: Run to verify current state**

Run: `npx vitest run apps/server/src/issue-cli.e2e.test.ts`
Expected: FAIL — without creds the gated `create` returns FORBIDDEN (red), proving the gate is active; the Step-3 changes make it green.

- [ ] **Step 3: Implement**

In `apps/server/src/local-machine.ts`, add a read-only helper:

```ts
/** Read the maintainer token if it exists (does NOT create it — that's the server's job). */
export function readMaintainerToken(dir: string = stateDir()): string | undefined {
  try {
    const t = readFileSync(join(dir, 'issue-maintainer.token'), 'utf8').trim()
    return t || undefined
  } catch {
    return undefined
  }
}
```

In `apps/server/src/issue-client.ts`, extend `makeIssueClient`:

```ts
export function makeIssueClient(baseUrl: string, cred?: { token?: string; cwd?: string }) {
  const headers = (): Record<string, string> => ({
    ...(cred?.token ? { 'x-podium-issue-token': cred.token } : {}),
    ...(cred?.cwd ? { 'x-podium-issue-cwd': cred.cwd } : {}),
  })
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${baseUrl}/trpc`, headers })] })
}
```

In `scripts/issue-cli.ts` `issueCliMain`, read the operator's maintainer token + cwd and pass them:

```ts
export async function issueCliMain(argv: string[]): Promise<void> {
  const port = Number(process.env.PODIUM_PORT) || 18787
  const { readMaintainerToken } = await import('../apps/server/src/local-machine')
  const token = process.env.PODIUM_ISSUE_TOKEN ?? readMaintainerToken()
  const client = makeIssueClient(`http://localhost:${port}`, { ...(token ? { token } : {}), cwd: process.cwd() })
  try {
    console.log(await runIssueCli(argv, client))
  } catch (err) {
    console.error(`podium issue: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
```

In `apps/server/src/server.ts`, the in-process MCP issue client (set in the post-bind callback) presents the maintainer token (the orchestrator is trusted):

```ts
      issueTools.setClient(makeIssueClient(`http://127.0.0.1:${info.port}`, { token: maintainerToken }))
```

Then apply the e2e update from Step 1.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/issue-client.test.ts apps/server/src/issue-cli.e2e.test.ts apps/server/src/issue-roles-gate.test.ts` then `bun run typecheck`. Expected: PASS (the e2e is green again WITH the maintainer token; without it, the gate would reject — that's the point). `npx biome check apps/server/src/issue-client.ts apps/server/src/issue-roles.ts` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issue-client.ts apps/server/src/issue-client.test.ts scripts/issue-cli.ts apps/server/src/server.ts apps/server/src/local-machine.ts apps/server/src/issue-cli.e2e.test.ts
git commit -m "feat(tracker): CLI/MCP present role credentials (maintainer token + cwd)"
```

---

## Phase Close (P3b)

- [ ] Full P3 + tracker scope green: `npx vitest run apps/server/src/issue-roles.test.ts apps/server/src/issue-roles-gate.test.ts apps/server/src/issue-commands.test.ts apps/server/src/issue-mcp.test.ts apps/server/src/issue-client.test.ts scripts/issue-cli.test.ts apps/server/src/issue-cli.e2e.test.ts apps/server/src/issues.test.ts apps/server/src/superagent.test.ts`
- [ ] `bun run typecheck` clean; `biome check` clean on new files.
- [ ] Close `podium-hi7.3` (P3 done: P3a CLI+MCP + P3b roles).
- [ ] Hand off to **P4 plan** (UI surfacing). File a follow-on issue for the deferred hardening: **spawn-time worker-token injection** (give worker agents a per-issue token via the relay→daemon spawn `env` path) + **per-issue worker scoping** (a worker may only mutate its own issue), which this tier-only v1 leaves open.

## Self-Review notes (author)

- **Spec coverage (P3b):** reader/worker/maintainer tiers (Task 1) ✓; server-side enforcement on every issues.* proc (Task 2) ✓; credentials presented by CLI + MCP (Task 3) ✓; maintainer = trusted operator (token file) ✓; worker = agent in a worktree (cwd) ✓; reader default (fail-safe) ✓. DEFERRED (explicit follow-on): spawn-time worker-token injection + per-issue worker scoping (the spec's "scoped to their issue, injected at spawn" — held out of v1 to avoid the relay→daemon spawn-protocol change).
- **Placeholder scan:** none — every step has complete code.
- **Type-consistency:** `Context.role: Role` flows createContext → `issueProc`/guard → every issues proc; `resolveRole` is the single role authority used by both server.ts (request) and the tests; `PROC_MIN_ROLE` keys are the issues procedure names (must match the router's actual proc names — Task 2 replaces `t.procedure` with `issueProc` inside the issues block).
- **Risks:** (1) the only `createContext`/`createCaller` site is `server.ts` — grep to confirm before making `role` required on `Context` (Task 2). (2) `@hono/trpc-server` v0.3.4 `createContext(opts, c)` arg order — verify the Hono context is the 2nd param. (3) the gate changes the default from open to reader, so the P3a e2e MUST present the maintainer token (Task 3) — without it the gated mutations correctly 403. (4) the in-process MCP presents the maintainer token (orchestrator trusted) — acceptable for v1 since the only wired MCP consumer is the superagent orchestrator; worker-scoped MCP for spawned agents is the deferred hardening.
