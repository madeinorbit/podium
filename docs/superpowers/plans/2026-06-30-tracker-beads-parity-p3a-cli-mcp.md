# Tracker → beads Parity — P3a: `podium issue` CLI + MCP tools (one shared registry) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents (and humans) drive the native tracker the way they use `bd` — a `podium issue …` CLI **and** issue tools on the existing `podium` MCP, both generated from **one** shared command registry so they never drift. Role-gating comes in P3b.

**Architecture:** A single `IssueCommand` registry (name + description + zod args + a `run(client, args)` that calls the `issues.*` tRPC procedures via a typed `@trpc/client`). The **CLI** (`scripts/issue-cli.ts`, dispatched from `scripts/cli.ts`) parses argv and runs a command against `http://localhost:${PODIUM_PORT}/trpc`. The **MCP** `IssueToolProvider` exposes the same registry as MCP tools and is merged with the existing `SuperagentService` via a `CompositeMcpProvider` passed to the existing `registerMcpRoute` — still one `podium` MCP. The in-process MCP uses a loopback client whose URL is set after the server binds (mirroring the existing `superagent.setMcpEndpoint`).

**Tech Stack:** TypeScript, Bun, `@trpc/client` v11 (add to `apps/server`), `@trpc/server` v11 (`AppRouter` already exported), zod, vitest.

## Global Constraints

- **Runtime/tests:** Bun; `npx vitest run <path>` from worktree root. Most tests use a **mock tRPC client** (a stub exposing `issues.<proc>.query`/`.mutate`) — fast, no server. ONE integration smoke (Task 4) starts an isolated in-process server (`PODIUM_PORT=0` + `PODIUM_STATE_DIR` a temp dir) and must NOT spawn real agents (no `start`/`addSession`).
- **One registry, two front-ends:** the CLI and the MCP both consume `ISSUE_COMMANDS`. Never define a command in only one place.
- **One MCP:** extend, don't add. `registerMcpRoute(app, composite, token)` stays the only MCP registration; `composite` = superagent tools ⊕ issue tools.
- **Transport:** both front-ends use `createTRPCClient<AppRouter>` over loopback HTTP. Mutations call `.mutate(input)`, queries `.query(input)`.
- **Client output is text:** every command's `run` returns a human/agent-readable string (the MCP tool result + the CLI stdout). `--json` (CLI) / a `json` arg (MCP) returns `JSON.stringify(result)`.
- **`AppRouter`** is exported from `@podium/server` (`apps/server/src/index.ts` → `router.ts:472`). The registry lives in `apps/server/src`; `scripts/` imports it via relative path (as `scripts/cli.ts` already imports `../apps/server/src/server`).
- **Commits:** conventional, one per task, scope `tracker`. **Isolation:** worktree only; never touch the main checkout; no PTY/agent-spawning e2e.
- **Dense style:** match the codebase's existing dense object-literal style; do NOT run `biome format --write` on pre-existing files (it reflows the whole file against the project style). New files: keep them tidy and `biome check`-clean.

---

### Task 1: tRPC client factory + shared `IssueCommand` registry

**Files:**
- Modify: `apps/server/package.json` — add `"@trpc/client": "^11.0.0"` to dependencies.
- Create: `apps/server/src/issue-client.ts` — `IssueTrpc` type + `makeIssueClient(baseUrl)`.
- Create: `apps/server/src/issue-commands.ts` — `IssueCommand` interface + `ISSUE_COMMANDS`.
- Test: `apps/server/src/issue-commands.test.ts` (create).

**Interfaces:**
- Produces `IssueTrpc = ReturnType<typeof makeIssueClient>` and `makeIssueClient(baseUrl: string): IssueTrpc` (a typed `@trpc/client` for `AppRouter`, pointed at `${baseUrl}/trpc`).
- Produces `interface IssueCommand { name: string; summary: string; args: z.ZodType; run(client: IssueTrpc, args: Record<string, unknown>): Promise<string> }` and `const ISSUE_COMMANDS: IssueCommand[]`.
- Consumes: the `issues.*` tRPC procedures (P1/P2).

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/issue-commands.test.ts`. It exercises the registry against a hand-built mock client (no server):

```ts
import { describe, expect, it, vi } from 'vitest'
import { ISSUE_COMMANDS } from './issue-commands'
import type { IssueTrpc } from './issue-client'

// Minimal mock of the tRPC client surface the commands use.
function mockClient(overrides: Record<string, unknown> = {}): { client: IssueTrpc; calls: any[] } {
  const calls: any[] = []
  const proc = (path: string) => ({
    query: vi.fn(async (input: unknown) => {
      calls.push({ path, kind: 'query', input })
      return (overrides[path] as unknown) ?? []
    }),
    mutate: vi.fn(async (input: unknown) => {
      calls.push({ path, kind: 'mutate', input })
      return (overrides[path] as unknown) ?? { id: 'iss_1', seq: 1, title: 't' }
    }),
  })
  const client = {
    issues: {
      ready: proc('ready'), list: proc('list'), get: proc('get'), create: proc('create'),
      update: proc('update'), close: proc('close'), claim: proc('claim'),
      depAdd: proc('depAdd'), addComment: proc('addComment'), search: proc('search'),
      stats: proc('stats'),
    },
  } as unknown as IssueTrpc
  return { client, calls }
}

function cmd(name: string) {
  const c = ISSUE_COMMANDS.find((x) => x.name === name)
  if (!c) throw new Error(`no command ${name}`)
  return c
}

describe('ISSUE_COMMANDS registry', () => {
  it('every command has a unique name, a summary, and a zod args schema', () => {
    const names = ISSUE_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const c of ISSUE_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0)
      expect(typeof c.args.parse).toBe('function')
    }
  })

  it('create calls issues.create.mutate with the title and returns the new id/seq', async () => {
    const { client, calls } = mockClient({ create: { id: 'iss_9', seq: 7, title: 'Fix login' } })
    const out = await cmd('create').run(client, { repoPath: '/r', title: 'Fix login' })
    expect(calls).toContainEqual({ path: 'create', kind: 'mutate', input: expect.objectContaining({ title: 'Fix login', repoPath: '/r', startNow: false }) })
    expect(out).toContain('7')
    expect(out).toContain('Fix login')
  })

  it('ready calls issues.ready.query and lists titles', async () => {
    const { client } = mockClient({ ready: [{ seq: 1, title: 'A', priority: 0 }, { seq: 2, title: 'B', priority: 2 }] })
    const out = await cmd('ready').run(client, { repoPath: '/r' })
    expect(out).toContain('A')
    expect(out).toContain('B')
  })

  it('claim calls issues.claim.mutate with id + assignee', async () => {
    const { client, calls } = mockClient()
    await cmd('claim').run(client, { id: 'iss_1', assignee: 'agent:claude' })
    expect(calls).toContainEqual({ path: 'claim', kind: 'mutate', input: { id: 'iss_1', assignee: 'agent:claude' } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issue-commands.test.ts`
Expected: FAIL — cannot find `./issue-commands` / `./issue-client`.

- [ ] **Step 3: Implement client factory + registry**

Add `@trpc/client` to `apps/server/package.json` dependencies (alongside the existing `@trpc/server`):

```json
    "@trpc/client": "^11.0.0",
```

Create `apps/server/src/issue-client.ts`:

```ts
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from './router'

export type IssueTrpc = ReturnType<typeof makeIssueClient>

/** Typed tRPC client over loopback HTTP. baseUrl e.g. http://localhost:18787 (no trailing /trpc). */
export function makeIssueClient(baseUrl: string) {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${baseUrl}/trpc` })] })
}
```

Create `apps/server/src/issue-commands.ts` (a representative-but-complete core; further verbs follow the identical shape):

```ts
import { z } from 'zod'
import type { IssueTrpc } from './issue-client'

export interface IssueCommand {
  name: string
  summary: string
  args: z.ZodType
  run(client: IssueTrpc, args: Record<string, unknown>): Promise<string>
}

const repoArg = { repoPath: z.string() }
const optRepo = { repoPath: z.string().optional() }

// One-line summary of an issue for list/ready/blocked output.
function line(i: { seq: number; title: string; priority?: number; stage?: string }): string {
  const p = i.priority != null ? `P${i.priority} ` : ''
  const s = i.stage ? `[${i.stage}] ` : ''
  return `#${i.seq} ${p}${s}${i.title}`
}

export const ISSUE_COMMANDS: IssueCommand[] = [
  {
    name: 'ready',
    summary: 'List issues ready to work (open, not deferred, unblocked).',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.ready.query(a as { repoPath?: string })) as Array<Parameters<typeof line>[0]>
      return rows.length ? rows.map(line).join('\n') : '(no ready issues)'
    },
  },
  {
    name: 'blocked',
    summary: 'List issues blocked by an open dependency.',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.blocked.query(a as { repoPath?: string })) as Array<Parameters<typeof line>[0]>
      return rows.length ? rows.map(line).join('\n') : '(no blocked issues)'
    },
  },
  {
    name: 'list',
    summary: 'List all issues in the repo.',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.list.query(a as { repoPath?: string })) as Array<Parameters<typeof line>[0]>
      return rows.length ? rows.map(line).join('\n') : '(no issues)'
    },
  },
  {
    name: 'show',
    summary: 'Show one issue by id.',
    args: z.object({ id: z.string() }),
    async run(c, a) {
      const i = (await c.issues.get.query({ id: a.id as string })) as
        | { seq: number; title: string; description: string; stage: string; priority: number; ready: boolean; blocked: boolean }
        | null
      if (!i) return `(no issue ${a.id})`
      return `#${i.seq} ${i.title}\nstage=${i.stage} P${i.priority} ready=${i.ready} blocked=${i.blocked}\n\n${i.description}`
    },
  },
  {
    name: 'create',
    summary: 'Create an issue. --title required; --priority --type --description optional.',
    args: z.object({
      ...repoArg,
      title: z.string().min(1),
      description: z.string().optional(),
      priority: z.coerce.number().int().min(0).max(4).optional(),
      type: z.string().optional(),
    }),
    async run(c, a) {
      const i = (await c.issues.create.mutate({
        repoPath: a.repoPath as string,
        title: a.title as string,
        startNow: false,
        ...(a.description ? { description: a.description as string } : {}),
        ...(a.priority != null ? { priority: a.priority as number } : {}),
        ...(a.type ? { type: a.type as never } : {}),
      })) as { seq: number; title: string }
      return `created #${i.seq} ${i.title}`
    },
  },
  {
    name: 'update',
    summary: 'Update fields on an issue (--stage --priority --assignee --title …).',
    args: z.object({
      id: z.string(),
      stage: z.string().optional(),
      priority: z.coerce.number().int().min(0).max(4).optional(),
      assignee: z.string().optional(),
      title: z.string().optional(),
    }),
    async run(c, a) {
      const patch: Record<string, unknown> = {}
      for (const k of ['stage', 'priority', 'assignee', 'title']) if (a[k] != null) patch[k] = a[k]
      const i = (await c.issues.update.mutate({ id: a.id as string, patch: patch as never })) as { seq: number }
      return `updated #${i.seq}`
    },
  },
  {
    name: 'close',
    summary: 'Close an issue (--reason done|superseded|duplicate|wontfix).',
    args: z.object({ id: z.string(), reason: z.string().optional() }),
    async run(c, a) {
      const i = (await c.issues.close.mutate({ id: a.id as string, ...(a.reason ? { reason: a.reason as string } : {}) })) as { seq: number }
      return `closed #${i.seq}`
    },
  },
  {
    name: 'claim',
    summary: 'Claim an issue (set assignee + in_progress).',
    args: z.object({ id: z.string(), assignee: z.string() }),
    async run(c, a) {
      const i = (await c.issues.claim.mutate({ id: a.id as string, assignee: a.assignee as string })) as { seq: number }
      return `claimed #${i.seq}`
    },
  },
  {
    name: 'dep-add',
    summary: 'Add a dependency: <from> depends on <to> (--type blocks|related|…).',
    args: z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }),
    async run(c, a) {
      await c.issues.depAdd.mutate({ fromId: a.fromId as string, toId: a.toId as string, ...(a.type ? { type: a.type as string } : {}) })
      return `dep added ${a.fromId} -> ${a.toId}`
    },
  },
  {
    name: 'comment',
    summary: 'Add a comment to an issue (--author --body).',
    args: z.object({ id: z.string(), author: z.string(), body: z.string().min(1) }),
    async run(c, a) {
      await c.issues.addComment.mutate({ id: a.id as string, author: a.author as string, body: a.body as string })
      return `commented on ${a.id}`
    },
  },
  {
    name: 'search',
    summary: 'Search issues (--text --status --priority --type --label …).',
    args: z.object({
      ...optRepo,
      text: z.string().optional(),
      status: z.string().optional(),
      priority: z.coerce.number().int().optional(),
      type: z.string().optional(),
      label: z.string().optional(),
    }),
    async run(c, a) {
      const rows = (await c.issues.search.query(a as never)) as Array<Parameters<typeof line>[0]>
      return rows.length ? rows.map(line).join('\n') : '(no matches)'
    },
  },
  {
    name: 'stats',
    summary: 'Project stats (total/open/closed/ready/blocked/deferred).',
    args: z.object(optRepo),
    async run(c, a) {
      const s = (await c.issues.stats.query(a as { repoPath?: string })) as Record<string, number>
      return Object.entries(s).map(([k, v]) => `${k}: ${v}`).join('\n')
    },
  },
]
```

(Note the `as never`/`as ...` casts bridge the dynamic-args registry to the procedures' precise input types; the args zod schema is the runtime guard. This is a deliberate, contained boundary.)

- [ ] **Step 4: Run test + typecheck**

Run `bun install` (picks up `@trpc/client`), then `npx vitest run apps/server/src/issue-commands.test.ts` and `bun run typecheck`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/package.json apps/server/src/issue-client.ts apps/server/src/issue-commands.ts apps/server/src/issue-commands.test.ts bun.lock
git commit -m "feat(tracker): shared issue command registry + tRPC client factory"
```

---

### Task 2: `podium issue …` CLI

**Files:**
- Create: `scripts/issue-cli.ts` — argv parser + dispatch over `ISSUE_COMMANDS`.
- Modify: `scripts/cli.ts` — add the `if (argv[0] === 'issue')` branch after the `update` branch (~line 62).
- Test: `scripts/issue-cli.test.ts` (create).

**Interfaces:**
- Produces `parseIssueArgs(argv: string[]): { command?: string; args: Record<string, unknown> }` (pure: positionals + `--flag value`/`--flag=value` + `--bool`) and `async function runIssueCli(argv: string[], client: IssueTrpc): Promise<string>` (resolves the command, zod-parses args, runs it; `issue` / `issue help` lists commands; unknown command → a helpful error string).
- Consumes: `ISSUE_COMMANDS`, `makeIssueClient` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `scripts/issue-cli.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { parseIssueArgs, runIssueCli } from './issue-cli'

describe('parseIssueArgs', () => {
  it('parses the command, positionals, --flag value, --flag=value, and --bool', () => {
    const r = parseIssueArgs(['create', '--title', 'Fix login', '--priority=0', '--json'])
    expect(r.command).toBe('create')
    expect(r.args.title).toBe('Fix login')
    expect(r.args.priority).toBe('0')
    expect(r.args.json).toBe(true)
  })
})

describe('runIssueCli', () => {
  const client = {
    issues: { ready: { query: vi.fn(async () => [{ seq: 1, title: 'A', priority: 0 }]) } },
  } as any

  it('runs a known command and returns its text', async () => {
    const out = await runIssueCli(['ready', '--repoPath', '/r'], client)
    expect(out).toContain('A')
  })

  it('issue help lists the command names', async () => {
    const out = await runIssueCli(['help'], client)
    expect(out).toContain('ready')
    expect(out).toContain('create')
  })

  it('unknown command returns a helpful error', async () => {
    const out = await runIssueCli(['nope'], client)
    expect(out.toLowerCase()).toContain('unknown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/issue-cli.test.ts`
Expected: FAIL — cannot find `./issue-cli`.

- [ ] **Step 3: Implement the CLI**

Create `scripts/issue-cli.ts`:

```ts
import { ISSUE_COMMANDS } from '../apps/server/src/issue-commands'
import { makeIssueClient, type IssueTrpc } from '../apps/server/src/issue-client'

/** Pure argv → { command, args }. Positionals are ignored except the command (argv[0]). */
export function parseIssueArgs(argv: string[]): { command?: string; args: Record<string, unknown> } {
  const [command, ...rest] = argv
  const args: Record<string, unknown> = {}
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (!t.startsWith('--')) continue
    const eq = t.indexOf('=')
    if (eq >= 0) {
      args[t.slice(2, eq)] = t.slice(eq + 1)
    } else {
      const key = t.slice(2)
      const next = rest[i + 1]
      if (next == null || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i++
      }
    }
  }
  return { ...(command ? { command } : {}), args }
}

function helpText(): string {
  const w = Math.max(...ISSUE_COMMANDS.map((c) => c.name.length))
  return ['podium issue <command> [--flags]', '', ...ISSUE_COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`)].join('\n')
}

/** Resolve + run one issue command against the given client; returns the text to print. */
export async function runIssueCli(argv: string[], client: IssueTrpc): Promise<string> {
  const { command, args } = parseIssueArgs(argv)
  if (!command || command === 'help') return helpText()
  const cmd = ISSUE_COMMANDS.find((c) => c.name === command)
  if (!cmd) return `unknown command: ${command}\n\n${helpText()}`
  const parsed = cmd.args.safeParse(args)
  if (!parsed.success) return `invalid args for ${command}: ${parsed.error.issues.map((i) => i.message).join('; ')}`
  const out = await cmd.run(client, parsed.data as Record<string, unknown>)
  return args.json ? JSON.stringify({ command, ok: true }) + '\n' + out : out
}

/** Entry used by scripts/cli.ts: build a loopback client and run, printing the result. */
export async function issueCliMain(argv: string[]): Promise<void> {
  const port = Number(process.env.PODIUM_PORT) || 18787
  const client = makeIssueClient(`http://localhost:${port}`)
  try {
    console.log(await runIssueCli(argv, client))
  } catch (err) {
    console.error(`podium issue: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
```

In `scripts/cli.ts`, after the `update` branch (the `if (argv[0] === 'update') { … return }` block ~line 62), add:

```ts
  // `podium issue <command>`: drive the native issue tracker over the running server's API.
  if (argv[0] === 'issue') {
    const { issueCliMain } = await import('./issue-cli')
    await issueCliMain(argv.slice(1))
    return
  }
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run scripts/issue-cli.test.ts` then `bun run typecheck`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/issue-cli.ts scripts/issue-cli.test.ts scripts/cli.ts
git commit -m "feat(tracker): podium issue CLI over the running server"
```

---

### Task 3: `IssueToolProvider` + `CompositeMcpProvider` (one `podium` MCP)

**Files:**
- Create: `apps/server/src/issue-mcp.ts` — `IssueToolProvider` + `CompositeMcpProvider`.
- Modify: `apps/server/src/server.ts` — build the composite, set its loopback client after bind, pass it to `registerMcpRoute`.
- Test: `apps/server/src/issue-mcp.test.ts` (create).

**Interfaces:**
- Produces `class IssueToolProvider implements McpToolProvider` — `mcpToolSpecs()` maps each `ISSUE_COMMANDS` entry to `{ name: 'issue_'+name.replace(/-/g,'_'), description, inputSchema: zodToJsonSchema(args) }`; `callMcpTool(name, args)` finds the command, runs it against a client (set via `setClient`), returns the text. Throws if no client set.
- Produces `class CompositeMcpProvider implements McpToolProvider` — concatenates `mcpToolSpecs()` from N providers and routes `callMcpTool` to the provider that owns the tool name.
- `zodToJsonSchema(schema)`: a minimal converter for the flat `z.object({...})` arg schemas used here (string/number/boolean/optional) → `{ type:'object', properties, required }`.
- Consumes: `McpToolProvider` (`mcp-route.ts`), `ISSUE_COMMANDS`/`makeIssueClient` (Task 1), `SuperagentService`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/issue-mcp.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { CompositeMcpProvider, IssueToolProvider } from './issue-mcp'
import type { McpToolProvider } from './mcp-route'
import type { IssueTrpc } from './issue-client'

describe('IssueToolProvider', () => {
  const client = { issues: { ready: { query: vi.fn(async () => [{ seq: 1, title: 'A' }]) } } } as unknown as IssueTrpc

  it('exposes one tool per command, namespaced issue_*, with an object inputSchema', () => {
    const p = new IssueToolProvider()
    const specs = p.mcpToolSpecs()
    const ready = specs.find((s) => s.name === 'issue_ready')
    expect(ready).toBeTruthy()
    expect((ready!.inputSchema as { type: string }).type).toBe('object')
    expect(specs.some((s) => s.name === 'issue_create')).toBe(true)
  })

  it('callMcpTool runs the command against the set client', async () => {
    const p = new IssueToolProvider()
    p.setClient(client)
    const out = await p.callMcpTool('issue_ready', { repoPath: '/r' })
    expect(out).toContain('A')
  })

  it('throws a clear error when no client is set', async () => {
    const p = new IssueToolProvider()
    await expect(p.callMcpTool('issue_ready', {})).rejects.toThrow(/not ready|no client/i)
  })
})

describe('CompositeMcpProvider', () => {
  const a: McpToolProvider = {
    mcpToolSpecs: () => [{ name: 'a_one', description: 'd', inputSchema: {} }],
    callMcpTool: async () => 'from-a',
  }
  const b: McpToolProvider = {
    mcpToolSpecs: () => [{ name: 'b_two', description: 'd', inputSchema: {} }],
    callMcpTool: async () => 'from-b',
  }
  it('merges specs and routes calls to the owning provider', async () => {
    const c = new CompositeMcpProvider([a, b])
    expect(c.mcpToolSpecs().map((s) => s.name).sort()).toEqual(['a_one', 'b_two'])
    expect(await c.callMcpTool('b_two', {})).toBe('from-b')
  })
  it('throws on an unknown tool name', async () => {
    const c = new CompositeMcpProvider([a])
    await expect(c.callMcpTool('nope', {})).rejects.toThrow(/unknown/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issue-mcp.test.ts`
Expected: FAIL — cannot find `./issue-mcp`.

- [ ] **Step 3: Implement**

Create `apps/server/src/issue-mcp.ts`:

```ts
import { z } from 'zod'
import type { McpToolProvider } from './mcp-route'
import { ISSUE_COMMANDS, type IssueCommand } from './issue-commands'
import type { IssueTrpc } from './issue-client'

/** Minimal JSON Schema for the flat z.object arg schemas the registry uses. */
function zodToJsonSchema(schema: z.ZodType): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape ?? {}
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, raw] of Object.entries(shape)) {
    let def = raw as z.ZodType
    let optional = false
    // unwrap optional/default/coerce wrappers to the inner type name
    while (def && (def as { _def?: { typeName?: string } })._def) {
      const tn = (def as { _def: { typeName: string; innerType?: z.ZodType } })._def.typeName
      if (tn === 'ZodOptional' || tn === 'ZodDefault') {
        optional = true
        def = (def as { _def: { innerType: z.ZodType } })._def.innerType
        continue
      }
      break
    }
    const tn = (def as { _def: { typeName: string } })._def.typeName
    const jsonType = tn === 'ZodNumber' ? 'number' : tn === 'ZodBoolean' ? 'boolean' : 'string'
    properties[key] = { type: jsonType }
    if (!optional) required.push(key)
  }
  return { type: 'object', properties, required }
}

const toolName = (c: IssueCommand): string => `issue_${c.name.replace(/-/g, '_')}`

/** MCP tools for the native issue tracker, generated from the shared command registry. */
export class IssueToolProvider implements McpToolProvider {
  private client: IssueTrpc | undefined
  setClient(client: IssueTrpc): void {
    this.client = client
  }
  mcpToolSpecs(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return ISSUE_COMMANDS.map((c) => ({ name: toolName(c), description: c.summary, inputSchema: zodToJsonSchema(c.args) }))
  }
  async callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
    const cmd = ISSUE_COMMANDS.find((c) => toolName(c) === name)
    if (!cmd) throw new Error(`unknown issue tool: ${name}`)
    if (!this.client) throw new Error('issue MCP not ready (no client)')
    const parsed = cmd.args.safeParse(args)
    if (!parsed.success) throw new Error(`invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    return cmd.run(this.client, parsed.data as Record<string, unknown>)
  }
}

/** Fan one MCP surface out over several providers (superagent ⊕ issue tools). */
export class CompositeMcpProvider implements McpToolProvider {
  constructor(private readonly providers: McpToolProvider[]) {}
  mcpToolSpecs(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return this.providers.flatMap((p) => p.mcpToolSpecs())
  }
  async callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
    const owner = this.providers.find((p) => p.mcpToolSpecs().some((s) => s.name === name))
    if (!owner) throw new Error(`unknown tool: ${name}`)
    return owner.callMcpTool(name, args)
  }
}
```

In `apps/server/src/server.ts`, replace the single-provider registration. Where it currently has (around line 70-75):

```ts
  const mcpToken = randomUUID()
  registerMcpRoute(app, superagent, mcpToken)
```

use the composite, and keep a handle to the issue provider so its client can be set after bind:

```ts
  const mcpToken = randomUUID()
  const issueTools = new IssueToolProvider()
  const mcpProvider = new CompositeMcpProvider([superagent, issueTools])
  registerMcpRoute(app, mcpProvider, mcpToken)
```

In the `serve(...)` callback where `superagent.setMcpEndpoint(...)` is called (after `info.port` is known), also point the issue tools at the loopback API:

```ts
      issueTools.setClient(makeIssueClient(`http://127.0.0.1:${info.port}`))
```

Add the imports at the top of `server.ts`: `import { CompositeMcpProvider, IssueToolProvider } from './issue-mcp'` and `import { makeIssueClient } from './issue-client'`.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run apps/server/src/issue-mcp.test.ts apps/server/src/issue-commands.test.ts` then `bun run typecheck`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issue-mcp.ts apps/server/src/issue-mcp.test.ts apps/server/src/server.ts
git commit -m "feat(tracker): issue MCP tools composed into the podium MCP server"
```

---

### Task 4: End-to-end smoke — CLI against an isolated in-process server

**Files:**
- Test: `apps/server/src/issue-cli.e2e.test.ts` (create).

**Interfaces:**
- Consumes: `startServer` (`./server`), `makeIssueClient`, `runIssueCli` (`../../../scripts/issue-cli` — adjust the relative path), `ISSUE_COMMANDS`.

This is the ONE test that exercises the real HTTP path. It must isolate state and NEVER spawn agents.

- [ ] **Step 1: Write the test**

Create `apps/server/src/issue-cli.e2e.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './server'
import { makeIssueClient } from './issue-client'
import { runIssueCli } from '../../../scripts/issue-cli'

describe('podium issue CLI ↔ live server (e2e)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-issue-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ port: 0 })
    baseUrl = `http://127.0.0.1:${server.port}`
  })
  afterAll(async () => {
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    delete process.env.PODIUM_STATE_DIR
  })

  it('create → ready → claim → close round-trips through the CLI', async () => {
    const client = makeIssueClient(baseUrl)
    const created = await runIssueCli(['create', '--repoPath', '/repo', '--title', 'Wire the CLI', '--priority', '1'], client)
    expect(created).toMatch(/created #\d+/)

    const ready = await runIssueCli(['ready', '--repoPath', '/repo'], client)
    expect(ready).toContain('Wire the CLI')

    // Resolve the id via the typed client, then claim + close through the CLI.
    const list = (await client.issues.list.query({ repoPath: '/repo' })) as Array<{ id: string }>
    const id = list[0].id
    expect(await runIssueCli(['claim', '--id', id, '--assignee', 'agent:test'], client)).toMatch(/claimed/)
    expect(await runIssueCli(['close', '--id', id, '--reason', 'done'], client)).toMatch(/closed/)

    const stats = await runIssueCli(['stats', '--repoPath', '/repo'], client)
    expect(stats).toMatch(/closed: 1/)
  })
})
```

Confirm the relative import path to `scripts/issue-cli` from `apps/server/src/` resolves (`../../../scripts/issue-cli`); adjust if the test reports module-not-found.

- [ ] **Step 2: Run the test**

Run: `npx vitest run apps/server/src/issue-cli.e2e.test.ts`
Expected: the create→ready→claim→close→stats flow PASSES against the real loopback server. If `PODIUM_STATE_DIR` is not honored by `SessionStore` (check `defaultDbPath()`), use the env var the store actually reads, or pass an explicit `:memory:`-style isolation — verify by reading `store.ts` `defaultDbPath()`.

- [ ] **Step 3: Confirm no agent processes were spawned**

This test only calls `create`/`list`/`ready`/`claim`/`close`/`stats` — none of which spawn a worktree or session. Confirm by grepping the test for `start`/`addSession` (should be absent).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/issue-cli.e2e.test.ts
git commit -m "test(tracker): e2e CLI↔server smoke (create/ready/claim/close/stats)"
```

---

## Phase Close (P3a)

- [ ] Full P3a + tracker scope green: `npx vitest run apps/server/src/issue-commands.test.ts apps/server/src/issue-mcp.test.ts scripts/issue-cli.test.ts apps/server/src/issue-cli.e2e.test.ts apps/server/src/issues.test.ts`
- [ ] `bun run typecheck` clean; `biome check` clean on the NEW files (issue-client/issue-commands/issue-mcp/issue-cli + tests).
- [ ] Manual sanity (optional): with the live server running, `bun scripts/cli.ts issue ready` prints ready issues.
- [ ] Hand off to **P3b plan** (roles: reader/worker/maintainer — token→role in `createContext`, per-command capability gating, role-token minting, spawn-time `PODIUM_ISSUE_TOKEN` injection).

## Self-Review notes (author)

- **Spec coverage (P3a):** one shared registry (Task 1) ✓; CLI (Task 2) ✓; MCP tools composed into the single `podium` MCP (Task 3) ✓; uniform HTTP transport ✓; e2e smoke (Task 4) ✓. Roles deferred to **P3b** (by design). The registry ships a representative core (~12 verbs); the remaining `issues.*` procedures (graph/doctor/lint/stale/orphans/find-duplicates/supersede/duplicate/label/defer/reparent) follow the identical `IssueCommand` shape and are mechanical adds — note for P3b or a follow-up.
- **Placeholder scan:** none — every step has complete code.
- **Type-consistency:** the registry's `run(client, args)` uses the `IssueTrpc` type from Task 1; the CLI (Task 2) and MCP provider (Task 3) both consume `ISSUE_COMMANDS` + that client; `server.ts` wires `IssueToolProvider.setClient` at the same point as `superagent.setMcpEndpoint`. The `as never`/`as ...` casts at the registry→procedure boundary are deliberate (the zod args are the runtime guard).
- **Risks:** (1) `PODIUM_STATE_DIR` isolation in Task 4 — verify the env var `SessionStore` actually reads (check `defaultDbPath()`); if different, use the real one. (2) `@trpc/client` must resolve from `apps/server` after `bun install` (added as a dep). (3) `zodToJsonSchema` is intentionally minimal (flat schemas only) — fine for the registry's flat args; do not feed it nested schemas.
