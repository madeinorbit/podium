# Web UI Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake "Command Center" web prototype with a real, responsive workspace UI that lists repos/worktrees, lists Claude+Codex conversation history, and starts or resumes agent sessions in a worktree — with desktop tiling that folds to a single-panel mobile shell.

**Architecture:** Add a "repos" discovery plane over the wire (the git-discovery library already exists; it just isn't exposed) parallel to the existing conversation `scan`, plus a persisted repo-root registry on the server. Rebuild `apps/web` from scratch around the existing `@podium/terminal-client` (`SocketHub`, `mountSession`) and tRPC primitives: a sidebar navigator (repos → worktrees → live panels), a per-worktree workspace (tab bar + up-to-two panes), and a mobile shell sharing the same server-authoritative session state.

**Tech Stack:** TypeScript ESM, Bun workspace, Vitest, Zod (`@podium/protocol`), tRPC (`@podium/server`), React 19 + Vite (`apps/web`), `@podium/agent-bridge` (Node git/conversation discovery), `@podium/terminal-client` (xterm + relay client). Lint/format: Biome.

**Spec:** `docs/superpowers/specs/2026-06-03-web-ui-rebuild-design.md`

**Conventions to follow (verified against the codebase):**
- Run a single workspace's tests: `bun run --filter <pkg> test` is not defined; use `bunx vitest run <path>` from the repo root (root `vitest.config.ts` resolves `@podium/source`). Typecheck one workspace: `bun run --filter <name> typecheck`.
- Protocol messages are Zod schemas in `packages/protocol/src/messages.ts`; every wire message is added to the relevant discriminated union and gets a codec round-trip test in `messages.test.ts`.
- Optional fields are spread conditionally on the daemon mapper (`...(x !== undefined ? { x } : {})`) so absent fields stay absent (matches `summaryToWire`).
- Commit per task with a conventional-commit message.

---

## File Structure

**Backend (modify):**
- `packages/protocol/src/messages.ts` — add `GitWorktreeWire`, `GitRepositoryWire`, `GitDiscoveryDiagnosticWire`, `ScanReposRequestMessage` (→ `ControlMessage`), `ScanReposResultMessage` (→ `DaemonMessage`).
- `apps/daemon/src/daemon.ts` — handle `scanReposRequest`; map git summaries → wire.
- `apps/server/src/repo-registry.ts` *(create)* — persisted absolute-path list.
- `apps/server/src/relay.ts` — `scanRepos(roots)` round-trip (mirror `scan()`).
- `apps/server/src/router.ts` — `repos.list/add/remove` + `discovery.scanRepos`.

**Frontend (`apps/web/src`) — remove `App.tsx`, `App.css`, `LiveSessions.tsx`; create:**
- `types.ts` — view types derived from wire types.
- `derive.ts` — pure functions: group repos→worktrees, match sessions/conversations to a worktree (unit-tested).
- `styles.css` — design tokens + layout (dark theme).
- `store.tsx` — connects `SocketHub` + tRPC, holds server feeds + client view state, exposes hooks.
- `ConnectScreen.tsx` — enter relay URL.
- `Sidebar.tsx` — repos → worktrees → live panels; Add repo.
- `Workspace.tsx` — tab bar + 1–2 pane split.
- `AgentPanel.tsx` — mounts a terminal via `mountSession`.
- `NewPanelMenu.tsx` — New Claude / New Codex / Resume…
- `MobileApp.tsx` — header + picker sheet + single panel.
- `AppShell.tsx` — responsive desktop/mobile switch + connect gate.
- `main.tsx` — mount `AppShell`.
- `test/derive.test.ts`, `test/shell.structure.test.ts` *(replace `test/App.structure.test.ts`)*.

---

## Phase A — Protocol: the repos plane

### Task A1: Repo wire types + scan messages

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Add the failing codec test cases**

In `messages.test.ts`, extend the `ControlMessage` and `DaemonMessage` case arrays and add a repo-shape round-trip. Append inside the existing `describe('ControlMessage ...')` array a new case, and likewise for `DaemonMessage`:

```ts
// add to the ControlMessage `cases` array:
{ type: 'scanReposRequest', requestId: 'rr1', roots: ['/home/u/src'] },

// add to the DaemonMessage `cases` array:
{
  type: 'scanReposResult',
  requestId: 'rr1',
  repositories: [
    {
      path: '/home/u/src/app',
      kind: 'repository',
      branch: 'main',
      headSha: 'abc',
      worktrees: [{ path: '/home/u/src/app-feat', branch: 'feat', locked: false }],
    },
  ],
  diagnostics: [{ severity: 'warning', path: '/bad', message: 'nope' }],
},
```

And add a standalone schema test inside `describe('shared schemas', ...)`:

```ts
it('round-trips a GitRepositoryWire with worktrees', () => {
  const repo = {
    path: '/r',
    kind: 'repository' as const,
    branch: 'main',
    worktrees: [{ path: '/r-wt', branch: 'feat' }],
  }
  expect(GitRepositoryWire.parse(repo)).toEqual(repo)
})
```

Add `GitRepositoryWire` to the imports from `./messages` at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run packages/protocol/src/messages.test.ts`
Expected: FAIL — `GitRepositoryWire` is not exported / `scanReposRequest` rejected by the union.

- [ ] **Step 3: Add the schemas and extend the unions**

In `packages/protocol/src/messages.ts`, after the `ConversationDiagnosticWire` block, add:

```ts
// ---- Git discovery payloads (JSON-safe subset of the agent-bridge git summaries) ----
export const GitWorktreeWire = z.object({
  path: z.string(),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  locked: z.boolean().optional(),
  prunable: z.boolean().optional(),
})
export type GitWorktreeWire = z.infer<typeof GitWorktreeWire>

export const GitRepositoryWire = z.object({
  path: z.string(),
  kind: z.enum(['repository', 'worktree', 'bare']),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  originUrl: z.string().optional(),
  worktrees: z.array(GitWorktreeWire),
})
export type GitRepositoryWire = z.infer<typeof GitRepositoryWire>

export const GitDiscoveryDiagnosticWire = z.object({
  severity: z.enum(['warning', 'error']),
  path: z.string(),
  message: z.string(),
})
export type GitDiscoveryDiagnosticWire = z.infer<typeof GitDiscoveryDiagnosticWire>
```

In the `// server -> daemon` section, after `ScanRequestMessage`, add:

```ts
export const ScanReposRequestMessage = z.object({
  type: z.literal('scanReposRequest'),
  requestId: z.string(),
  roots: z.array(z.string()),
})
```

Add `ScanReposRequestMessage` to the `ControlMessage` discriminated union array.

In the `// daemon -> server` section, after `ScanResultMessage`, add:

```ts
export const ScanReposResultMessage = z.object({
  type: z.literal('scanReposResult'),
  requestId: z.string(),
  repositories: z.array(GitRepositoryWire),
  diagnostics: z.array(GitDiscoveryDiagnosticWire),
})
```

Add `ScanReposResultMessage` to the `DaemonMessage` discriminated union array.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run packages/protocol/src/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `bun run --filter @podium/protocol typecheck`
Expected: no errors.

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): add git repos scan request/result messages"
```

---

## Phase B — Daemon: serve the repos scan

### Task B1: Handle `scanReposRequest`

**Files:**
- Modify: `apps/daemon/src/daemon.ts`
- Test: `apps/daemon/src/daemon.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `daemon.test.ts`. Reuse the hand-built fixture style from the git scanner tests (no real `git` binary). Add these imports at the top if missing: `mkdir`, `writeFile` are already imported; add nothing new. Inside `describe('daemon multi-bridge', ...)` add:

```ts
it('scanReposRequest returns a wire-valid repository for a seeded repo root', async () => {
  // Hand-build a minimal git repo (mirrors packages/agent-bridge git scanner fixtures).
  const root = await mkdtemp(join(tmpdir(), 'podium-repos-'))
  const repo = join(root, 'app')
  const gitDir = join(repo, '.git')
  await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true })
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(gitDir, 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`)

  send({ type: 'scanReposRequest', requestId: 'rr-1', roots: [root] })
  await waitFor(() => received.some((m) => m.type === 'scanReposResult'))

  const result = received.find(
    (m): m is Extract<DaemonMessage, { type: 'scanReposResult' }> =>
      m.type === 'scanReposResult',
  )
  expect(result?.requestId).toBe('rr-1')
  expect(result?.repositories.map((r) => r.path)).toContain(repo)
  const found = result?.repositories.find((r) => r.path === repo)
  expect(found?.branch).toBe('main')
  expect(Array.isArray(found?.worktrees)).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run apps/daemon/src/daemon.test.ts -t scanReposRequest`
Expected: FAIL — `scanReposResult` never arrives (handler missing).

- [ ] **Step 3: Implement the handler + mapper**

In `apps/daemon/src/daemon.ts`, extend the imports:

```ts
import {
  type AgentConversationDiagnostic,
  type AgentConversationSummary,
  type AgentSession,
  type GitDiscoveryDiagnostic,
  type GitRepositorySummary,
  agentLaunchCommand,
  scanAgentConversations,
  scanGitRepositoriesAtPath,
  spawnAgent,
} from '@podium/agent-bridge'
import {
  type ControlMessage,
  type ConversationDiagnosticWire,
  type ConversationSummaryWire,
  type DaemonMessage,
  type GitDiscoveryDiagnosticWire,
  type GitRepositoryWire,
  encode,
  parseControlMessage,
} from '@podium/protocol'
```

Add mappers next to `summaryToWire`:

```ts
function repoToWire(r: GitRepositorySummary): GitRepositoryWire {
  return {
    path: r.path,
    kind: r.kind,
    ...(r.branch !== undefined ? { branch: r.branch } : {}),
    ...(r.headSha !== undefined ? { headSha: r.headSha } : {}),
    ...(r.originUrl !== undefined ? { originUrl: r.originUrl } : {}),
    worktrees: (r.worktrees ?? []).map((w) => ({
      path: w.path,
      ...(w.branch !== undefined ? { branch: w.branch } : {}),
      ...(w.headSha !== undefined ? { headSha: w.headSha } : {}),
      ...(w.locked !== undefined ? { locked: w.locked } : {}),
      ...(w.prunable !== undefined ? { prunable: w.prunable } : {}),
    })),
  }
}

function gitDiagnosticToWire(d: GitDiscoveryDiagnostic): GitDiscoveryDiagnosticWire {
  return { severity: d.severity, path: d.path, message: d.message }
}
```

Add the scan function next to `scan`:

```ts
const scanRepos = async (requestId: string, roots: string[]): Promise<void> => {
  const repositories: GitRepositoryWire[] = []
  const diagnostics: GitDiscoveryDiagnosticWire[] = []
  for (const root of roots) {
    try {
      const result = await scanGitRepositoriesAtPath(root)
      for (const repo of result.repositories) repositories.push(repoToWire(repo))
      for (const d of result.diagnostics) diagnostics.push(gitDiagnosticToWire(d))
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        path: root,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  send({ type: 'scanReposResult', requestId, repositories, diagnostics })
}
```

In the `ws.on('message', ...)` switch, add a case:

```ts
case 'scanReposRequest':
  void scanRepos(msg.requestId, msg.roots)
  break
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run apps/daemon/src/daemon.test.ts -t scanReposRequest`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `bun run --filter @podium/daemon typecheck`

```bash
git add apps/daemon/src/daemon.ts apps/daemon/src/daemon.test.ts
git commit -m "feat(daemon): serve git repos scan over the wire"
```

---

## Phase C — Server: registry + scanRepos + tRPC

### Task C1: Repo-root registry (persisted JSON)

**Files:**
- Create: `apps/server/src/repo-registry.ts`
- Test: `apps/server/src/repo-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/repo-registry.test.ts
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RepoRegistry } from './repo-registry'

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'podium-reporeg-'))
  return join(dir, 'repos.json')
}

describe('RepoRegistry', () => {
  it('starts empty, adds, dedupes, lists, removes', async () => {
    const file = await tmpFile()
    const reg = new RepoRegistry(file)
    await reg.load()
    expect(reg.list()).toEqual([])
    await reg.add('/home/u/src/app')
    await reg.add('/home/u/src/app') // dedupe
    expect(reg.list()).toEqual(['/home/u/src/app'])
    await reg.remove('/home/u/src/app')
    expect(reg.list()).toEqual([])
  })

  it('rejects non-absolute and empty paths', async () => {
    const reg = new RepoRegistry(await tmpFile())
    await reg.load()
    await expect(reg.add('')).rejects.toThrow()
    await expect(reg.add('relative/path')).rejects.toThrow()
  })

  it('persists across instances', async () => {
    const file = await tmpFile()
    const a = new RepoRegistry(file)
    await a.load()
    await a.add('/abs/one')
    const b = new RepoRegistry(file)
    await b.load()
    expect(b.list()).toEqual(['/abs/one'])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(['/abs/one'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run apps/server/src/repo-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

```ts
// apps/server/src/repo-registry.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** Default state file: $PODIUM_STATE_DIR/repos.json, else ~/.podium/repos.json. */
export function defaultRegistryPath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(homedir(), '.podium')
  return join(base, 'repos.json')
}

/** Persisted list of absolute repo-root paths. Shared by all clients so the
 *  repo list survives and shows on every device (desktop + phone). */
export class RepoRegistry {
  private roots: string[] = []
  constructor(private readonly file: string = defaultRegistryPath()) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.roots = Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
    } catch {
      this.roots = [] // missing/corrupt file → empty registry
    }
  }

  list(): string[] {
    return [...this.roots]
  }

  async add(path: string): Promise<void> {
    const p = path.trim()
    if (!p) throw new Error('repo path is empty')
    if (!isAbsolute(p)) throw new Error(`repo path must be absolute: ${p}`)
    if (!this.roots.includes(p)) {
      this.roots.push(p)
      await this.persist()
    }
  }

  async remove(path: string): Promise<void> {
    const before = this.roots.length
    this.roots = this.roots.filter((r) => r !== path)
    if (this.roots.length !== before) await this.persist()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.roots, null, 2))
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run apps/server/src/repo-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/repo-registry.ts apps/server/src/repo-registry.test.ts
git commit -m "feat(server): persisted repo-root registry"
```

### Task C2: `SessionRegistry.scanRepos` round-trip

**Files:**
- Modify: `apps/server/src/relay.ts`
- Test: `apps/server/src/relay.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `relay.test.ts`:

```ts
it('scanRepos correlates the daemon scanReposResult back to the caller', async () => {
  const reg = new SessionRegistry()
  const daemon: ControlMessage[] = []
  reg.attachDaemon((m) => daemon.push(m))
  const p = reg.scanRepos(['/home/u/src'])
  const req = daemon.find((m) => m.type === 'scanReposRequest') as
    | { requestId: string; roots: string[] }
    | undefined
  expect(req).toBeDefined()
  if (!req) throw new Error('scanReposRequest not sent')
  expect(req.roots).toEqual(['/home/u/src'])
  reg.onDaemonMessage({
    type: 'scanReposResult',
    requestId: req.requestId,
    repositories: [{ path: '/r', kind: 'repository', worktrees: [] }],
    diagnostics: [],
  })
  await expect(p).resolves.toMatchObject({ repositories: [{ path: '/r' }], diagnostics: [] })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run apps/server/src/relay.test.ts -t scanRepos`
Expected: FAIL — `reg.scanRepos` is not a function.

- [ ] **Step 3: Implement scanRepos (mirror `scan`)**

In `relay.ts`, extend the protocol type imports with `GitRepositoryWire`, `GitDiscoveryDiagnosticWire`. Add a result type next to `ScanResult`:

```ts
export interface ScanReposResult {
  repositories: GitRepositoryWire[]
  diagnostics: GitDiscoveryDiagnosticWire[]
}
```

Add a pending map field next to `pendingScans`:

```ts
private readonly pendingRepoScans = new Map<string, (r: ScanReposResult) => void>()
```

Add the method next to `scan()`:

```ts
scanRepos(roots: string[]): Promise<ScanReposResult> {
  const requestId = `rr${this.nextRequestNum++}`
  return new Promise<ScanReposResult>((resolve) => {
    const timer = setTimeout(() => {
      this.pendingRepoScans.delete(requestId)
      resolve({
        repositories: [],
        diagnostics: [{ severity: 'error', path: '', message: 'repos scan timed out' }],
      })
    }, SCAN_TIMEOUT_MS)
    timer.unref?.()
    this.pendingRepoScans.set(requestId, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    this.toDaemon({ type: 'scanReposRequest', requestId, roots })
  })
}
```

In `onDaemonMessage`, add a case alongside `scanResult`:

```ts
case 'scanReposResult': {
  const resolve = this.pendingRepoScans.get(msg.requestId)
  if (resolve) {
    this.pendingRepoScans.delete(msg.requestId)
    resolve({ repositories: msg.repositories, diagnostics: msg.diagnostics })
  }
  break
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run apps/server/src/relay.test.ts -t scanRepos`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(server): relay round-trip for git repos scan"
```

### Task C3: tRPC `repos.*` + `discovery.scanRepos`

**Files:**
- Modify: `apps/server/src/router.ts`, `apps/server/src/index.ts` (wire the registry into context)
- Test: `apps/server/src/router.test.ts`

- [ ] **Step 1: Inspect how context is built**

Run: `sed -n '1,80p' apps/server/src/index.ts apps/server/src/server.ts`
Expected: find where `{ registry }` context is constructed (the `Context` passed to `appRouter`). You will add `repos: RepoRegistry` to that context object and instantiate + `await load()` it once at startup.

- [ ] **Step 2: Write the failing router test**

Add to `router.test.ts` a helper that injects a registry, and tests:

```ts
import { RepoRegistry } from './repo-registry'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function repoCaller() {
  const dir = await mkdtemp(join(tmpdir(), 'podium-router-'))
  const repos = new RepoRegistry(join(dir, 'repos.json'))
  await repos.load()
  const registry = new SessionRegistry()
  const daemon: import('@podium/protocol').ControlMessage[] = []
  registry.attachDaemon((m) => daemon.push(m))
  return { registry, repos, daemon, call: appRouter.createCaller({ registry, repos }) }
}

describe('repos router', () => {
  it('repos.add then repos.list reflects it', async () => {
    const { call } = await repoCaller()
    await call.repos.add({ path: '/abs/app' })
    expect(await call.repos.list()).toEqual(['/abs/app'])
  })

  it('repos.remove drops it', async () => {
    const { call } = await repoCaller()
    await call.repos.add({ path: '/abs/app' })
    await call.repos.remove({ path: '/abs/app' })
    expect(await call.repos.list()).toEqual([])
  })

  it('discovery.scanRepos forwards registry roots and resolves', async () => {
    const { call, repos, registry, daemon } = await repoCaller()
    await repos.add({ path: '/abs/app' } as never).catch(() => {})
    await repos.add('/abs/app')
    const p = call.discovery.scanRepos()
    await Promise.resolve()
    const req = daemon.find((m) => m.type === 'scanReposRequest') as
      | { requestId: string; roots: string[] }
      | undefined
    expect(req?.roots).toEqual(['/abs/app'])
    if (!req) throw new Error('no scanReposRequest')
    registry.onDaemonMessage({
      type: 'scanReposResult',
      requestId: req.requestId,
      repositories: [],
      diagnostics: [],
    })
    await expect(p).resolves.toEqual({ repositories: [], diagnostics: [] })
  })
})
```

Note: the existing `caller()` helper builds context as `{ registry }`; update it to `{ registry, repos: new RepoRegistry(...) }` only if TypeScript requires `repos` on `Context` — simplest is to give `Context.repos` and update `caller()` to pass a throwaway registry. Adjust the existing `caller()` to:

```ts
function caller() {
  const registry = new SessionRegistry()
  registry.attachDaemon(() => {})
  const repos = new RepoRegistry(join(tmpdir(), `podium-${Math.random().toString(36).slice(2)}.json`))
  return { registry, call: appRouter.createCaller({ registry, repos }) }
}
```

(Add the `RepoRegistry`, `tmpdir`, `join` imports to the test.)

- [ ] **Step 3: Run to verify it fails**

Run: `bunx vitest run apps/server/src/router.test.ts`
Expected: FAIL — `Context` has no `repos`; `repos` router undefined.

- [ ] **Step 4: Implement the router additions**

In `router.ts`, extend `Context` and add the procedures:

```ts
import type { SessionRegistry } from './relay'
import type { RepoRegistry } from './repo-registry'

export interface Context {
  registry: SessionRegistry
  repos: RepoRegistry
}
```

Add to `appRouter`:

```ts
repos: t.router({
  list: t.procedure.query(({ ctx }) => ctx.repos.list()),
  add: t.procedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.repos.add(input.path)
      return ctx.repos.list()
    }),
  remove: t.procedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.repos.remove(input.path)
      return ctx.repos.list()
    }),
}),
```

Extend the existing `discovery` router with:

```ts
scanRepos: t.procedure.mutation(({ ctx }) => ctx.registry.scanRepos(ctx.repos.list())),
```

- [ ] **Step 5: Wire the registry into server startup**

In `apps/server/src/index.ts` (or wherever `Context` is constructed — confirmed in Step 1), instantiate and load the registry once, and include it in the context object passed to the tRPC handler:

```ts
import { RepoRegistry } from './repo-registry'
// ... during startup, before creating the request handler:
const repos = new RepoRegistry()
await repos.load()
// ... wherever the context is built: { registry, repos }
```

- [ ] **Step 6: Run to verify it passes + typecheck**

Run: `bunx vitest run apps/server/src/router.test.ts`
Expected: PASS
Run: `bun run --filter @podium/server typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/router.ts apps/server/src/router.test.ts apps/server/src/index.ts
git commit -m "feat(server): repos tRPC procedures + discovery.scanRepos"
```

---

## Phase D — Web foundation: derive logic + shell skeleton

### Task D1: Remove the prototype, add view types

**Files:**
- Remove: `apps/web/src/App.tsx`, `apps/web/src/App.css`, `apps/web/src/LiveSessions.tsx`, `apps/web/test/App.structure.test.ts`
- Create: `apps/web/src/types.ts`

- [ ] **Step 1: Delete the prototype files**

```bash
git rm apps/web/src/App.tsx apps/web/src/App.css apps/web/src/LiveSessions.tsx apps/web/test/App.structure.test.ts
```

- [ ] **Step 2: Add view types**

```ts
// apps/web/src/types.ts
import type {
  ConversationSummaryWire,
  GitRepositoryWire,
  SessionMeta,
} from '@podium/protocol'

/** A worktree as shown in the UI: the repo's own checkout plus each linked worktree. */
export interface WorktreeView {
  path: string
  branch?: string
  repoPath: string
  isMain: boolean
}

export interface RepoView {
  path: string
  name: string
  worktrees: WorktreeView[]
}

export type { ConversationSummaryWire, GitRepositoryWire, SessionMeta }
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/types.ts
git commit -m "chore(web): remove command-center prototype; add view types"
```

### Task D2: Pure derivation functions (TDD)

**Files:**
- Create: `apps/web/src/derive.ts`
- Test: `apps/web/test/derive.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/test/derive.test.ts
import { describe, expect, it } from 'vitest'
import {
  reposToViews,
  sessionsForWorktree,
  resumableForWorktree,
  resumableForRepoFallback,
} from '../src/derive'
import type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'

const repo: GitRepositoryWire = {
  path: '/src/app',
  kind: 'repository',
  branch: 'main',
  worktrees: [{ path: '/src/app-feat', branch: 'feat' }],
}

const session = (cwd: string): SessionMeta => ({
  sessionId: `s-${cwd}`,
  agentKind: 'claude-code',
  title: 't',
  cwd,
  status: 'live',
  controllerId: null,
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 0,
  createdAt: '2026-06-03T00:00:00.000Z',
  origin: { kind: 'spawn' },
})

const conv = (projectPath: string, id: string): ConversationSummaryWire => ({
  id,
  agentKind: 'claude-code',
  providerId: 'p',
  projectPath,
  resume: { kind: 'claude-session', value: id },
})

describe('reposToViews', () => {
  it('lists the repo checkout as main plus linked worktrees', () => {
    const [view] = reposToViews([repo])
    expect(view.name).toBe('app')
    expect(view.worktrees).toEqual([
      { path: '/src/app', branch: 'main', repoPath: '/src/app', isMain: true },
      { path: '/src/app-feat', branch: 'feat', repoPath: '/src/app', isMain: false },
    ])
  })
})

describe('sessionsForWorktree', () => {
  it('matches by exact cwd', () => {
    const all = [session('/src/app'), session('/src/app-feat')]
    expect(sessionsForWorktree(all, '/src/app-feat')).toHaveLength(1)
    expect(sessionsForWorktree(all, '/src/app-feat')[0].cwd).toBe('/src/app-feat')
  })
})

describe('resumable matching', () => {
  it('worktree gets exact projectPath matches', () => {
    const all = [conv('/src/app-feat', 'a'), conv('/src/app', 'b')]
    expect(resumableForWorktree(all, '/src/app-feat').map((c) => c.id)).toEqual(['a'])
  })
  it('repo fallback gets under-repo convs not matched to any worktree', () => {
    const all = [conv('/src/app', 'b'), conv('/src/app-feat', 'a'), conv('/src/other', 'z')]
    const wtPaths = ['/src/app', '/src/app-feat']
    expect(resumableForRepoFallback(all, '/src/app', wtPaths).map((c) => c.id)).toEqual([])
    const all2 = [conv('/src/app/sub', 'c')]
    expect(resumableForRepoFallback(all2, '/src/app', wtPaths).map((c) => c.id)).toEqual(['c'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run apps/web/test/derive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure functions**

```ts
// apps/web/src/derive.ts
import type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'
import type { RepoView, WorktreeView } from './types'

export function reposToViews(repos: GitRepositoryWire[]): RepoView[] {
  return repos.map((r) => {
    const main: WorktreeView = {
      path: r.path,
      ...(r.branch !== undefined ? { branch: r.branch } : {}),
      repoPath: r.path,
      isMain: true,
    }
    const linked: WorktreeView[] = r.worktrees.map((w) => ({
      path: w.path,
      ...(w.branch !== undefined ? { branch: w.branch } : {}),
      repoPath: r.path,
      isMain: false,
    }))
    return { path: r.path, name: r.path.split('/').pop() || r.path, worktrees: [main, ...linked] }
  })
}

export function sessionsForWorktree(sessions: SessionMeta[], worktreePath: string): SessionMeta[] {
  return sessions.filter((s) => s.cwd === worktreePath)
}

export function resumableForWorktree(
  convs: ConversationSummaryWire[],
  worktreePath: string,
): ConversationSummaryWire[] {
  return convs.filter((c) => c.resume && c.projectPath === worktreePath)
}

/** Under the repo root but not matched to any of its worktrees (deduped against worktree matches). */
export function resumableForRepoFallback(
  convs: ConversationSummaryWire[],
  repoPath: string,
  worktreePaths: string[],
): ConversationSummaryWire[] {
  const wt = new Set(worktreePaths)
  return convs.filter(
    (c) =>
      c.resume &&
      c.projectPath !== undefined &&
      !wt.has(c.projectPath) &&
      (c.projectPath === repoPath || c.projectPath.startsWith(`${repoPath}/`)),
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run apps/web/test/derive.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/derive.ts apps/web/test/derive.test.ts
git commit -m "feat(web): pure repo/session/conversation derivation"
```

### Task D3: Design tokens + shell skeleton that compiles

**Files:**
- Create: `apps/web/src/styles.css`
- Modify: `apps/web/src/main.tsx`, `apps/web/index.html`
- Create: `apps/web/src/AppShell.tsx` (skeleton)

- [ ] **Step 1: Add design tokens**

```css
/* apps/web/src/styles.css */
:root {
  --app: #0e0e12; --panel: #16161c; --panel-raised: #1d1d25; --surface: #25252f;
  --border: #2a2a34; --border-strong: #3a3a46;
  --fg: #d7d7e0; --fg-bright: #f3f3f8; --dim: #9a9aa8; --faint: #6a6a78;
  --accent: #f59e0b; --success: #34d399; --warning: #fbbf24; --danger: #f87171;
  --r: 6px;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--app); color: var(--fg);
  font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
}
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.starting { background: var(--warning); }
.dot.live { background: var(--success); }
.dot.exited { background: var(--faint); }
```

- [ ] **Step 2: Skeleton shell (renders the connect screen placeholder)**

```tsx
// apps/web/src/AppShell.tsx
export function AppShell(): JSX.Element {
  return <div className="app-shell">Podium — connecting…</div>
}
```

- [ ] **Step 3: Mount it + fix index.html**

```tsx
// apps/web/src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './AppShell'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Podium web root was not found')
createRoot(root).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
```

In `apps/web/index.html`, change `<title>` to `Podium` and update the description meta to `Podium — agent workspace`.

- [ ] **Step 4: Typecheck + commit**

Run: `bun run --filter @podium/web typecheck`
Expected: no errors.

```bash
git add apps/web/src/styles.css apps/web/src/AppShell.tsx apps/web/src/main.tsx apps/web/index.html
git commit -m "feat(web): dark design tokens + shell skeleton"
```

---

## Phase E — Web: store + components

> Visual styling is refined during execution using the **frontend-design** skill and the dogfood loop in Phase F. Each task below ships a working, typechecking implementation with the real wiring; treat the class names as structural hooks for the design pass. Do not add behavior beyond what the spec lists.

### Task E1: Store — connection + feeds + view state

**Files:**
- Create: `apps/web/src/store.tsx`
- Reuse: `apps/web/src/trpc.ts` (unchanged), `@podium/terminal-client` `SocketHub`

- [ ] **Step 1: Implement the store**

Holds: connection (origin), server feeds (repos, conversations, sessions), and client view state (selected worktree path, split + per-pane active sessionId). Exposes a `useStore()` hook and an imperative `actions` object. Key wiring mirrors `LiveSessions.tsx` (now deleted) but split out of the view.

```tsx
// apps/web/src/store.tsx
import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'
import { SocketHub } from '@podium/terminal-client'
import { makeTrpc, parseServer, type Trpc } from './trpc'

export interface Store {
  hub: SocketHub
  trpc: Trpc
  repos: GitRepositoryWire[]
  conversations: ConversationSummaryWire[]
  sessions: SessionMeta[]
  selectedWorktree: string | null
  setSelectedWorktree: (path: string | null) => void
  paneA: string | null // sessionId in pane A
  paneB: string | null // sessionId in pane B (null = no split)
  setPane: (pane: 'A' | 'B', sessionId: string | null) => void
  split: boolean
  toggleSplit: () => void
  rescanRepos: () => Promise<void>
  rescanConversations: () => Promise<void>
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ origin, children }: { origin: string; children: ReactNode }): JSX.Element {
  const cfg = useMemo(() => parseServer(`?server=${origin}`), [origin])
  if (!cfg) throw new Error(`bad server origin: ${origin}`)

  const hub = useMemo(
    () => new SocketHub({ url: cfg.wsClientUrl, viewport: { cols: 80, rows: 24, dpr: globalThis.devicePixelRatio ?? 1 } }),
    [cfg.wsClientUrl],
  )
  const trpc = useMemo(() => makeTrpc(cfg.httpOrigin), [cfg.httpOrigin])

  const [repos, setRepos] = useState<GitRepositoryWire[]>([])
  const [conversations, setConversations] = useState<ConversationSummaryWire[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(null)
  const [paneA, setPaneA] = useState<string | null>(null)
  const [paneB, setPaneB] = useState<string | null>(null)
  const [split, setSplit] = useState(false)
  const started = useRef(false)

  const rescanRepos = useMemo(
    () => async () => {
      const r = await trpc.discovery.scanRepos.mutate().catch(() => null)
      if (r) setRepos(r.repositories)
    },
    [trpc],
  )
  const rescanConversations = useMemo(
    () => async () => {
      const r = await trpc.discovery.scan.mutate().catch(() => null)
      if (r) setConversations(r.conversations)
    },
    [trpc],
  )

  useEffect(() => {
    const off = hub.onSessions(setSessions)
    hub.connect()
    if (!started.current) {
      started.current = true
      void rescanRepos()
      void rescanConversations()
    }
    return () => {
      off()
      hub.dispose()
    }
  }, [hub, rescanRepos, rescanConversations])

  const value: Store = {
    hub, trpc, repos, conversations, sessions,
    selectedWorktree, setSelectedWorktree,
    paneA, paneB,
    setPane: (pane, id) => (pane === 'A' ? setPaneA(id) : setPaneB(id)),
    split, toggleSplit: () => setSplit((s) => !s),
    rescanRepos, rescanConversations,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run --filter @podium/web typecheck`

```bash
git add apps/web/src/store.tsx
git commit -m "feat(web): store — relay hub + tRPC feeds + view state"
```

### Task E2: AgentPanel — mount a terminal

**Files:** Create `apps/web/src/AgentPanel.tsx`

- [ ] **Step 1: Implement** (mirrors the terminal-mount effect from the old `LiveSessions`)

```tsx
// apps/web/src/AgentPanel.tsx
import { useEffect, useRef, useState } from 'react'
import { mountSession, type MountedSession } from '@podium/terminal-client'
import { useStore } from './store'

export function AgentPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const { hub } = useStore()
  const termRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef<MountedSession | null>(null)
  const [role, setRole] = useState('detached')

  useEffect(() => {
    if (!termRef.current) return
    const mounted = mountSession(termRef.current, {
      hub,
      sessionId,
      ...(toolbarRef.current ? { toolbarEl: toolbarRef.current } : {}),
      onState: (s) => setRole(`${s.role} ${s.cols}x${s.rows}`),
    })
    mountedRef.current = mounted
    return () => {
      mounted.dispose()
      mountedRef.current = null
    }
  }, [hub, sessionId])

  return (
    <div className="agent-panel">
      <div className="agent-panel-bar">
        <span className="state">{role}</span>
        <button type="button" onClick={() => mountedRef.current?.connection.requestControl()}>
          Take control
        </button>
      </div>
      <div ref={termRef} className="term" />
      <div ref={toolbarRef} className="toolbar" />
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run --filter @podium/web typecheck`

```bash
git add apps/web/src/AgentPanel.tsx
git commit -m "feat(web): AgentPanel terminal mount"
```

### Task E3: NewPanelMenu — new/resume

**Files:** Create `apps/web/src/NewPanelMenu.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/web/src/NewPanelMenu.tsx
import { useStore } from './store'
import { resumableForWorktree } from './derive'
import type { WorktreeView } from './types'

export function NewPanelMenu({
  worktree,
  onOpened,
}: {
  worktree: WorktreeView
  onOpened: (sessionId: string) => void
}): JSX.Element {
  const { trpc, conversations } = useStore()
  const resumable = resumableForWorktree(conversations, worktree.path)

  async function create(agentKind: 'claude-code' | 'codex') {
    const { sessionId } = await trpc.sessions.create.mutate({ agentKind, cwd: worktree.path })
    onOpened(sessionId)
  }
  async function resume(c: (typeof resumable)[number]) {
    if (!c.resume) return
    const { sessionId } = await trpc.sessions.resume.mutate({
      agentKind: c.agentKind,
      cwd: worktree.path,
      resume: c.resume,
      conversationId: c.id,
      ...(c.title ? { title: c.title } : {}),
    })
    onOpened(sessionId)
  }

  return (
    <div className="new-panel-menu">
      <button type="button" onClick={() => void create('claude-code')}>New Claude</button>
      <button type="button" onClick={() => void create('codex')}>New Codex</button>
      <div className="menu-section">Resume</div>
      {resumable.length === 0 && <div className="menu-empty">No matching history</div>}
      {resumable.map((c) => (
        <button key={c.id} type="button" onClick={() => void resume(c)}>
          ↻ {c.title ?? c.id}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run --filter @podium/web typecheck`

```bash
git add apps/web/src/NewPanelMenu.tsx
git commit -m "feat(web): NewPanelMenu — start or resume a session"
```

### Task E4: Sidebar — repos → worktrees → panels + Add repo

**Files:** Create `apps/web/src/Sidebar.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/web/src/Sidebar.tsx
import { useState } from 'react'
import { useStore } from './store'
import { reposToViews, sessionsForWorktree } from './derive'

export function Sidebar(): JSX.Element {
  const { repos, sessions, selectedWorktree, setSelectedWorktree, trpc, rescanRepos } = useStore()
  const repoViews = reposToViews(repos)
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')

  async function addRepo() {
    const p = path.trim()
    if (!p) return
    await trpc.repos.add.mutate({ path: p })
    setPath('')
    setAdding(false)
    await rescanRepos()
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="label">WORKTREES</span>
        <button type="button" onClick={() => setAdding((v) => !v)}>+ Add repo</button>
      </div>
      {adding && (
        <div className="add-repo">
          <input
            value={path}
            placeholder="/absolute/path/to/repo"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addRepo()}
            autoFocus
          />
          <button type="button" onClick={() => void addRepo()}>Add</button>
        </div>
      )}
      <div className="sidebar-list">
        {repoViews.map((repo) => (
          <div key={repo.path} className="repo">
            <div className="repo-name">{repo.name}</div>
            {repo.worktrees.map((wt) => {
              const wtSessions = sessionsForWorktree(sessions, wt.path)
              const active = selectedWorktree === wt.path
              return (
                <div key={wt.path}>
                  <button
                    type="button"
                    className={active ? 'worktree active' : 'worktree'}
                    onClick={() => setSelectedWorktree(wt.path)}
                  >
                    <span className="branch">{wt.branch ?? wt.path.split('/').pop()}</span>
                    {wt.isMain && <span className="tag">main</span>}
                  </button>
                  {wtSessions.map((s) => (
                    <div key={s.sessionId} className="panel-row">
                      <span className={`dot ${s.status}`} /> {s.agentKind}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        ))}
        {repoViews.length === 0 && <div className="empty">Add a repo to get started.</div>}
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run --filter @podium/web typecheck`

```bash
git add apps/web/src/Sidebar.tsx
git commit -m "feat(web): Sidebar — repos, worktrees, panels, add repo"
```

### Task E5: Workspace — tab bar + 1–2 panes

**Files:** Create `apps/web/src/Workspace.tsx`

- [ ] **Step 1: Implement**

The active worktree's tabs are its live sessions (`sessionsForWorktree`). `paneA`/`paneB` hold the focused sessionId per pane; `+` opens `NewPanelMenu`; `⊟ split` toggles `paneB`.

```tsx
// apps/web/src/Workspace.tsx
import { useEffect, useState } from 'react'
import { useStore } from './store'
import { reposToViews, sessionsForWorktree } from './derive'
import { AgentPanel } from './AgentPanel'
import { NewPanelMenu } from './NewPanelMenu'
import type { WorktreeView } from './types'

export function Workspace(): JSX.Element {
  const store = useStore()
  const { sessions, selectedWorktree, paneA, paneB, setPane, split, toggleSplit } = store
  const [menuOpen, setMenuOpen] = useState(false)

  const worktree: WorktreeView | undefined = reposToViews(store.repos)
    .flatMap((r) => r.worktrees)
    .find((w) => w.path === selectedWorktree)

  const tabs = worktree ? sessionsForWorktree(sessions, worktree.path) : []

  // Keep pane A pointed at a valid tab.
  useEffect(() => {
    if (paneA && tabs.some((t) => t.sessionId === paneA)) return
    setPane('A', tabs[0]?.sessionId ?? null)
  }, [tabs, paneA, setPane])

  if (!worktree) return <div className="workspace empty">Select a worktree.</div>

  return (
    <section className="workspace">
      <div className="tabbar">
        {tabs.map((t) => (
          <button
            key={t.sessionId}
            type="button"
            className={t.sessionId === paneA ? 'tab active' : 'tab'}
            onClick={() => setPane('A', t.sessionId)}
          >
            <span className={`dot ${t.status}`} /> {t.agentKind}
          </button>
        ))}
        <button type="button" className="tab-add" onClick={() => setMenuOpen((v) => !v)}>+</button>
        <button type="button" className="tab-split" onClick={toggleSplit}>⊟ split</button>
        {menuOpen && (
          <NewPanelMenu
            worktree={worktree}
            onOpened={(sid) => {
              setPane('A', sid)
              setMenuOpen(false)
            }}
          />
        )}
      </div>
      <div className={split ? 'panes split' : 'panes'}>
        <div className="pane">{paneA ? <AgentPanel sessionId={paneA} /> : <Empty />}</div>
        {split && (
          <div className="pane">
            {paneB ? <AgentPanel sessionId={paneB} /> : <PanePicker tabs={tabs} onPick={(id) => setPane('B', id)} />}
          </div>
        )}
      </div>
    </section>
  )
}

function Empty(): JSX.Element {
  return <div className="pane-empty">No panel — use + to start one.</div>
}
function PanePicker({
  tabs,
  onPick,
}: {
  tabs: { sessionId: string; agentKind: string }[]
  onPick: (id: string) => void
}): JSX.Element {
  return (
    <div className="pane-picker">
      <div>Pick a panel for this pane:</div>
      {tabs.map((t) => (
        <button key={t.sessionId} type="button" onClick={() => onPick(t.sessionId)}>{t.agentKind}</button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run --filter @podium/web typecheck`

```bash
git add apps/web/src/Workspace.tsx
git commit -m "feat(web): Workspace — tab bar + 1-2 pane split"
```

### Task E6: ConnectScreen + desktop AppShell + structure test

**Files:**
- Create: `apps/web/src/ConnectScreen.tsx`
- Modify: `apps/web/src/AppShell.tsx`
- Test: `apps/web/test/shell.structure.test.ts`

- [ ] **Step 1: ConnectScreen**

```tsx
// apps/web/src/ConnectScreen.tsx
import { useState } from 'react'

export function ConnectScreen({ onConnect }: { onConnect: (origin: string) => void }): JSX.Element {
  const [draft, setDraft] = useState('ws://localhost:8787')
  return (
    <div className="connect">
      <h1>Podium</h1>
      <label>
        <span>Relay server</span>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <button type="button" onClick={() => onConnect(draft)}>Connect</button>
    </div>
  )
}
```

- [ ] **Step 2: AppShell — connect gate + desktop layout (mobile added next phase)**

```tsx
// apps/web/src/AppShell.tsx
import { useState } from 'react'
import { parseServer } from './trpc'
import { StoreProvider } from './store'
import { ConnectScreen } from './ConnectScreen'
import { Sidebar } from './Sidebar'
import { Workspace } from './Workspace'

export function AppShell(): JSX.Element {
  const fromUrl = parseServer(window.location.search)
    ? new URLSearchParams(window.location.search).get('server')
    : null
  const [origin, setOrigin] = useState<string | null>(fromUrl)

  if (!origin) return <ConnectScreen onConnect={setOrigin} />
  return (
    <StoreProvider origin={origin}>
      <div className="desktop-shell">
        <Sidebar />
        <Workspace />
      </div>
    </StoreProvider>
  )
}
```

- [ ] **Step 3: Structure test (replaces the deleted App.structure.test.ts)**

```ts
// apps/web/test/shell.structure.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('web shell structure', () => {
  it('AppShell gates on connection and renders sidebar + workspace', () => {
    const src = read('AppShell.tsx')
    expect(src).toContain('ConnectScreen')
    expect(src).toContain('<Sidebar')
    expect(src).toContain('<Workspace')
  })
  it('store exposes the three server feeds', () => {
    const src = read('store.tsx')
    for (const feed of ['repos', 'conversations', 'sessions']) expect(src).toContain(feed)
  })
})
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bunx vitest run apps/web/test`
Expected: PASS
Run: `bun run --filter @podium/web typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ConnectScreen.tsx apps/web/src/AppShell.tsx apps/web/test/shell.structure.test.ts
git commit -m "feat(web): connect gate + desktop shell + structure test"
```

---

## Phase F — Mobile shell + responsive switch

### Task F1: MobileApp + responsive AppShell

**Files:**
- Create: `apps/web/src/MobileApp.tsx`
- Modify: `apps/web/src/AppShell.tsx`, `apps/web/src/styles.css`

- [ ] **Step 1: MobileApp — header (picker + tab strip + `+`), single panel, picker sheet**

```tsx
// apps/web/src/MobileApp.tsx
import { useEffect, useState } from 'react'
import { useStore } from './store'
import { reposToViews, sessionsForWorktree } from './derive'
import { AgentPanel } from './AgentPanel'
import { NewPanelMenu } from './NewPanelMenu'

export function MobileApp(): JSX.Element {
  const store = useStore()
  const { sessions, selectedWorktree, setSelectedWorktree, paneA, setPane } = store
  const repoViews = reposToViews(store.repos)
  const worktree = repoViews.flatMap((r) => r.worktrees).find((w) => w.path === selectedWorktree)
  const tabs = worktree ? sessionsForWorktree(sessions, worktree.path) : []
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (paneA && tabs.some((t) => t.sessionId === paneA)) return
    setPane('A', tabs[0]?.sessionId ?? null)
  }, [tabs, paneA, setPane])

  return (
    <div className="mobile-shell">
      <header className="mobile-head">
        <button type="button" className="wt-picker" onClick={() => setPickerOpen(true)}>
          {worktree ? (worktree.branch ?? worktree.path.split('/').pop()) : 'Select worktree'} ▾
        </button>
        <div className="mobile-tabs">
          {tabs.map((t) => (
            <button
              key={t.sessionId}
              type="button"
              className={t.sessionId === paneA ? 'tab active' : 'tab'}
              onClick={() => setPane('A', t.sessionId)}
            >
              <span className={`dot ${t.status}`} /> {t.agentKind}
            </button>
          ))}
          {worktree && (
            <button type="button" className="tab-add" onClick={() => setMenuOpen((v) => !v)}>+</button>
          )}
        </div>
      </header>
      {menuOpen && worktree && (
        <NewPanelMenu worktree={worktree} onOpened={(sid) => { setPane('A', sid); setMenuOpen(false) }} />
      )}
      <div className="mobile-body">
        {paneA ? <AgentPanel sessionId={paneA} /> : <div className="pane-empty">No panel — use + to start one.</div>}
      </div>
      {pickerOpen && (
        <div className="picker-sheet">
          <div className="sheet-head">
            <span className="label">WORKTREES</span>
            <button type="button" onClick={() => setPickerOpen(false)}>✕</button>
          </div>
          {repoViews.map((repo) => (
            <div key={repo.path}>
              <div className="repo-name">{repo.name}</div>
              {repo.worktrees.map((wt) => (
                <button
                  key={wt.path}
                  type="button"
                  className="sheet-row"
                  onClick={() => { setSelectedWorktree(wt.path); setPickerOpen(false) }}
                >
                  {wt.branch ?? wt.path.split('/').pop()}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Responsive switch in AppShell**

Add a `useIsMobile` hook (single breakpoint) and pick the shell:

```tsx
// add to AppShell.tsx
import { useEffect, useState } from 'react'
import { MobileApp } from './MobileApp'

function useIsMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return m
}
```

Replace the connected return body with:

```tsx
  const isMobile = useIsMobile()
  if (!origin) return <ConnectScreen onConnect={setOrigin} />
  return (
    <StoreProvider origin={origin}>
      {isMobile ? (
        <MobileApp />
      ) : (
        <div className="desktop-shell">
          <Sidebar />
          <Workspace />
        </div>
      )}
    </StoreProvider>
  )
```

- [ ] **Step 3: Layout CSS for both shells**

Append to `styles.css` the structural layout (flex shells, tab bars, panes, picker sheet, `100dvh` mobile body with `--viewport-h` honored by the terminal toolbar). Keep it structural; visual polish happens in Step 5.

```css
.desktop-shell { display: flex; height: 100%; }
.sidebar { width: 280px; flex-shrink: 0; background: var(--panel); border-right: 1px solid var(--border); overflow-y: auto; }
.workspace { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.tabbar { display: flex; align-items: center; gap: 2px; border-bottom: 1px solid var(--border); padding: 4px; position: relative; }
.panes { flex: 1; display: flex; min-height: 0; }
.panes .pane { flex: 1; min-width: 0; display: flex; }
.panes.split .pane + .pane { border-left: 1px solid var(--border); }
.agent-panel { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.agent-panel .term { flex: 1; min-height: 0; }
.mobile-shell { display: flex; flex-direction: column; height: var(--viewport-h, 100dvh); }
.mobile-head { display: flex; align-items: stretch; border-bottom: 1px solid var(--border); height: 44px; }
.mobile-tabs { flex: 1; display: flex; align-items: center; gap: 6px; overflow-x: auto; padding: 0 8px; }
.mobile-body { flex: 1; min-height: 0; position: relative; }
.picker-sheet { position: absolute; inset: 0; background: var(--app); z-index: 30; overflow-y: auto; }
```

- [ ] **Step 4: Run structure test + typecheck**

Run: `bunx vitest run apps/web/test && bun run --filter @podium/web typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Visual polish pass (frontend-design)**

Use the **frontend-design** skill to refine the dark theme, spacing, status dots, tab and worktree states, and the mobile sheet — editing `styles.css` and class usage only. Do not change behavior or component interfaces. Verify in the browser during Phase F2.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/MobileApp.tsx apps/web/src/AppShell.tsx apps/web/src/styles.css
git commit -m "feat(web): mobile shell + responsive switch"
```

---

## Phase G — End-to-end verification (dogfood the three flows)

### Task G1: Run the stack and verify

**Files:** none (verification + any fixes uncovered)

- [ ] **Step 1: Whole-repo gates**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass. Fix anything that fails before continuing.

- [ ] **Step 2: Boot server + daemon + web**

Inspect `e2e/run-claude-demo.ts` / `e2e/serve.ts` for the canonical boot (server on a port, daemon connected, web via `bun run --filter @podium/web dev`). Start them (use Harness shell tabs so output keeps streaming):
- server (note its `ws://host:port`), daemon pointed at the server, web dev server.
- Open the web app with `?server=ws://<host>:<port>`.

- [ ] **Step 3: Verify the three required flows (desktop)**

1. **Add repo:** click *+ Add repo*, enter an absolute repo path on the daemon host, Add → the repo and its worktrees appear in the sidebar.
2. **History:** open *+* on a worktree → *Resume* lists Claude/Codex conversations whose project path matches; the list is non-empty for a repo you've used.
3. **Start / resume:** *New Claude* spawns a session → terminal mounts and is interactive; *Take control* works; *Resume* on a history item reattaches. Toggle *⊟ split* → a second pane; pick a panel for it.

- [ ] **Step 4: Verify mobile + handover**

Resize to ≤768px (or load on a phone over the same relay): the mobile shell renders; the worktree picker sheet opens; a panel started on desktop appears on mobile (shared session list), and control transfer works across the two clients.

- [ ] **Step 5: Commit any fixes, then open the PR**

```bash
git add -A && git commit -m "fix(web): address issues found during dogfood"   # only if fixes were needed
```

Use the **superpowers:finishing-a-development-branch** skill to push `web-ui-rebuild` and open a PR against `main` (remote is `upstream`; confirm the push target with the user).

---

## Self-Review

**Spec coverage:**
- Find repos + worktrees → Phases A/B/C (wire + daemon + registry/tRPC) + Sidebar (E4) + Add repo (E4). ✓
- Find conversation history → existing `discovery.scan` consumed in store (E1) + matching (D2) + Resume menu (E3). ✓
- Start new / resume in a worktree → NewPanelMenu (E3) via `sessions.create`/`sessions.resume`; terminal via AgentPanel (E2). ✓
- Desktop tiling (1–2 panes) → Workspace (E5). ✓
- Mobile collapse + handover → MobileApp + responsive (F1) + verification (G1). ✓
- Handover principle (server-authoritative sessions, shared registry, client-local layout) → registry (C1) shared; sessions via `hub.onSessions` (E1); pane/selection client-local (E1). ✓
- Throw away the prototype → D1 removes `App.tsx`/`App.css`/`LiveSessions.tsx`/old test. ✓
- Resolved decisions (plain CSS, server JSON registry, `?server=` connect) → D3/E6, C1, E6. ✓

**Deferred (asserted in spec, intentionally absent here):** worktree creation, terminal/browser panel types, full nested tiling, auth tokens, search, analytics panels. None have tasks — correct.

**Placeholder scan:** No "TBD/TODO/handle errors" steps; every code step shows real code; Step C3-1 and G1-2 are explicit *inspect-then-edit* steps (read a named file, make a named change), not vague placeholders.

**Type consistency:** `GitRepositoryWire`/`GitWorktreeWire`/`GitDiscoveryDiagnosticWire` defined in A1 are used identically in B1, C2, D1/D2. `scanRepos`/`scanReposResult`/`scanReposRequest` names match across protocol/daemon/server. Store fields (`repos`, `conversations`, `sessions`, `paneA`, `paneB`, `split`, `selectedWorktree`) are referenced consistently in E4/E5/F1. `reposToViews`/`sessionsForWorktree`/`resumableForWorktree` signatures match between D2 and their consumers.
