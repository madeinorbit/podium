# Interim SQLite Persistence — Layer 1 (SQLite store + durable ids + repos migration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repo list and the work-panel (session) list durable in a server-side SQLite database so they survive a backend restart — sessions reload as re-resumable `exited` rows (no live agents yet; that's Layer 2/3).

**Architecture:** A new `SessionStore` (`apps/server/src/store.ts`) wraps Node's built-in `node:sqlite` with three tables (`repos`, `sessions`, `meta`). `RepoRegistry` becomes a thin store-backed adapter (its JSON file is imported once on migration). `SessionRegistry` gains durable `crypto.randomUUID()` session ids, writes every session lifecycle change through to the store, and on construction **loads** persisted sessions — marking any previously-`live`/`starting` row `exited`, since in Layer 1 the ephemeral PTYs die with the daemon.

**Tech Stack:** TypeScript (ESM, no semicolons — Biome enforced), `node:sqlite` (`DatabaseSync`, synchronous), Vitest, Biome, run under Node 22 via `tsx`.

**Scope note:** This is Layer 1 of the 3-layer build order in `docs/superpowers/specs/2026-06-09-interim-sqlite-persistence-design.md`. Layer 2 (tmux-backed `AgentSession` + daemon spawns under tmux) and Layer 3 (boot-reconcile protocol + live re-bind) each get their own plan once this lands and pins the real `SessionStore`/`Session` APIs. **No protocol changes in Layer 1.**

---

## Working directory & conventions

- **All work happens in the worktree:** `/home/user/src/other/podium/.claude/worktrees/interim-sqlite-persistence`. Paths below are relative to it. When using Write/Edit, pass the **full worktree-prefixed absolute path** (a bare `apps/...` path may resolve against the main checkout).
- Run all commands from the worktree root. Tests must run from there (the root `vitest.config.ts` excludes `**/.claude/**`, but the worktree's own test files are not under a `.claude/` path *relative to the worktree root*, so they run).
- Code style: **no semicolons, single quotes, 2-space indent** (Biome). Before each commit, run `node_modules/.bin/biome check --write <changed files>` to auto-format + sort imports.
- Every commit message ends with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File structure

| File | Responsibility |
|------|----------------|
| `apps/server/src/store.ts` (create) | `SessionStore`: `node:sqlite` schema/migration, repos CRUD, sessions CRUD, `repos.json` import. `SessionRow` type + `defaultDbPath()`. The only place that touches SQL. |
| `apps/server/src/store.test.ts` (create) | Unit tests for `SessionStore` against temp-file and `:memory:` DBs. |
| `apps/server/src/repo-registry.ts` (modify) | `RepoRegistry` becomes a thin store-backed adapter (keeps path validation). `browseDirectories` + helpers unchanged. `RepoRegistry.load()` and the old JSON internals removed. |
| `apps/server/src/repo-registry.test.ts` (modify) | Re-pointed at the store-backed `RepoRegistry`; `browseDirectories` test unchanged. |
| `apps/server/src/session.ts` (modify) | `Session` gains optional `resume`, `tmuxLabel`, `lastActiveAt`, `status`, `exitCode` init fields (all defaulted) + a `toRow(): SessionRow` serializer. |
| `apps/server/src/relay.ts` (modify) | `SessionRegistry` takes a `SessionStore` (defaults to `:memory:`), mints durable ids, writes through on spawn/bind/title/exit/kill, and `loadFromStore()` on construction. |
| `apps/server/src/relay.test.ts` (modify) | Add write-through + boot-reconcile tests; existing tests unchanged (default `:memory:` store). |
| `apps/server/src/router.test.ts` (modify) | Construct `RepoRegistry` from a `SessionStore` instead of a JSON path; drop `repos.load()`. |
| `apps/server/src/server.ts` (modify) | Instantiate one `SessionStore`, pass it to `SessionRegistry` + `RepoRegistry`; drop `repos.load()`; close the store on shutdown. |

---

## Task 0: Worktree setup & green baseline

**Files:** none (environment only)

- [ ] **Step 1: Install dependencies in the worktree**

The worktree is a fresh checkout with no `node_modules`.

Run: `bun install`
Expected: completes; `node_modules/.bin/vitest` now exists.

- [ ] **Step 2: Confirm the baseline server tests pass**

Run: `node_modules/.bin/vitest run apps/server`
Expected: `Test Files  4 passed (4)`, `Tests  36 passed (36)`.

- [ ] **Step 3: Confirm `node:sqlite` runtime + types**

Run: `node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('create table t(x)');console.log('ok')" 2>/dev/null`
Expected: prints `ok`. (An `ExperimentalWarning` on stderr is normal and harmless.)

No commit (no source changes).

---

## Task 1: `SessionStore` — schema + repos CRUD

**Files:**
- Create: `apps/server/src/store.ts`
- Test: `apps/server/src/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/store.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

async function tmpDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'podium-store-'))
  return join(dir, 'podium.db')
}

describe('SessionStore repos', () => {
  it('starts empty, adds, dedupes, lists in insertion order, removes', () => {
    const store = new SessionStore(':memory:')
    expect(store.listRepos()).toEqual([])
    store.addRepo('/home/u/b')
    store.addRepo('/home/u/a')
    store.addRepo('/home/u/b') // dedupe
    expect(store.listRepos()).toEqual(['/home/u/b', '/home/u/a'])
    store.removeRepo('/home/u/b')
    expect(store.listRepos()).toEqual(['/home/u/a'])
    store.close()
  })

  it('persists repos across instances on the same file', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.addRepo('/abs/one')
    a.close()
    const b = new SessionStore(file)
    expect(b.listRepos()).toEqual(['/abs/one'])
    b.close()
  })

  it('exposes loadSessions() as [] on a fresh db (tables exist)', () => {
    const store = new SessionStore(':memory:')
    expect(store.loadSessions()).toEqual([])
    store.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run apps/server/src/store.test.ts`
Expected: FAIL — `Failed to resolve import "./store"` / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/store.ts`:

```ts
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Default DB file: $PODIUM_STATE_DIR/podium.db, else ~/.podium/podium.db. */
export function defaultDbPath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
  return join(base, 'podium.db')
}

export type SessionStatusPersisted = 'starting' | 'live' | 'hibernated' | 'exited'

/** One persisted session row. camelCase mirror of the snake_case `sessions` table. */
export interface SessionRow {
  id: string
  agentKind: string
  cwd: string
  title: string
  originKind: 'spawn' | 'resume'
  conversationId: string | null
  resumeKind: string | null
  resumeValue: string | null
  status: SessionStatusPersisted
  exitCode: number | null
  tmuxLabel: string
  createdAt: string
  lastActiveAt: string
}

/** Durable server-side store: repos + sessions registry. Single writer (the server). */
export class SessionStore {
  private readonly db: DatabaseSync

  constructor(private readonly path: string = defaultDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.migrate()
  }

  // ---- repos ----
  listRepos(): string[] {
    const rows = this.db.prepare('SELECT path FROM repos ORDER BY rowid ASC').all() as {
      path: string
    }[]
    return rows.map((r) => r.path)
  }

  addRepo(path: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO repos (path, added_at) VALUES (?, ?)')
      .run(path, new Date().toISOString())
  }

  removeRepo(path: string): void {
    this.db.prepare('DELETE FROM repos WHERE path = ?').run(path)
  }

  // ---- sessions ----
  loadSessions(): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_kind, cwd, title, origin_kind, conversation_id, resume_kind,
                resume_value, status, exit_code, tmux_label, created_at, last_active_at
         FROM sessions ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      agentKind: r.agent_kind as string,
      cwd: r.cwd as string,
      title: r.title as string,
      originKind: r.origin_kind as 'spawn' | 'resume',
      conversationId: (r.conversation_id as string | null) ?? null,
      resumeKind: (r.resume_kind as string | null) ?? null,
      resumeValue: (r.resume_value as string | null) ?? null,
      status: r.status as SessionStatusPersisted,
      exitCode: (r.exit_code as number | null) ?? null,
      tmuxLabel: r.tmux_label as string,
      createdAt: r.created_at as string,
      lastActiveAt: r.last_active_at as string,
    }))
  }

  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, agent_kind, cwd, title, origin_kind, conversation_id, resume_kind,
            resume_value, status, exit_code, tmux_label, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           origin_kind = excluded.origin_kind,
           conversation_id = excluded.conversation_id,
           resume_kind = excluded.resume_kind,
           resume_value = excluded.resume_value,
           status = excluded.status,
           exit_code = excluded.exit_code,
           tmux_label = excluded.tmux_label,
           last_active_at = excluded.last_active_at`,
      )
      .run(
        row.id,
        row.agentKind,
        row.cwd,
        row.title,
        row.originKind,
        row.conversationId,
        row.resumeKind,
        row.resumeValue,
        row.status,
        row.exitCode,
        row.tmuxLabel,
        row.createdAt,
        row.lastActiveAt,
      )
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  close(): void {
    this.db.close()
  }

  // ---- schema ----
  private migrate(): void {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('CREATE TABLE IF NOT EXISTS repos (path TEXT PRIMARY KEY, added_at TEXT NOT NULL)')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         agent_kind TEXT NOT NULL,
         cwd TEXT NOT NULL,
         title TEXT NOT NULL,
         origin_kind TEXT NOT NULL,
         conversation_id TEXT,
         resume_kind TEXT,
         resume_value TEXT,
         status TEXT NOT NULL,
         exit_code INTEGER,
         tmux_label TEXT NOT NULL,
         created_at TEXT NOT NULL,
         last_active_at TEXT NOT NULL
       )`,
    )
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const v = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    if (!v) this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
    this.importReposJson()
  }

  /** One-time import of a legacy ~/.podium/repos.json sitting next to the db. */
  private importReposJson(): void {
    if (this.path === ':memory:') return
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM repos').get() as { c: number }).c
    if (count > 0) return
    let raw: string
    try {
      raw = readFileSync(join(dirname(this.path), 'repos.json'), 'utf8')
    } catch {
      return // no legacy file
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // corrupt file -> skip
    }
    if (!Array.isArray(parsed)) return
    const insert = this.db.prepare('INSERT OR IGNORE INTO repos (path, added_at) VALUES (?, ?)')
    const now = new Date().toISOString()
    for (const p of parsed) if (typeof p === 'string') insert.run(p, now)
  }
}
```

- [ ] **Step 4: Format, then run test to verify it passes**

Run: `node_modules/.bin/biome check --write apps/server/src/store.ts apps/server/src/store.test.ts && node_modules/.bin/vitest run apps/server/src/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.test.ts
git commit -m "feat(server): SessionStore with node:sqlite schema + repos CRUD

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `SessionStore` — legacy `repos.json` import

**Files:**
- Test: `apps/server/src/store.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/store.test.ts`:

```ts
import { writeFile } from 'node:fs/promises'

describe('SessionStore repos.json import', () => {
  it('imports a sibling repos.json into an empty db, once', async () => {
    const file = await tmpDbPath()
    await writeFile(join(dirname(file), 'repos.json'), JSON.stringify(['/a', '/b']))
    const a = new SessionStore(file)
    expect(a.listRepos()).toEqual(['/a', '/b'])
    a.close()
    // Re-open: repos already present, so a (possibly changed) json is NOT re-imported.
    await writeFile(join(dirname(file), 'repos.json'), JSON.stringify(['/c']))
    const b = new SessionStore(file)
    expect(b.listRepos()).toEqual(['/a', '/b'])
    b.close()
  })

  it('tolerates a missing or corrupt repos.json', async () => {
    const missing = await tmpDbPath()
    expect(new SessionStore(missing).listRepos()).toEqual([])
    const corrupt = await tmpDbPath()
    await writeFile(join(dirname(corrupt), 'repos.json'), 'not json')
    expect(new SessionStore(corrupt).listRepos()).toEqual([])
  })
})
```

Add `import { dirname } from 'node:path'` to the test file's imports (alongside `join`).

- [ ] **Step 2: Run test to verify it passes immediately**

The import logic was already implemented in Task 1 (`importReposJson`). This task is the test that proves it.

Run: `node_modules/.bin/vitest run apps/server/src/store.test.ts`
Expected: PASS (5 tests total). If it fails, fix `importReposJson` until green.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/store.test.ts
git commit -m "test(server): cover repos.json one-time import into SessionStore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `SessionStore` — sessions CRUD

**Files:**
- Test: `apps/server/src/store.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/store.test.ts`:

```ts
import type { SessionRow } from './store'

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'id-1',
    agentKind: 'claude-code',
    cwd: '/proj',
    title: 'proj',
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'starting',
    exitCode: null,
    tmuxLabel: 'podium-id-1',
    createdAt: '2026-06-09T00:00:00.000Z',
    lastActiveAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  }
}

describe('SessionStore sessions', () => {
  it('upserts, loads, updates in place (preserving created_at), and deletes', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.upsertSession(row())
    a.upsertSession(
      row({ status: 'live', title: 'renamed', lastActiveAt: '2026-06-09T00:05:00.000Z' }),
    )
    a.close()

    const b = new SessionStore(file)
    expect(b.loadSessions()).toEqual([
      row({ status: 'live', title: 'renamed', lastActiveAt: '2026-06-09T00:05:00.000Z' }),
    ])
    b.deleteSession('id-1')
    expect(b.loadSessions()).toEqual([])
    b.close()
  })

  it('round-trips resume metadata', () => {
    const store = new SessionStore(':memory:')
    const r = row({
      id: 'id-2',
      originKind: 'resume',
      conversationId: 'c9',
      resumeKind: 'codex-thread',
      resumeValue: 't9',
      tmuxLabel: 'podium-id-2',
    })
    store.upsertSession(r)
    expect(store.loadSessions()).toEqual([r])
    store.close()
  })
})
```

- [ ] **Step 2: Run test to verify it passes immediately**

`upsertSession`/`loadSessions`/`deleteSession` were implemented in Task 1.

Run: `node_modules/.bin/vitest run apps/server/src/store.test.ts`
Expected: PASS (7 tests total). Fix the store until green if not.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/store.test.ts
git commit -m "test(server): cover SessionStore sessions upsert/load/delete

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `RepoRegistry` becomes store-backed

**Files:**
- Modify: `apps/server/src/repo-registry.ts`
- Modify: `apps/server/src/repo-registry.test.ts`

- [ ] **Step 1: Rewrite the test for a store-backed RepoRegistry**

Replace the top of `apps/server/src/repo-registry.test.ts` (imports + the first four `it`s) so the `RepoRegistry` describe block reads as below. **Keep the existing `browses server-side directories from HOME by default` test exactly as it is.**

```ts
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browseDirectories, RepoRegistry } from './repo-registry'
import { SessionStore } from './store'

describe('RepoRegistry', () => {
  it('starts empty, adds, dedupes, lists, removes', async () => {
    const reg = new RepoRegistry(new SessionStore(':memory:'))
    expect(reg.list()).toEqual([])
    await reg.add('/home/u/src/app')
    await reg.add('/home/u/src/app') // dedupe
    expect(reg.list()).toEqual(['/home/u/src/app'])
    await reg.remove('/home/u/src/app')
    expect(reg.list()).toEqual([])
  })

  it('rejects non-absolute and empty paths', async () => {
    const reg = new RepoRegistry(new SessionStore(':memory:'))
    await expect(reg.add('')).rejects.toThrow()
    await expect(reg.add('relative/path')).rejects.toThrow()
  })

  it('persists across instances on the same db file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-reporeg-'))
    const file = join(dir, 'podium.db')
    const a = new RepoRegistry(new SessionStore(file))
    await a.add('/abs/one')
    const b = new RepoRegistry(new SessionStore(file))
    expect(b.list()).toEqual(['/abs/one'])
  })

  // ... keep the existing `browses server-side directories from HOME by default` test below ...
```

(Delete the old `tmpFile()` helper and the `persists across instances` JSON assertion and the `tolerates a corrupt file` test — those behaviors now live in `store.test.ts`. Remove the now-unused `readFile`/`writeFile` imports; keep `mkdir`/`mkdtemp`/`tmpdir`/`join` for the browse test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run apps/server/src/repo-registry.test.ts`
Expected: FAIL — `RepoRegistry` constructor still expects a file path string; `reg.list()` / `new RepoRegistry(store)` type/behavior mismatch.

- [ ] **Step 3: Rewrite `RepoRegistry` to delegate to the store**

In `apps/server/src/repo-registry.ts`: keep `browseDirectories`, `currentHomeDir`, `expandHome`, and the `DirectoryBrowserEntry`/`DirectoryBrowserListing` types exactly as they are. **Delete** `defaultRegistryPath` and the entire old `RepoRegistry` class, and replace the class with:

```ts
import { SessionStore } from './store'

/** Persisted list of absolute repo-root paths, backed by SessionStore. Shared by all
 *  clients so the repo list survives and shows on every device (desktop + phone). */
export class RepoRegistry {
  constructor(private readonly store: SessionStore) {}

  list(): string[] {
    return this.store.listRepos()
  }

  async add(path: string): Promise<void> {
    const p = path.trim()
    if (!p) throw new Error('repo path is empty')
    if (!isAbsolute(p)) throw new Error(`repo path must be absolute: ${p}`)
    this.store.addRepo(p)
  }

  async remove(path: string): Promise<void> {
    this.store.removeRepo(path.trim())
  }
}
```

Adjust the top-of-file imports: `isAbsolute` is still needed; `mkdir`, `readFile`, `writeFile`, `dirname` may no longer be used by this file — remove any that Biome flags as unused (keep `readdir`, `realpath`, `stat` for `browseDirectories`, and `homedir`, `join` as used). The `add`/`remove` keep `async` so `router.ts` (which `await`s them) is untouched.

- [ ] **Step 4: Format, then run test to verify it passes**

Run: `node_modules/.bin/biome check --write apps/server/src/repo-registry.ts apps/server/src/repo-registry.test.ts && node_modules/.bin/vitest run apps/server/src/repo-registry.test.ts`
Expected: PASS (all `RepoRegistry` tests + the unchanged browse test).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/repo-registry.ts apps/server/src/repo-registry.test.ts
git commit -m "refactor(server): back RepoRegistry with SessionStore (SQLite)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `Session` gains persistence fields + `toRow()`

**Files:**
- Modify: `apps/server/src/session.ts`
- Test: `apps/server/src/session.test.ts` (add one test; existing tests unchanged)

- [ ] **Step 1: Write the failing test**

Append a test to the `describe('Session', ...)` block in `apps/server/src/session.test.ts`:

```ts
  it('serializes to a persistable row, defaulting tmuxLabel/lastActiveAt', () => {
    const s = makeSession()
    expect(s.toRow()).toMatchObject({
      id: 's1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'starting',
      exitCode: null,
      tmuxLabel: 'podium-s1',
      createdAt: '2026-06-03T00:00:00.000Z',
      lastActiveAt: '2026-06-03T00:00:00.000Z',
    })
    s.onExit(3)
    expect(s.toRow()).toMatchObject({ status: 'exited', exitCode: 3 })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run apps/server/src/session.test.ts`
Expected: FAIL — `s.toRow is not a function`.

- [ ] **Step 3: Implement the new fields + `toRow()`**

In `apps/server/src/session.ts`:

Add to the imports (type-only):

```ts
import type { ResumeRef } from '@podium/protocol'
import type { SessionRow } from './store'
```

Extend `SessionInit` with optional fields:

```ts
export interface SessionInit {
  sessionId: string
  agentKind: AgentKind
  cwd: string
  title: string
  origin: SessionOrigin
  createdAt: string
  geometry: Geometry
  toDaemon: Send<ControlMessage>
  resume?: ResumeRef
  tmuxLabel?: string
  lastActiveAt?: string
  status?: 'starting' | 'live' | 'exited'
  exitCode?: number
}
```

Add fields + initialize them in the constructor (alongside the existing assignments):

```ts
  readonly tmuxLabel: string
  readonly resume?: ResumeRef
  lastActiveAt: string
```

```ts
  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.agentKind = init.agentKind
    this.cwd = init.cwd
    this.title = init.title
    this.origin = init.origin
    this.createdAt = init.createdAt
    this.geometry = { ...init.geometry }
    this.toDaemon = init.toDaemon
    this.tmuxLabel = init.tmuxLabel ?? `podium-${init.sessionId}`
    this.resume = init.resume
    this.lastActiveAt = init.lastActiveAt ?? init.createdAt
    if (init.status) this.status = init.status
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
  }
```

Update `lastActiveAt` whenever the session does something notable — in `markLive` and `setTitle`, add as the first line of each:

```ts
    this.lastActiveAt = new Date().toISOString()
```

Add the serializer method (e.g. just above `toMeta()`):

```ts
  toRow(): SessionRow {
    return {
      id: this.sessionId,
      agentKind: this.agentKind,
      cwd: this.cwd,
      title: this.title,
      originKind: this.origin.kind,
      conversationId: this.origin.kind === 'resume' ? this.origin.conversationId : null,
      resumeKind: this.resume?.kind ?? null,
      resumeValue: this.resume?.value ?? null,
      status: this.status,
      exitCode: this.exitCode ?? null,
      tmuxLabel: this.tmuxLabel,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    }
  }
```

- [ ] **Step 4: Format, then run test to verify it passes**

Run: `node_modules/.bin/biome check --write apps/server/src/session.ts apps/server/src/session.test.ts && node_modules/.bin/vitest run apps/server/src/session.test.ts`
Expected: PASS (all `Session` tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/session.ts apps/server/src/session.test.ts
git commit -m "feat(server): Session carries resume/tmuxLabel/lastActiveAt + toRow()

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `SessionRegistry` — durable ids + write-through persistence

**Files:**
- Modify: `apps/server/src/relay.ts`
- Test: `apps/server/src/relay.test.ts` (add a write-through test; existing tests unchanged)

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/relay.test.ts` (add `import { SessionStore } from './store'` at the top):

```ts
  it('write-through: a spawned session is persisted, live/exit/title update the row', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/a', title: 't' })
    expect(store.loadSessions()).toMatchObject([{ id: sessionId, status: 'starting', title: 't' }])
    reg.onDaemonMessage(bind(sessionId))
    expect(store.loadSessions().at(0)).toMatchObject({ status: 'live' })
    reg.onDaemonMessage({ type: 'title', sessionId, title: '✳ working' })
    expect(store.loadSessions().at(0)).toMatchObject({ title: '✳ working' })
    reg.onDaemonMessage({ type: 'agentExit', sessionId, code: 0 })
    expect(store.loadSessions().at(0)).toMatchObject({ status: 'exited', exitCode: 0 })
    reg.killSession({ sessionId })
    expect(store.loadSessions()).toEqual([])
  })

  it('mints opaque durable session ids (uuid), not the s0 counter', () => {
    const reg = new SessionRegistry(new SessionStore(':memory:'))
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/a' })
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run apps/server/src/relay.test.ts`
Expected: FAIL — `new SessionRegistry(store)` not accepted / ids are `s0` not a uuid / `store.loadSessions` empty.

- [ ] **Step 3: Implement store injection, durable ids, write-through**

In `apps/server/src/relay.ts`:

Add imports:

```ts
import { randomUUID } from 'node:crypto'
import { SessionStore } from './store'
```

Add a constructor that takes the store and remove the `nextSessionNum` counter field. Insert near the top of the class body (after the `private readonly clients` / pending-map fields, and delete the `private nextSessionNum = 0` line):

```ts
  constructor(private readonly store: SessionStore = new SessionStore(':memory:')) {
    this.loadFromStore()
  }

  private persist(session: Session): void {
    this.store.upsertSession(session.toRow())
  }
```

Rewrite `spawn` to mint a durable id, pass `tmuxLabel` + `resume`, and persist:

```ts
  private spawn(input: {
    agentKind: AgentKind
    cwd: string
    title?: string
    origin: SessionMeta['origin']
    resume?: ResumeRef
  }): { sessionId: string } {
    const sessionId = randomUUID()
    const session = new Session({
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      origin: input.origin,
      createdAt: new Date().toISOString(),
      geometry: { ...DEFAULT_GEOMETRY },
      toDaemon: this.toDaemon,
      tmuxLabel: `podium-${sessionId}`,
      ...(input.resume ? { resume: input.resume } : {}),
    })
    this.sessions.set(sessionId, session)
    this.persist(session)
    this.toDaemon({
      type: 'spawn',
      sessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      ...(input.resume ? { resume: input.resume } : {}),
      geometry: { ...DEFAULT_GEOMETRY },
    })
    this.broadcastSessions()
    return { sessionId }
  }
```

`ResumeRef` is already in the `@podium/protocol` import list at the top of `relay.ts` — do **not** add a duplicate; just confirm it's present.

Persist on the other lifecycle transitions in `onDaemonMessage`:
- `case 'bind'`: after `this.sessions.get(msg.sessionId)?.markLive(...)`, add `const s = this.sessions.get(msg.sessionId); if (s) this.persist(s)`.
- `case 'agentExit'`: after `?.onExit(msg.code)`, add the same persist.
- `case 'spawnError'`: after `?.markSpawnError(msg.message)`, add the same persist.
- `case 'title'`: after `session.setTitle(msg.title)`, add `this.persist(session)`.

In `killSession`, add `this.store.deleteSession(input.sessionId)` after deleting from the in-memory map.

Add the boot loader (implemented fully in Task 7 — for now add a stub so it compiles):

```ts
  private loadFromStore(): void {
    // Implemented in Task 7.
  }
```

- [ ] **Step 4: Format, then run test to verify it passes**

Run: `node_modules/.bin/biome check --write apps/server/src/relay.ts apps/server/src/relay.test.ts && node_modules/.bin/vitest run apps/server/src/relay.test.ts`
Expected: PASS (existing tests + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(server): durable session ids + write-through persistence to SessionStore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `SessionRegistry.loadFromStore()` — boot reconcile (Layer 1)

**Files:**
- Modify: `apps/server/src/relay.ts`
- Test: `apps/server/src/relay.test.ts`

- [ ] **Step 1: Write the failing test**

Add these imports to the top of `apps/server/src/relay.test.ts` (the repo is ESM — no inline `require`, which Biome would flag):

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
```

Then add the test:

```ts
  it('boot reconcile: persisted sessions reload as exited (Layer 1, no survival)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-relay-')), 'podium.db')
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.attachDaemon(() => {})
    const { sessionId } = reg1.resumeSession({
      agentKind: 'codex',
      cwd: '/w',
      resume: { kind: 'codex-thread', value: 't9' },
      conversationId: 'c9',
      title: 'old',
    })
    reg1.onDaemonMessage(bind(sessionId))
    store1.close()

    // Simulate a backend restart: brand-new registry over the same db.
    const store2 = new SessionStore(file)
    const reg2 = new SessionRegistry(store2)
    const meta = reg2.listSessions().find((m) => m.sessionId === sessionId)
    expect(meta).toMatchObject({
      sessionId,
      status: 'exited',
      title: 'old',
      origin: { kind: 'resume', conversationId: 'c9' },
    })
    // Resume metadata is retained for a future re-resume.
    expect(store2.loadSessions().at(0)).toMatchObject({
      resumeKind: 'codex-thread',
      resumeValue: 't9',
      status: 'exited',
    })
    store2.close()
  })
```

(Prefer top-of-file `import { mkdtempSync } from 'node:fs'` etc. if you'd rather avoid inline `require`; the inline form keeps the diff local.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run apps/server/src/relay.test.ts -t "boot reconcile"`
Expected: FAIL — `reg2.listSessions()` is empty (loader is still the Task 6 stub).

- [ ] **Step 3: Implement `loadFromStore`**

Replace the stub in `apps/server/src/relay.ts`:

```ts
  private loadFromStore(): void {
    for (const r of this.store.loadSessions()) {
      // Layer 1 has no process survival yet: any session that was live/starting
      // when we went down is now dead. Reconstruct it as exited so the panel is
      // still listed and re-resumable, and persist the correction.
      const exitCode = r.status === 'exited' ? r.exitCode : (r.exitCode ?? -1)
      const session = new Session({
        sessionId: r.id,
        agentKind: r.agentKind as AgentKind,
        cwd: r.cwd,
        title: r.title,
        origin:
          r.originKind === 'resume'
            ? { kind: 'resume', conversationId: r.conversationId ?? '' }
            : { kind: 'spawn' },
        createdAt: r.createdAt,
        geometry: { ...DEFAULT_GEOMETRY },
        toDaemon: this.toDaemon,
        tmuxLabel: r.tmuxLabel,
        lastActiveAt: r.lastActiveAt,
        status: 'exited',
        exitCode: exitCode ?? -1,
        ...(r.resumeKind && r.resumeValue
          ? { resume: { kind: r.resumeKind, value: r.resumeValue } }
          : {}),
      })
      this.sessions.set(r.id, session)
      if (r.status !== 'exited') this.persist(session)
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run apps/server/src/relay.test.ts`
Expected: PASS (all relay tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(server): boot-load persisted sessions as exited (Layer 1 reconcile)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire the store into `server.ts` + fix `router.test.ts`

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/router.test.ts`

- [ ] **Step 1: Update `router.test.ts` to construct repos from a store**

In `apps/server/src/router.test.ts`: add `import { SessionStore } from './store'`, and replace every `new RepoRegistry(join(tmpdir(), '...json'))` construction (there are three: in `caller()`, in the `discovery.scan` test, and in `repoCaller()`) with `new RepoRegistry(new SessionStore(':memory:'))`. In `repoCaller()`, delete the `await repos.load()` line. The `mkdtemp`/`tmpdir`/`join` imports can be removed if no longer used after the change (Biome will flag unused).

Concretely, `caller()` becomes:

```ts
function caller() {
  const registry = new SessionRegistry()
  registry.attachDaemon(() => {})
  const repos = new RepoRegistry(new SessionStore(':memory:'))
  return { registry, call: appRouter.createCaller({ registry, repos }) }
}
```

and `repoCaller()` becomes:

```ts
function repoCaller() {
  const repos = new RepoRegistry(new SessionStore(':memory:'))
  const registry = new SessionRegistry()
  const daemon: import('@podium/protocol').ControlMessage[] = []
  registry.attachDaemon((m) => daemon.push(m))
  return { registry, repos, daemon, call: appRouter.createCaller({ registry, repos }) }
}
```

(It no longer needs to be `async`; update its call sites from `await repoCaller()` to `repoCaller()`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run apps/server/src/router.test.ts`
Expected: FAIL — `new RepoRegistry(new SessionStore(...))` won't typecheck/run until `server.ts` and types align, or `repoCaller is not... await` mismatch. (If it happens to pass after the test edit alone, that's fine — proceed.)

- [ ] **Step 3: Wire `server.ts`**

Edit `apps/server/src/server.ts`:

```ts
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SessionStore } from './store'
import { attachWebSockets } from './wsServer'

export interface ServerHandle {
  port: number
  registry: SessionRegistry
  close(): Promise<void>
}

export async function startServer(opts: { port?: number } = {}): Promise<ServerHandle> {
  const store = new SessionStore()
  const registry = new SessionRegistry(store)
  const repos = new RepoRegistry(store)
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
  app.use('/trpc/*', cors())
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext: () => ({ registry, repos }) }))

  return new Promise<ServerHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0 }, (info) => {
      const ws = attachWebSockets(server as unknown as Server, registry)
      resolve({
        port: info.port,
        registry,
        close: () =>
          ws.close().then(
            () =>
              new Promise<void>((res) => {
                ;(server as unknown as Server).close(() => {
                  store.close()
                  res()
                })
              }),
          ),
      })
    })
  })
}
```

- [ ] **Step 4: Format, then run the test to verify it passes**

Run: `node_modules/.bin/biome check --write apps/server/src/server.ts apps/server/src/router.test.ts && node_modules/.bin/vitest run apps/server/src/router.test.ts`
Expected: PASS (all router + repos-router tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server.ts apps/server/src/router.test.ts
git commit -m "feat(server): wire SessionStore into startServer; repos+sessions share one db

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full verification (typecheck + lint + suite)

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the server package**

Run: `bun run --filter @podium/server typecheck`
Expected: no errors. (If `node:sqlite` types are missing, confirm `@types/node` ≥ 22.5 — the repo pins 25.9.1, which ships `sqlite.d.ts`.)

- [ ] **Step 2: Lint the whole repo**

Run: `node_modules/.bin/biome check .`
Expected: no errors (formatting + import order already applied per task).

- [ ] **Step 3: Run the full test suite from the worktree root**

Run: `node_modules/.bin/vitest run`
Expected: all packages green, including the new `apps/server/src/store.test.ts` and the expanded relay/repo-registry/session/router suites. No regressions vs. the 36-test baseline (count should be higher now).

- [ ] **Step 4: Manual smoke (optional but recommended)**

Verify the real persistence path across two *separate* server processes sharing one throwaway state dir (server code is `.ts`, so run it through `tsx`, not bare `node`):

```bash
DIR=$(mktemp -d)
# Process 1: create a panel, then shut down.
PODIUM_STATE_DIR="$DIR" node_modules/.bin/tsx -e "
import { startServer } from './apps/server/src/index.ts'
const s = await startServer({ port: 0 })
s.registry.createSession({ agentKind: 'claude-code', cwd: '/tmp/demo', title: 'demo' })
await s.close()
" 2>/dev/null
# Process 2: fresh start over the same db — the panel should reload as exited.
PODIUM_STATE_DIR="$DIR" node_modules/.bin/tsx -e "
import { startServer } from './apps/server/src/index.ts'
const s = await startServer({ port: 0 })
console.log('reloaded:', s.registry.listSessions().map(x => ({ title: x.title, status: x.status })))
await s.close()
" 2>/dev/null
```

Expected: the second process prints `reloaded: [ { title: 'demo', status: 'exited' } ]` — proving the panel survived a full process restart over the same `$PODIUM_STATE_DIR`.

- [ ] **Step 5: Final no-op commit guard**

If Steps 1-3 surfaced any fix, commit it:

```bash
git add -A
git commit -m "chore(server): Layer 1 verification fixes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Done criteria (Layer 1)

- Repos persist in SQLite (`repos` table), legacy `repos.json` imported once.
- Sessions persist (`sessions` table) on spawn/bind/title/exit; killed sessions are deleted.
- Session ids are durable uuids.
- A fresh `SessionRegistry` over an existing db **lists prior panels as `exited`**, retaining `cwd`/`agentKind`/`title`/resume ref so they're re-resumable.
- `typecheck`, `biome check`, and the full `vitest` suite are green.

## Next (separate plans, written after Layer 1 lands)

- **Layer 2** — tmux-backed `AgentSession` in `@podium/agent-bridge`, daemon spawns under `tmux -L podium-<id>`, title preservation (`set-titles`), the input-fidelity config (`prefix None`, `escape-time 0`, `extended-keys on`), and graceful no-tmux fallback.
- **Layer 3** — `reattach`/`reattachFailed` protocol messages + `hibernated` status; boot loads `live` rows as `reconnecting`, the daemon `has-session`-checks and re-binds survivors (clients see live terminals after a restart); plus the **§10.1 input-fidelity acceptance gate** (node-pty-vs-tmux byte-parity test + manual Alt/Option dogfood).
