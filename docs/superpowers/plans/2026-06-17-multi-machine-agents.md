# Multi-machine Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Podium server orchestrate agents across several machines, each running its own daemon, with pairing-based auth, machine attribution everywhere in the DB/server/protocol, and a machine-aware new-agent UI.

**Architecture:** The daemon↔server WebSocket seam already exists. This turns the server's single daemon socket into a `Map<machineId, conn>` registry, tags every session/repo/conversation with a stable `machineId`, routes control messages to a session's owning daemon, and authenticates remote daemons with a pairing code (the bundled localhost daemon uses an in-process bootstrap token). The web gets a machine-aware dropdown, merge-by-repo workspace, and a Settings → Machines panel.

**Tech Stack:** TypeScript ESM, Bun workspace, Node 22 (`node:sqlite`, `node-pty`), zod, tRPC, Hono, `ws`, React + Base UI/shadcn + Tailwind v4, Vitest, Playwright.

## Global Constraints

- **Single-machine behavior must stay byte-for-byte unchanged** after every task. With one connected daemon the UI, DB rows, and wire traffic look exactly as today.
- **`machineId` (a UUID), never hostname, is the join key.** Hostname is display-only.
- **Spec of record:** `docs/superpowers/specs/2026-06-17-multi-machine-agents-design.md`.
- **Schema version bumps 3 → 4.** Migrations are additive `ALTER TABLE … ADD COLUMN` except the `repos` re-key, which rebuilds the table. Existing rows are stamped `machine_id = '__local__'` and rewritten on first bootstrap.
- **Auth frames (`hello`/`pair`) must be the first frame on a daemon socket;** the server ignores all other traffic until the socket is authenticated and bound to a `machineId`.
- **Token storage:** sha-256 hash in `machines.token_hash`; the daemon keeps the cleartext token in `~/.podium/daemon.json`. Compare with `crypto.timingSafeEqual`.
- **Tests:** Vitest (`bun run test` / `npx vitest run <file>`), Biome (`bun run lint`), typecheck (`bun run typecheck`). New pure logic is unit-tested first (TDD).
- **Pairing codes** are in-memory, single-use, TTL ~10 min. A code lost on server restart is acceptable.

---

## File Structure

**New files**
- `packages/core/src/git.ts` — `normalizeOriginUrl(raw)` (pure, the cross-machine repo match key).
- `apps/server/src/pairing.ts` — `PairingManager` (in-memory pairing codes).
- `apps/server/src/machines.ts` — `MachineId` helpers + `MachineRecord` type used by store & registry.
- `apps/daemon/src/identity.ts` — read/write `~/.podium/daemon.json`, generate the stable `machineId`.
- `apps/web/src/MachinesPanel.tsx` — Settings → Machines panel.
- Test files alongside each (`*.test.ts`).

**Modified files**
- `packages/protocol/src/messages.ts` — machine identity, pairing/hello frames, `SessionMeta` fields, `machinesChanged`, host-metrics `machineId`.
- `apps/server/src/store.ts` — `machines` table, v4 migration, machine CRUD, `machine_id` on sessions/conversations/repos.
- `apps/server/src/relay.ts` — daemon registry + routing + per-machine metrics/cooldown + machine list/rename/revoke + machinesChanged broadcast.
- `apps/server/src/session.ts` — `machineId` field, `toRow`/`toMeta`.
- `apps/server/src/wsServer.ts` — daemon handshake/auth, route by `machineId`.
- `apps/server/src/server.ts` — bootstrap token, wire pairing/machines into tRPC context.
- `apps/server/src/router.ts` — `machines` tRPC router; `create`/`resume` accept `machineId`.
- `apps/server/src/repo-registry.ts` — per-machine repo registration.
- `apps/daemon/src/daemon.ts` — identity + hello/pair handshake; machine-tagged scans.
- `packages/terminal-client/src/connection.ts` — `onMachines`/`machines`.
- `apps/web/src/store.tsx`, `derive.ts`, `types.ts`, `NewPanelMenu.tsx` — machines state, merge-by-repo, dropdown, badge.

---

# STAGE 1 — Identity, DB, protocol, routing (backend only)

Single connected daemon stays green throughout. No UI changes yet.

## Task 1: Origin-URL normalizer in `@podium/core`

The cross-machine repo match key: two clones of the same repo on different machines must normalize to the same string.

**Files:**
- Create: `packages/core/src/git.ts`
- Test: `packages/core/src/git.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './git'`)

**Interfaces:**
- Produces: `normalizeOriginUrl(raw: string | undefined): string` — returns `''` for empty/unknown.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/git.test.ts
import { describe, expect, it } from 'vitest'
import { normalizeOriginUrl } from './git'

describe('normalizeOriginUrl', () => {
  it('matches scp-style and https forms of the same repo', () => {
    const a = normalizeOriginUrl('git@github.com:me/proj.git')
    const b = normalizeOriginUrl('https://github.com/me/proj')
    expect(a).toBe('github.com/me/proj')
    expect(a).toBe(b)
  })
  it('lowercases host but not path, strips .git and trailing slash', () => {
    expect(normalizeOriginUrl('https://GitHub.com/Me/Proj.git/')).toBe('github.com/Me/Proj')
  })
  it('handles ssh:// and a port', () => {
    expect(normalizeOriginUrl('ssh://git@github.com:22/me/proj.git')).toBe('github.com/me/proj')
  })
  it('returns empty string for missing/garbage input', () => {
    expect(normalizeOriginUrl(undefined)).toBe('')
    expect(normalizeOriginUrl('')).toBe('')
    expect(normalizeOriginUrl('not a url')).toBe('not a url')
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run packages/core/src/git.test.ts`
Expected: FAIL ("normalizeOriginUrl is not a function").

- [ ] **Step 3: Implement**

```ts
// packages/core/src/git.ts
/**
 * Canonical identity for a git remote, so two clones of the same repo on different
 * machines compare equal. Host is lowercased (DNS is case-insensitive); the path is
 * left as-is (case-sensitive on most forges). `.git` suffix, trailing slash, scheme,
 * userinfo, and port are all stripped. Non-URL input is returned trimmed (so a
 * remote-less repo still only matches itself).
 */
export function normalizeOriginUrl(raw: string | undefined): string {
  if (!raw) return ''
  let s = raw.trim()
  if (!s) return ''
  // scp-style: git@host:path  ->  host/path
  const scp = s.match(/^[^/@]+@([^:/]+):(.+)$/)
  if (scp) {
    s = `${scp[1]}/${scp[2]}`
  } else {
    const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/i)
    if (m) s = m[1].replace(/^[^/@]+@/, '') // drop scheme + userinfo
    else return s.replace(/\.git$/, '').replace(/\/+$/, '') // not a recognizable URL
  }
  // s is now host[:port]/path
  s = s.replace(/\/+$/, '').replace(/\.git$/, '')
  const slash = s.indexOf('/')
  if (slash === -1) return s.toLowerCase()
  const host = s.slice(0, slash).replace(/:\d+$/, '').toLowerCase()
  const path = s.slice(slash + 1).replace(/\.git$/, '')
  return `${host}/${path}`
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run packages/core/src/git.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/git.ts packages/core/src/git.test.ts packages/core/src/index.ts
git commit -m "feat(core): normalizeOriginUrl for cross-machine repo identity"
```

## Task 2: Protocol — machine identity, pairing/hello frames, SessionMeta fields

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts` (create if absent)

**Interfaces (Produces):**
- `MachineWire = { id, name, hostname, online, lastSeenAt }`
- `MachinesChangedMessage` (server→client) — added to `ServerMessage`.
- `SessionMeta.machineId: string`, `SessionMeta.machineName: string`.
- `HostMetricsWire.machineId?: string`, `HostMetricsWire.name?: string` (server fills before broadcast; daemon still sends only hostname).
- Handshake frames + `DaemonHandshake` union + `parseDaemonHandshake(raw)` and `parseDaemonHandshakeReply(raw)`:
  - daemon→server: `{type:'pair', code, machineId, hostname, name?}`, `{type:'hello', machineId, token, hostname}`
  - server→daemon: `{type:'paired', token, machineId, name}`, `{type:'pairRejected', reason}`, `{type:'helloOk', name}`, `{type:'helloRejected', reason}`

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/src/messages.test.ts
import { describe, expect, it } from 'vitest'
import {
  MachineWire,
  parseDaemonHandshake,
  parseDaemonHandshakeReply,
  SessionMeta,
} from './messages'

describe('multi-machine protocol', () => {
  it('parses a hello handshake frame', () => {
    const m = parseDaemonHandshake(JSON.stringify({ type: 'hello', machineId: 'm1', token: 't', hostname: 'box' }))
    expect(m.type).toBe('hello')
  })
  it('parses a pair frame and the paired reply', () => {
    expect(parseDaemonHandshake(JSON.stringify({ type: 'pair', code: 'AAAA-BBBB', machineId: 'm1', hostname: 'box' })).type).toBe('pair')
    expect(parseDaemonHandshakeReply(JSON.stringify({ type: 'paired', token: 't', machineId: 'm1', name: 'box' })).type).toBe('paired')
  })
  it('SessionMeta requires machineId + machineName', () => {
    expect(() => SessionMeta.parse({ machineId: 'm1' })).toThrow() // incomplete is fine to throw
    expect(MachineWire.parse({ id: 'm1', name: 'box', hostname: 'box', online: true, lastSeenAt: 'x' }).id).toBe('m1')
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run packages/protocol/src/messages.test.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement** — add to `messages.ts`:

After `SessionOrigin` / near `SessionMeta`, add the two fields to the `SessionMeta` object:
```ts
  // The machine (daemon) this session runs on. machineId is the stable join key;
  // machineName is the display label (server-resolved from the machines table).
  machineId: z.string(),
  machineName: z.string(),
```

Add machine identity + handshake schemas (place near `HostMetricsWire`):
```ts
export const MachineWire = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string(), // ISO 8601
})
export type MachineWire = z.infer<typeof MachineWire>

export const MachinesChangedMessage = z.object({
  type: z.literal('machinesChanged'),
  machines: z.array(MachineWire),
})

// ---- daemon handshake (pre-auth; NOT part of the Control/Daemon unions) ----
export const PairFrame = z.object({
  type: z.literal('pair'),
  code: z.string(),
  machineId: z.string(),
  hostname: z.string(),
  name: z.string().optional(),
})
export const HelloFrame = z.object({
  type: z.literal('hello'),
  machineId: z.string(),
  token: z.string(),
  hostname: z.string(),
})
export const DaemonHandshake = z.discriminatedUnion('type', [PairFrame, HelloFrame])
export type DaemonHandshake = z.infer<typeof DaemonHandshake>

export const PairedReply = z.object({
  type: z.literal('paired'),
  token: z.string(),
  machineId: z.string(),
  name: z.string(),
})
export const PairRejectedReply = z.object({ type: z.literal('pairRejected'), reason: z.string() })
export const HelloOkReply = z.object({ type: z.literal('helloOk'), name: z.string() })
export const HelloRejectedReply = z.object({ type: z.literal('helloRejected'), reason: z.string() })
export const DaemonHandshakeReply = z.discriminatedUnion('type', [
  PairedReply,
  PairRejectedReply,
  HelloOkReply,
  HelloRejectedReply,
])
export type DaemonHandshakeReply = z.infer<typeof DaemonHandshakeReply>

export function parseDaemonHandshake(raw: string): DaemonHandshake {
  return DaemonHandshake.parse(JSON.parse(raw))
}
export function parseDaemonHandshakeReply(raw: string): DaemonHandshakeReply {
  return DaemonHandshakeReply.parse(JSON.parse(raw))
}
```

Add `machineId`/`name` (optional) to `HostMetricsWire`:
```ts
export const HostMetricsWire = z.object({
  hostname: z.string(),
  machineId: z.string().optional(), // server-filled before broadcast
  name: z.string().optional(),      // server-filled before broadcast
  sampledAt: z.string(),
  memory: HostMemoryWire,
})
```

Add `MachinesChangedMessage` to the `ServerMessage` union list.

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run packages/protocol/src/messages.test.ts && bun run typecheck`
Expected: PASS. Typecheck will now flag every `toMeta()` / SessionMeta literal lacking `machineId`/`machineName` — those are fixed in Task 5/Task 3; for now this task only adds schemas. If typecheck blocks the commit, proceed to Task 3 then return; otherwise commit now.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): machine identity, pairing/hello frames, SessionMeta.machineId"
```

## Task 3: Store — machines table, v4 migration, machine attribution

**Files:**
- Modify: `apps/server/src/store.ts`
- Test: `apps/server/src/store.machines.test.ts` (new)

**Interfaces (Produces):**
- `MachineRecord = { id, name, hostname, createdAt, lastSeenAt }` (token hash stays internal).
- `upsertMachine(m: { id; name; hostname; tokenHash })`, `getMachine(id)`, `getMachineByToken(id, token)` → boolean, `listMachines(): MachineRecord[]`, `renameMachine(id, name)`, `deleteMachine(id)`, `touchMachine(id, hostname)`.
- `adoptLocalRows(machineId)` — rewrite `'__local__'` → `machineId` across sessions/repos/conversations (one-time, idempotent).
- `SessionRow.machineId: string` added; `loadSessions`/`upsertSession` carry it.
- `repos` re-keyed `(machine_id, path)` with `origin_url`; `listRepos`/`addRepo`/`removeRepo` gain a `machineId` param (default `'__local__'` for back-compat call sites until Task 9).
- `upsertConversations` rows gain optional `machineId`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/store.machines.test.ts
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { SessionStore } from './store'

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

describe('machines store', () => {
  it('upserts, lists, renames, deletes a machine', () => {
    const s = new SessionStore(':memory:')
    s.upsertMachine({ id: 'm1', name: 'box', hostname: 'box', tokenHash: hash('secret') })
    expect(s.listMachines().map((m) => m.id)).toEqual(['m1'])
    expect(s.getMachineByToken('m1', 'secret')).toBe(true)
    expect(s.getMachineByToken('m1', 'wrong')).toBe(false)
    s.renameMachine('m1', 'laptop')
    expect(s.listMachines()[0].name).toBe('laptop')
    s.deleteMachine('m1')
    expect(s.listMachines()).toEqual([])
  })

  it('adoptLocalRows rewrites __local__ session machine ids', () => {
    const s = new SessionStore(':memory:')
    s.upsertSession({
      id: 'sess', agentKind: 'shell', cwd: '/x', title: 't', name: null, originKind: 'spawn',
      conversationId: null, resumeKind: null, resumeValue: null, status: 'live', exitCode: null,
      durableLabel: 'podium-sess', createdAt: 'a', lastActiveAt: 'a', archived: false,
      workState: null, machineId: '__local__',
    })
    s.adoptLocalRows('m1')
    expect(s.loadSessions()[0].machineId).toBe('m1')
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run apps/server/src/store.machines.test.ts`
Expected: FAIL (methods + `machineId` field missing).

- [ ] **Step 3: Implement**

In `migrate()`, after the existing table creates and before the `schema_version` write:
```ts
    // v4: machines registry + machine attribution.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS machines (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         hostname TEXT NOT NULL,
         token_hash TEXT NOT NULL,
         created_at TEXT NOT NULL,
         last_seen_at TEXT NOT NULL
       )`,
    )
    if (!colNames.has('machine_id'))
      this.db.exec("ALTER TABLE sessions ADD COLUMN machine_id TEXT NOT NULL DEFAULT '__local__'")
    const convCols = new Set(
      (this.db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map((c) => c.name),
    )
    if (!convCols.has('machine_id'))
      this.db.exec("ALTER TABLE conversations ADD COLUMN machine_id TEXT NOT NULL DEFAULT '__local__'")
    // repos re-key (path) -> (machine_id, path) + origin_url. Rebuild (PK change).
    const repoCols = new Set(
      (this.db.prepare('PRAGMA table_info(repos)').all() as { name: string }[]).map((c) => c.name),
    )
    if (!repoCols.has('machine_id')) {
      this.db.exec(
        `CREATE TABLE repos_v4 (
           machine_id TEXT NOT NULL DEFAULT '__local__',
           path TEXT NOT NULL,
           origin_url TEXT,
           repo_name TEXT,
           added_at TEXT NOT NULL,
           PRIMARY KEY (machine_id, path)
         )`,
      )
      this.db.exec(
        "INSERT INTO repos_v4 (machine_id, path, added_at) SELECT '__local__', path, added_at FROM repos",
      )
      this.db.exec('DROP TABLE repos')
      this.db.exec('ALTER TABLE repos_v4 RENAME TO repos')
    }
```
Change the `schema_version` guard from `< 3 ... '3'` to `< 4 ... '4'`.

Add the SessionRow field — in the `SessionRow` interface add `machineId: string`. In `loadSessions` SELECT add `machine_id` and map `machineId: (r.machine_id as string) ?? '__local__'`. In `upsertSession` add `machine_id` to the INSERT columns/values and to the `ON CONFLICT … DO UPDATE` set (`machine_id = excluded.machine_id`), binding `row.machineId`.

Add the repos signature change:
```ts
  listRepos(machineId?: string): { machineId: string; path: string; originUrl: string | null }[] {
    const rows = (machineId
      ? this.db.prepare('SELECT machine_id, path, origin_url FROM repos WHERE machine_id = ? ORDER BY rowid ASC').all(machineId)
      : this.db.prepare('SELECT machine_id, path, origin_url FROM repos ORDER BY rowid ASC').all()) as Record<string, unknown>[]
    return rows.map((r) => ({ machineId: r.machine_id as string, path: r.path as string, originUrl: (r.origin_url as string | null) ?? null }))
  }
  addRepo(path: string, machineId = '__local__', originUrl?: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO repos (machine_id, path, origin_url, repo_name, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(machineId, path, originUrl ?? null, path.split('/').pop() ?? null, new Date().toISOString())
  }
  removeRepo(path: string, machineId = '__local__'): void {
    this.db.prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?').run(machineId, path)
  }
```
> NOTE: `RepoRegistry.list()` (caller) expects `string[]` today. Keep a back-compat read used by callers until Task 9 — add `listRepoPaths(): string[]` returning `this.listRepos().map(r => r.path)` and point existing callers (`relay`/`router` `ctx.repos.list()`) at the registry, which Task 9 reworks. For THIS task, also update `importReposJson` `INSERT` to the new 5-column form.

Add machine methods (anywhere in the class):
```ts
  upsertMachine(m: { id: string; name: string; hostname: string; tokenHash: string }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, hostname = excluded.hostname,
           token_hash = excluded.token_hash, last_seen_at = excluded.last_seen_at`,
      )
      .run(m.id, m.name, m.hostname, m.tokenHash, now, now)
  }
  listMachines(): { id: string; name: string; hostname: string; createdAt: string; lastSeenAt: string }[] {
    return (this.db.prepare('SELECT id, name, hostname, created_at, last_seen_at FROM machines ORDER BY created_at ASC').all() as Record<string, unknown>[])
      .map((r) => ({ id: r.id as string, name: r.name as string, hostname: r.hostname as string, createdAt: r.created_at as string, lastSeenAt: r.last_seen_at as string }))
  }
  getMachineByToken(id: string, token: string): boolean {
    const row = this.db.prepare('SELECT token_hash FROM machines WHERE id = ?').get(id) as { token_hash: string } | undefined
    if (!row) return false
    const a = Buffer.from(createHash('sha256').update(token).digest('hex'))
    const b = Buffer.from(row.token_hash)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  renameMachine(id: string, name: string): void {
    this.db.prepare('UPDATE machines SET name = ? WHERE id = ?').run(name, id)
  }
  deleteMachine(id: string): void {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id)
  }
  touchMachine(id: string, hostname: string): void {
    this.db.prepare('UPDATE machines SET last_seen_at = ?, hostname = ? WHERE id = ?').run(new Date().toISOString(), hostname, id)
  }
  adoptLocalRows(machineId: string): void {
    for (const t of ['sessions', 'repos', 'conversations'])
      this.db.prepare(`UPDATE ${t} SET machine_id = ? WHERE machine_id = '__local__'`).run(machineId)
  }
```
Add `import { createHash, timingSafeEqual } from 'node:crypto'` at the top. Also extend `upsertConversations` to accept/persist `machineId` (add `machine_id` to the INSERT with `ON CONFLICT … DO UPDATE SET machine_id = excluded.machine_id`); rows that omit it default `'__local__'`.

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run apps/server/src/store.machines.test.ts && npx vitest run apps/server/src/store.test.ts`
Expected: PASS (new + existing store tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.machines.test.ts
git commit -m "feat(server): machines table, v4 migration, machine attribution in store"
```

## Task 4: PairingManager (in-memory pairing codes)

**Files:**
- Create: `apps/server/src/pairing.ts`
- Test: `apps/server/src/pairing.test.ts`

**Interfaces (Produces):**
- `class PairingManager { mint(nowMs?): string; redeem(code, nowMs?): boolean }` — code format `XXXX-XXXX` (Crockford-ish, no ambiguous chars), single-use, TTL 10 min.
- Constructor takes `randomCode: () => string` (injected for deterministic tests) and `ttlMs = 600_000`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/pairing.test.ts
import { describe, expect, it } from 'vitest'
import { PairingManager } from './pairing'

describe('PairingManager', () => {
  it('redeems a freshly minted code exactly once', () => {
    let n = 0
    const p = new PairingManager({ randomCode: () => `CODE-000${n++}`, ttlMs: 1000 })
    const code = p.mint(0)
    expect(p.redeem(code, 100)).toBe(true)
    expect(p.redeem(code, 100)).toBe(false) // single-use
  })
  it('rejects an expired code', () => {
    const p = new PairingManager({ randomCode: () => 'CODE-0001', ttlMs: 1000 })
    const code = p.mint(0)
    expect(p.redeem(code, 2000)).toBe(false)
  })
  it('rejects an unknown code', () => {
    const p = new PairingManager({ randomCode: () => 'CODE-0001', ttlMs: 1000 })
    expect(p.redeem('NOPE-NOPE', 0)).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify it fails** — `npx vitest run apps/server/src/pairing.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/pairing.ts
import { randomBytes } from 'node:crypto'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/O/0/1
function defaultCode(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length]
    if (i === 3) out += '-'
  }
  return out
}

/** Short-lived, single-use pairing codes, held in memory. Lost on restart by design. */
export class PairingManager {
  private readonly codes = new Map<string, number>() // code -> expiresAtMs
  private readonly randomCode: () => string
  private readonly ttlMs: number
  constructor(opts: { randomCode?: () => string; ttlMs?: number } = {}) {
    this.randomCode = opts.randomCode ?? defaultCode
    this.ttlMs = opts.ttlMs ?? 600_000
  }
  mint(nowMs = Date.now()): string {
    const code = this.randomCode()
    this.codes.set(code, nowMs + this.ttlMs)
    return code
  }
  redeem(code: string, nowMs = Date.now()): boolean {
    const exp = this.codes.get(code)
    if (exp === undefined) return false
    this.codes.delete(code) // single-use regardless of outcome
    return nowMs <= exp
  }
}
```

- [ ] **Step 4: Run, verify it passes** — `npx vitest run apps/server/src/pairing.test.ts` → PASS (3).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pairing.ts apps/server/src/pairing.test.ts
git commit -m "feat(server): in-memory pairing code manager"
```

## Task 5: Registry — daemon registry + per-machine routing

The heart. Replace the single `daemonSend` with a `Map<machineId, send>`, route per machine, add machine list/rename/revoke, broadcast `machinesChanged`, scope metrics + cooldown per machine, and stamp sessions with `machineId`.

**Files:**
- Modify: `apps/server/src/relay.ts`, `apps/server/src/session.ts`
- Test: `apps/server/src/relay.machines.test.ts` (new)

**Interfaces:**
- Consumes: store machine methods (Task 3), `PairingManager` (Task 4), `MachineWire`/`MachinesChangedMessage` (Task 2).
- Produces (used by wsServer Task 6 / router Task 10):
  - `attachDaemon(machineId: string, send: Send<ControlMessage>): void`
  - `detachDaemon(machineId: string): void`
  - `authenticateDaemon(frame: DaemonHandshake): { ok: true; machineId: string; name: string } | { ok: false; reason: string }`
  - `mintPairingCode(): string`
  - `listMachines(): MachineWire[]`, `renameMachine(id, name)`, `revokeMachine(id)`
  - `createSession`/`resumeSession` accept optional `machineId`; `spawn` resolves a target machine.
  - `pickMachineForRepo(originUrl, cwd): string` (used by spawn default + validation).

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/relay.machines.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { ControlMessage } from '@podium/protocol'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

function regWithTwoDaemons() {
  const store = new SessionStore(':memory:')
  store.upsertMachine({ id: 'm1', name: 'one', hostname: 'one', tokenHash: 'x' })
  store.upsertMachine({ id: 'm2', name: 'two', hostname: 'two', tokenHash: 'y' })
  const reg = new SessionRegistry(store)
  const m1: ControlMessage[] = []
  const m2: ControlMessage[] = []
  reg.attachDaemon('m1', (msg) => m1.push(msg))
  reg.attachDaemon('m2', (msg) => m2.push(msg))
  return { reg, m1, m2 }
}

describe('multi-daemon routing', () => {
  it('routes a spawn to the chosen machine only', () => {
    const { reg, m1, m2 } = regWithTwoDaemons()
    reg.createSession({ agentKind: 'shell', cwd: '/x', machineId: 'm2' })
    expect(m1.filter((m) => m.type === 'spawn')).toHaveLength(0)
    expect(m2.filter((m) => m.type === 'spawn')).toHaveLength(1)
  })
  it('a session carries its machineId in meta', () => {
    const { reg } = regWithTwoDaemons()
    const { sessionId } = reg.createSession({ agentKind: 'shell', cwd: '/x', machineId: 'm2' })
    const meta = reg.listSessions().find((s) => s.sessionId === sessionId)!
    expect(meta.machineId).toBe('m2')
    expect(meta.machineName).toBe('two')
  })
  it('detaching m1 only marks m1 sessions reconnecting', () => {
    const { reg } = regWithTwoDaemons()
    const a = reg.createSession({ agentKind: 'shell', cwd: '/a', machineId: 'm1' }).sessionId
    const b = reg.createSession({ agentKind: 'shell', cwd: '/b', machineId: 'm2' }).sessionId
    // mark both live as a bind would
    reg.onDaemonMessageFrom('m1', { type: 'bind', sessionId: a, cmd: 'x', cwd: '/a', agentKind: 'shell', geometry: { cols: 80, rows: 24 } })
    reg.onDaemonMessageFrom('m2', { type: 'bind', sessionId: b, cmd: 'x', cwd: '/b', agentKind: 'shell', geometry: { cols: 80, rows: 24 } })
    reg.detachDaemon('m1')
    const meta = (id: string) => reg.listSessions().find((s) => s.sessionId === id)!
    expect(meta(a).status).toBe('reconnecting')
    expect(meta(b).status).toBe('live')
  })
})
```

- [ ] **Step 2: Run, verify it fails** — `npx vitest run apps/server/src/relay.machines.test.ts` → FAIL.

- [ ] **Step 3: Implement** (key edits in `relay.ts`):

Replace the daemon-socket state:
```ts
  // machineId -> control-message sender for that daemon. Replaces the single socket.
  private readonly daemons = new Map<string, Send<ControlMessage>>()
  // Per-machine queue for control messages produced while that daemon is briefly
  // offline (e.g. the local daemon during boot). Flushed in order on attach.
  private readonly pendingByMachine = new Map<string, ControlMessage[]>()
```
Add a `PairingManager` field (constructed in the registry or injected). Add a `localMachineId` notion: the first machine to authenticate via the bootstrap token (Task 6 supplies it) calls `adoptLocalRows`.

`toDaemon` becomes machine-addressed:
```ts
  private readonly toMachine = (machineId: string, msg: ControlMessage): void => {
    const send = this.daemons.get(machineId)
    if (send) send(msg)
    else (this.pendingByMachine.get(machineId) ?? this.pendingByMachine.set(machineId, []).get(machineId)!)?.push(msg)
  }
```
`attachDaemon(machineId, send)`: store in `daemons`, flush `pendingByMachine[machineId]`, then re-bind survivor sessions **whose `session.machineId === machineId`** (the existing reattach loop, filtered), and broadcast `machinesChanged`.
`detachDaemon(machineId)`: delete from `daemons`; drop that machine's host metrics (`latestHostMetrics.delete(machineId)`); mark that machine's `live`/`starting` sessions `reconnecting`; `broadcastSessions()`; `broadcastHostMetrics()`; `broadcastMachines()`.

`Session` gains `machineId` (session.ts): add `machineId: string` to `SessionInit`, store it (`this.machineId = init.machineId ?? '__local__'`), include in `toRow()` and `toMeta()` (`machineId: this.machineId`, plus `machineName` which the registry injects — see below). Change the injected `toDaemon` so each session routes to its machine: in `relay.ts` where Sessions are constructed (`spawn` + `loadFromStore`), pass `toDaemon: (msg) => this.toMachine(session.machineId, msg)` — but `session` isn't defined yet at construction, so bind by captured machineId: compute `const machineId = …` first, then `toDaemon: (msg) => this.toMachine(machineId, msg)`.

`listSessions()` injects the live machine name:
```ts
  listSessions(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => ({ ...s.toMeta(), machineName: this.machineName(s.machineId) }))
  }
  private machineName(id: string): string {
    return this.store.listMachines().find((m) => m.id === id)?.name ?? id
  }
```
(`Session.toMeta()` sets `machineName: ''`; the registry overwrites it. Keep `machineId` from the Session.)

`createSession`/`resumeSession`/`spawn` accept `machineId?`:
```ts
  createSession(input: { agentKind?: AgentKind; cwd: string; title?: string; machineId?: string }) { … spawn({ …, machineId: this.resolveMachine(input.machineId, input.cwd) }) }
```
`resolveMachine(requested, cwd)`: if `requested` and it is online → use it; else `pickMachineForRepo`/the single online machine/the local machine. For single-daemon this always returns the one connected machine, so behavior is unchanged. `spawn` stores `machineId` on the Session and routes the spawn via `toMachine(machineId, …)`.

Per-machine host metrics + cooldown: re-key `latestHostMetrics` by `machineId` (the `hostMetrics` handler now receives a `machineId` from `onDaemonMessageFrom`); `lastAutoHibernateMs` becomes `Map<machineId, number>`; `maybeAutoHibernate` scopes candidates to `s.machineId === sample.machineId`. `hostMetricsMessage()` fills each entry's `machineId`+`name`.

Route inbound daemon messages by machine: rename `onDaemonMessage(msg)` → `onDaemonMessageFrom(machineId: string, msg: DaemonMessage)`. The only handlers that need `machineId`: `hostMetrics` (store/scope by machineId), `conversationsChanged`/`scanResult` (tag indexed conversations with machineId), `scanReposResult` (tag repos with machineId — Task 9). All session-keyed handlers (`bind`, `agentFrame`, `agentExit`, …) are unchanged (they look up by `sessionId`).

Add machine admin + pairing:
```ts
  mintPairingCode(): string { return this.pairing.mint() }
  authenticateDaemon(frame: DaemonHandshake): { ok: true; machineId: string; name: string } | { ok: false; reason: string } {
    if (frame.type === 'pair') {
      if (!this.pairing.redeem(frame.code)) return { ok: false, reason: 'invalid or expired code' }
      const name = frame.name ?? frame.hostname
      const token = randomUUID()
      this.store.upsertMachine({ id: frame.machineId, name, hostname: frame.hostname, tokenHash: sha256(token) })
      return { ok: true, machineId: frame.machineId, name } // wsServer sends { paired, token }
    }
    if (this.store.getMachineByToken(frame.machineId, frame.token)) {
      this.store.touchMachine(frame.machineId, frame.hostname)
      const name = this.store.listMachines().find((m) => m.id === frame.machineId)?.name ?? frame.hostname
      return { ok: true, machineId: frame.machineId, name }
    }
    return { ok: false, reason: 'unknown machine — re-pair' }
  }
  listMachines(): MachineWire[] {
    return this.store.listMachines().map((m) => ({ id: m.id, name: m.name, hostname: m.hostname, online: this.daemons.has(m.id), lastSeenAt: m.lastSeenAt }))
  }
  renameMachine(id: string, name: string): void { this.store.renameMachine(id, name); this.broadcastSessions(); this.broadcastMachines() }
  revokeMachine(id: string): void { this.store.deleteMachine(id); this.daemons.delete(id); this.broadcastMachines() }
  private broadcastMachines(): void { const msg: ServerMessage = { type: 'machinesChanged', machines: this.listMachines() }; for (const c of this.clients.values()) c.send(msg) }
```
`attachClient` also sends a `machinesChanged` snapshot. Add `sha256` helper + `import { createHash } from 'node:crypto'`. The bootstrap-token path (Task 6) authenticates and then calls `registry.adoptLocal(machineId)` once → `this.store.adoptLocalRows(machineId)` + reload affected sessions' `machineId` from store (or set the local machine id on in-memory sessions whose machineId is `'__local__'`).

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run apps/server/src/relay.machines.test.ts && npx vitest run apps/server/src/relay.test.ts`
Expected: PASS. Fix existing relay tests that called `attachDaemon(send)`/`detachDaemon()`/`onDaemonMessage(msg)` to the new machine-addressed signatures (pass a stub machineId, e.g. `'local'`, registering it via `store.upsertMachine` first).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/session.ts apps/server/src/relay.machines.test.ts apps/server/src/relay.test.ts
git commit -m "feat(server): per-machine daemon registry + routing + machine admin"
```

## Task 6: wsServer — daemon handshake/auth + route by machineId

**Files:**
- Modify: `apps/server/src/wsServer.ts`
- Test: `apps/server/src/wsServer.daemon.test.ts` (new — drive a fake `ws` through the upgrade handler, or factor the per-socket logic into a tested `wireDaemonSocket(ws, registry, bootstrapToken)`).

**Interfaces:**
- Consumes: `parseDaemonHandshake`, `encode` (protocol); `registry.authenticateDaemon`, `attachDaemon`, `detachDaemon`, `onDaemonMessageFrom`, `adoptLocal` (Task 5).
- `attachWebSockets(server, registry, opts: { bootstrapToken: string })`.

- [ ] **Step 1: Write the failing test** — assert: a socket whose first frame is a valid `hello` (token in store) gets attached and its subsequent `bind` routes via `onDaemonMessageFrom`; a socket whose first frame is garbage/`input` is NOT attached.

```ts
// apps/server/src/wsServer.daemon.test.ts
import { describe, expect, it, vi } from 'vitest'
import { wireDaemonSocket } from './wsServer'
import { SessionStore } from './store'
import { SessionRegistry } from './relay'
import { createHash } from 'node:crypto'

function fakeWs() {
  const sent: string[] = []
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  return {
    sent, readyState: 1,
    send: (s: string) => sent.push(s),
    on: (ev: string, cb: (...a: unknown[]) => void) => { handlers[ev] = cb },
    emit: (ev: string, ...a: unknown[]) => handlers[ev]?.(...a),
  }
}

describe('daemon socket auth', () => {
  it('attaches only after a valid hello', () => {
    const store = new SessionStore(':memory:')
    store.upsertMachine({ id: 'm1', name: 'box', hostname: 'box', tokenHash: createHash('sha256').update('tok').digest('hex') })
    const reg = new SessionRegistry(store)
    const attach = vi.spyOn(reg, 'attachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg, 'BOOT')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', sessionId: 's', data: '' }))) // pre-auth junk ignored
    expect(attach).not.toHaveBeenCalled()
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'box' })))
    expect(attach).toHaveBeenCalledWith('m1', expect.any(Function))
    expect(ws.sent.some((s) => s.includes('helloOk'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run, verify it fails** — `npx vitest run apps/server/src/wsServer.daemon.test.ts` → FAIL.

- [ ] **Step 3: Implement** — extract and rewrite the daemon connection handler:

```ts
export function wireDaemonSocket(ws: import('ws').WebSocket, registry: SessionRegistry, bootstrapToken: string): void {
  let machineId: string | undefined
  ws.on('message', (raw: import('ws').RawData) => {
    if (machineId === undefined) {
      let frame
      try { frame = parseDaemonHandshake(raw.toString()) } catch { return } // first frame must be a handshake
      // Bootstrap path: the in-process localhost daemon presents the bootstrap token as its `hello` token.
      if (frame.type === 'hello' && frame.token === bootstrapToken) {
        machineId = frame.machineId
        registry.adoptLocal(machineId, frame.hostname, frame.name ?? frame.hostname)
        registry.attachDaemon(machineId, (msg) => ws.send(encode(msg)))
        ws.send(encode({ type: 'helloOk', name: registry.machineName(machineId) }))
        return
      }
      const auth = registry.authenticateDaemon(frame)
      if (!auth.ok) {
        ws.send(encode({ type: frame.type === 'pair' ? 'pairRejected' : 'helloRejected', reason: auth.reason }))
        return
      }
      machineId = auth.machineId
      if (frame.type === 'pair') ws.send(encode({ type: 'paired', token: auth.token, machineId, name: auth.name }))
      registry.attachDaemon(machineId, (msg) => ws.send(encode(msg)))
      ws.send(encode({ type: 'helloOk', name: auth.name }))
      return
    }
    try { registry.onDaemonMessageFrom(machineId, parseDaemonMessage(raw.toString())) } catch { /* ignore malformed */ }
  })
  ws.on('close', () => { if (machineId) registry.detachDaemon(machineId) })
}
```
> `authenticateDaemon` for the `pair` branch must also return the freshly minted `token` (extend its success shape to `{ ok: true; machineId; name; token? }`). Add `adoptLocal(machineId, hostname, name)` to the registry: `upsertMachine` with a bootstrap token-hash, `adoptLocalRows`, set in-memory sessions' `machineId` from `'__local__'` to the local id, expose `machineName`.

Update `attachWebSockets` signature to take `{ bootstrapToken }` and call `daemonWss.on('connection', (ws) => wireDaemonSocket(ws, registry, bootstrapToken))`.

- [ ] **Step 4: Run, verify it passes** — `npx vitest run apps/server/src/wsServer.daemon.test.ts apps/server/src/wsServer.test.ts` → PASS (fix the existing wsServer test's `attachWebSockets` call to pass `{ bootstrapToken: 'test' }`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/wsServer.ts apps/server/src/wsServer.daemon.test.ts apps/server/src/wsServer.test.ts
git commit -m "feat(server): authenticate daemon sockets, route by machineId"
```

## Task 7: server.ts — bootstrap token + wire pairing/machines into context

**Files:**
- Modify: `apps/server/src/server.ts`, `apps/server/src/router.ts` (context only; the machines router is Task 10)

- [ ] **Step 1: Write the failing test** — extend an existing server smoke test (or add `server.bootstrap.test.ts`) asserting `startServer()` resolves a handle exposing `bootstrapToken: string`, and that the returned `registry.listMachines()` is callable.

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement** — in `startServer`:
```ts
  const bootstrapToken = randomUUID() // import { randomUUID } from 'node:crypto'
  …
  const ws = attachWebSockets(server as unknown as Server, registry, { bootstrapToken })
  resolve({ port: info.port, registry, bootstrapToken, close: … })
```
Add `bootstrapToken: string` to `ServerHandle`. The registry already owns the `PairingManager`. `scripts/host.ts` change is in Task 8.

- [ ] **Step 4: Run, verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat(server): expose bootstrap token for the in-process daemon"`.

## Task 8: Daemon — identity file + hello/pair handshake

**Files:**
- Create: `apps/daemon/src/identity.ts` + `identity.test.ts`
- Modify: `apps/daemon/src/daemon.ts`, `scripts/host.ts`

**Interfaces (Produces):**
- `loadIdentity(opts?: { dir?: string }): { machineId: string; token?: string }` — reads `~/.podium/daemon.json`, generating + persisting a `machineId` on first call.
- `saveToken(token: string, opts?)`, `setServerUrl?` (optional).
- `DaemonOptions` gains `bootstrapToken?: string`, `pairCode?: string`, `name?: string`.

- [ ] **Step 1: Write the failing test** — `identity.test.ts`: first `loadIdentity({ dir })` creates a file with a uuid `machineId`; a second call returns the same id; `saveToken` then `loadIdentity` returns the token.

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement**

```ts
// apps/daemon/src/identity.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dirFor(dir?: string): string {
  return dir ?? process.env.PODIUM_STATE_DIR ?? join(homedir(), '.podium')
}
export function loadIdentity(opts: { dir?: string } = {}): { machineId: string; token?: string } {
  const base = dirFor(opts.dir)
  const path = join(base, 'daemon.json')
  let data: { machineId?: string; token?: string } = {}
  try { data = JSON.parse(readFileSync(path, 'utf8')) } catch { /* first run */ }
  if (!data.machineId) {
    data.machineId = randomUUID()
    mkdirSync(base, { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 2))
  }
  return { machineId: data.machineId, ...(data.token ? { token: data.token } : {}) }
}
export function saveToken(token: string, opts: { dir?: string } = {}): void {
  const base = dirFor(opts.dir)
  const path = join(base, 'daemon.json')
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(readFileSync(path, 'utf8')) } catch {}
  data.token = token
  mkdirSync(base, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}
```

In `daemon.ts`, replace the bare `ws.once('open', …)` startup with an authenticated handshake. On open, send the first frame; defer discovery/metrics until `helloOk`/`paired`:
```ts
  const identity = loadIdentity()
  ws.once('open', () => {
    const hostname0 = hostname()
    if (opts.bootstrapToken) {
      ws.send(encode({ type: 'hello', machineId: identity.machineId, token: opts.bootstrapToken, hostname: hostname0 }))
    } else if (identity.token) {
      ws.send(encode({ type: 'hello', machineId: identity.machineId, token: identity.token, hostname: hostname0 }))
    } else if (opts.pairCode) {
      ws.send(encode({ type: 'pair', code: opts.pairCode, machineId: identity.machineId, hostname: hostname0, ...(opts.name ? { name: opts.name } : {}) }))
    } else { reject(new Error('daemon has no token and no --pair code; pair it first')); return }
  })
```
Add a handshake-reply handler in front of the existing `ws.on('message')` control loop: intercept the FIRST message; if it parses as a `DaemonHandshakeReply`:
- `helloOk`/`paired` → (persist token on `paired`), then run the existing `ws.once('open')` body that starts discovery/metrics (move that startup into a `startBackground()` fn called here, not on open), and `resolve(handle)`.
- `helloRejected`/`pairRejected` → `disposeAll(); reject(new Error(reason))`.
Subsequent messages flow to the control-message switch as today. (Encode the handshake reply detection by trying `parseDaemonHandshakeReply` first; on failure fall through to `parseControlMessage`.)

`scripts/host.ts`:
```ts
const server = await startServer({ port: … })
const daemon = await startDaemon({ serverUrl: `ws://localhost:${server.port}`, bootstrapToken: server.bootstrapToken })
```

- [ ] **Step 4: Run, verify it passes** — `npx vitest run apps/daemon/src/identity.test.ts`; run any daemon integration test to confirm the local handshake still connects. (`npx vitest run apps/daemon`)

- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): stable machineId + hello/pair handshake; host.ts uses bootstrap token"`.

## Task 9: Per-machine repo registration + machine-tagged repo scans

Repos belong to a machine. `repos.add`/`list` take a `machineId`; `refreshRepos` fans out to every online daemon and tags results.

**Files:**
- Modify: `apps/server/src/repo-registry.ts`, `apps/server/src/relay.ts` (scanRepos fan-out + tag), `apps/server/src/router.ts` (repos.add/remove take machineId; discovery.refreshRepos fans out), `packages/protocol/src/messages.ts` (`GitRepositoryWire.machineId?`)
- Test: `apps/server/src/repo-registry.machines.test.ts`

**Interfaces:**
- `RepoRegistry.list(machineId?)`, `add(path, machineId)`, `remove(path, machineId)`.
- `registry.scanReposAll()` → scans each online machine's registered roots, returns `GitRepositoryWire[]` each carrying its `machineId`.
- `GitRepositoryWire.machineId?: string` (server-stamped per responding daemon; daemon never sets it).

- [ ] **Step 1: Write the failing test** — register repo `/a` on `m1` and `/b` on `m2`; assert `list('m1')` ⊂ `/a`, and a scan stamps each repo with its machineId. (Use a fake two-daemon registry as in Task 5; have each fake daemon reply to `scanReposRequest` with one repo.)

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement** — `RepoRegistry` threads `machineId` through to the store methods from Task 3. `scanReposAll()` issues one `scanReposRequest` per online machine (via `toMachine`) and stamps each returned repo with that machine's id before merging; on the single-machine path it equals today's `scanRepos`. `GitRepositoryWire` gains optional `machineId`. `router.ts`: `repos.add`/`remove` inputs gain `machineId: z.string().optional()` (default the sole online machine); `discovery.refreshRepos` calls `scanReposAll()`. `hosts.memoryBreakdown` roots derivation stays per the responding machine.

> Single-machine invariant: with one online daemon, `scanReposAll()` returns the same repos as `scanRepos(list())` did, each stamped with the one machine's id — the web ignores `machineId` until Stage 3, so the workspace is unchanged.

- [ ] **Step 4: Run, verify it passes** — `npx vitest run apps/server/src/repo-registry.machines.test.ts && bun run test`.

- [ ] **Step 5: Commit** — `git commit -m "feat(server): per-machine repo registration + machine-tagged repo scans"`.

**Stage 1 gate:** `bun run lint && bun run typecheck && bun run test` all green. Manually (or via the existing daemon integration test) confirm the bundled `scripts/host.ts` still spawns/drives a session end-to-end with one daemon. The DB now has a `machines` row for the local box and all legacy rows are adopted to it.

---

# STAGE 2 — tRPC machines API + Settings → Machines panel

## Task 10: tRPC `machines` router

**Files:** Modify `apps/server/src/router.ts` (+ `Context` already has `registry`).
- Add router:
```ts
  machines: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.listMachines()),
    rename: t.procedure.input(z.object({ id: z.string(), name: z.string().min(1).max(80) }))
      .mutation(({ ctx, input }) => { ctx.registry.renameMachine(input.id, input.name); return ctx.registry.listMachines() }),
    revoke: t.procedure.input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => { ctx.registry.revokeMachine(input.id); return ctx.registry.listMachines() }),
    pairingCode: t.procedure.mutation(({ ctx }) => ({ code: ctx.registry.mintPairingCode() })),
  }),
```
- Also: `sessions.create`/`resume` inputs gain `machineId: z.string().optional()`, forwarded to the registry.
- **Test:** `router.machines.test.ts` — list returns the registered machines; rename/revoke mutate; `pairingCode` returns a non-empty string. **Commit.**

## Task 11: SocketHub `onMachines` (terminal-client)

**Files:** Modify `packages/terminal-client/src/connection.ts` (+ `connection.test.ts`).
- Mirror the `hostMetrics` plumbing exactly (lines ~123/146/369–376/529–531): add `private machinesList: MachineWire[] = []`, `private readonly machinesObservers = new Set<…>()`, `machines()`, `onMachines(cb)`, and in the message switch: `if (msg.type === 'machinesChanged') { this.machinesList = msg.machines; for (const o of this.machinesObservers) o(this.machinesList) }`.
- **Test:** mirror the existing `onHostMetrics` test (line 632) for `machinesChanged`. **Commit.**

## Task 12: Web store — machines state

**Files:** Modify `apps/web/src/store.tsx`.
- Add `machines: MachineWire[]` to `Store`; `const [machines, setMachines] = useState<MachineWire[]>([])`; in the effect, `const offMachines = hub.onMachines(setMachines)` (and clean up). Expose in `value`.
- **Test:** none required (thin wiring); covered by the panel test in Task 13. **Commit** with Task 13 or alone.

## Task 13: Settings → Machines panel

**Files:** Create `apps/web/src/MachinesPanel.tsx`; wire into the settings view (follow the existing settings section pattern). Optional component test with happy-dom.
- Renders one row per machine: name (inline-editable → `trpc.machines.rename`), hostname, an online/offline dot, relative `lastSeenAt`, and a **Revoke** button (confirm → `trpc.machines.revoke`).
- An **Add machine** button → `trpc.machines.pairingCode` → shows the code + the exact command to run on the other box: `npx @podium/daemon --server <thisOrigin> --pair <CODE>` (derive origin from `window.location`, per the auto-relay-endpoint memory).
- Uses shadcn `Button`, `Input`, `DropdownMenu`/`Dialog` primitives already in `components/ui`.
- **Manual check (per browser-testing memory):** build + static preview; the panel lists the local machine and mints a code. **Commit.**

**Stage 2 gate:** `bun run lint && typecheck && test` green; Settings → Machines lists the local machine and can mint a pairing code.

---

# STAGE 3 — Machine-aware dropdown, merge-by-repo, badge

## Task 14: Merge-by-repo in `derive.ts` + machine-tagged views

**Files:** Modify `apps/web/src/derive.ts`, `apps/web/src/types.ts`.
- `WorktreeView` gains `machineId?: string`; `RepoView` gains `machines: { machineId: string; path: string }[]` (which machines have this repo, with each machine's local path) and `originUrl?: string`.
- `reposToViews(repos)` groups by `normalizeOriginUrl(r.originUrl) || r.path`: repos that share an origin across machines collapse into one `RepoView` whose `machines[]` lists each, and whose `worktrees` union carries each worktree's `machineId`. Remote-less repos (empty origin) stay per (machineId, path).
- **Test:** `derive.machines.test.ts` — two `GitRepositoryWire` with the same `originUrl` on `m1`/`m2` collapse to one `RepoView` with `machines.length === 2`; differing origins stay separate. **Commit.**

## Task 15: `machinesForRepo` + `lastUsedMachine` helpers

**Files:** Modify `apps/web/src/derive.ts` (or a small `machines.ts`).
- `machinesForRepo(repoView, machines): MachineWire[]` — online machines that have the repo (intersect `repoView.machines[*].machineId` with `machines` where `online`).
- `lastUsedMachine(sessions, machines): string | undefined` — machineId of the most recently *created* session (`max createdAt`), used as the default target.
- `resolveTargetMachine(repoView, sessions, machines)` — most-recently-used machine that has the repo, else the first machine that has it.
- **Test:** unit each helper. **Commit.**

## Task 16: Machine-aware new-agent dropdown

**Files:** Modify `apps/web/src/NewPanelMenu.tsx`. Uses `DropdownMenuSub`/`SubTrigger`/`SubContent` (already in `components/ui/dropdown-menu.tsx`).
- One machine → render today's menu unchanged (gate on `machines.length <= 1`).
- More than one machine:
  1. **Agent options** (today's `NEW_AGENTS`) — `create(kind)` now passes `machineId: resolveTargetMachine(repoView, sessions, machines)` and that machine's local repo path as `cwd`.
  2. **Machines** section — one `DropdownMenuSub` per machine. A machine not in `machinesForRepo` renders a disabled `DropdownMenuItem` with a tooltip ("`<name>` doesn't have this repo"). An enabled machine's `SubContent` repeats the agent options (open on that machine, its local path) **plus that machine's resume hits** (`useConversationSearch` already returns `machineId`-tagged hits once Stage 1 indexes them; filter to this machine).
  3. **Resume convos** — the existing mini-search, unchanged (each hit resumes on its own machine).
- `create`/`resume` thread `machineId` to `trpc.sessions.create`/`resume`.
- **Manual check:** build + static preview with a stubbed two-machine store (`?e2e` harness) — verify ordering, graying + tooltip, and submenu. **Commit.**

## Task 17: Session machine badge

**Files:** Modify the session/chat header component + FleetView (locate via `agentBadge`/session header usage).
- When `store.machines.length > 1`, render a subtle badge showing `session.machineName` (read-only). Hidden for a single machine.
- **Test:** small render test or manual preview. **Commit.**

**Stage 3 gate:** `bun run lint && typecheck && test` green; with a stubbed second machine the dropdown shows the Machines section with correct graying, and sessions show a machine badge.

---

# STAGE 4 — End-to-end

## Task 18: E2E — pair a second daemon, open an agent on it

**Files:** Add a Playwright/integration spec under `e2e/` or `tests/` (follow the committed harness per the headless-browser-testing memory).
- Start a server; start the local (bootstrap) daemon. Start a SECOND daemon process with an isolated `PODIUM_STATE_DIR` + `homeDir`, no token; mint a pairing code via tRPC; pass it as `--pair`; assert it appears in `machines.list` as online.
- Drive the web (`?e2e=1` API): open the dropdown, confirm two machines; open a shell on the second machine; assert the new session's `machineId`/badge is the second machine and input round-trips to it.
- Reap both daemons by explicit PID in `afterAll` (per the agent-bridge PTY-leak memory — never `pkill -f`).
- **Commit.**

**Final gate:** `bun run lint && bun run typecheck && bun run test`; the E2E proves a real second daemon pairs and runs an agent that the server routes and the UI labels.

---

## Self-Review notes (author)

- **Spec coverage:** identity/pairing → T2,T4,T5,T6,T8; DB attribution + v4 → T3,T9; routing + per-machine metrics/cooldown → T5; merge-by-repo → T14; dropdown (MRU-with-repo, graying, submenu, resume) → T15,T16; Settings→Machines (rename/revoke/pairing) → T10,T13; badge → T17; origin match → T1; E2E → T18. All spec sections map to a task.
- **Type consistency:** `machineId` is the join key in store rows, `SessionInit`, `SessionMeta`, `MachineWire`, and all routing signatures; `attachDaemon(machineId, send)`, `detachDaemon(machineId)`, `onDaemonMessageFrom(machineId, msg)`, `authenticateDaemon(frame)` are used identically across T5/T6.
- **Single-machine invariant** is asserted at each stage gate; `'__local__'` placeholder + `adoptLocal` keep existing data correct (T3/T6).
