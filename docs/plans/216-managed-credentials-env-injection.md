# Managed credentials: env-injected accounts — Implementation Plan (#216)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user connect an LLM account once on the server and have any daemon
run agents on it, by carrying the credential to the daemon as spawn env.

**Architecture:** A new `accounts` table holds managed credentials server-side
(deliberately **not** the settings blob — `settings.get` round-trips wholesale to
the browser). At spawn, the server resolves the coding role's account into a plain
`env` map, ships it on an additive optional `SpawnMessage.env` field, and the
daemon merges it into the existing spawn env overlay. The env map is generic
`Record<string,string>` so #214 (GitHub) reuses it unchanged.

**Tech Stack:** TypeScript, Zod, SQLite (`SqlDatabase`), tRPC, Vitest.

## Global Constraints

- Design: `docs/design/managed-accounts-and-environments.md` (Phase 1). Spec:
  `[spec:SP-6454]`, rotation policy `[spec:SP-d697]`.
- **Credentials must never enter the `PodiumSettings` blob.** `settings.get`
  (`apps/server/src/router.ts:644`) returns the whole blob to the web client.
  Credentials live in the `accounts` table and are never returned by any query —
  only masked previews via `AccountView.identity`.
- **Only two credential kinds in this phase**, both long-lived, neither
  CLI-refreshed: a provider **API key**, and a Claude **`setup-token`** OAuth
  token. No credential-directory provisioning (`CLAUDE_CONFIG_DIR`), no refresh,
  no rotation. Those are Phase 5 and are explicitly out of scope.
- **Additive wire change only.** `SpawnMessage.env` is `.optional()`; protocol
  zod objects are non-strict, so no `WIRE_VERSION` bump.
- Next migration number is **016** (current schema version is 15).
- `packages/core` no longer exists — settings live in `packages/runtime`.
- Tests: Vitest (`bun run test` at repo root, or `vitest run` in a workspace).
- Commit after every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/migrations/016-accounts.ts` | **Create.** `accounts` table DDL. |
| `apps/server/src/migrations/index.ts` | **Modify.** Register migration 16. |
| `packages/runtime/src/settings.ts` | **Modify.** `ManagedCredential` schema + `credentialEnv()` — the pure credential→env mapping. |
| `apps/server/src/store/accounts.ts` | **Create.** `AccountsRepository` — CRUD over the `accounts` table. |
| `apps/server/src/accounts.ts` | **Modify.** `accountViews()` reads managed rows from the repo, masks them. |
| `packages/protocol/src/messages/terminal.ts` | **Modify.** `SpawnMessage.env?`. |
| `apps/server/src/modules/sessions/service.ts` | **Modify.** `accountEnv()` resolver; inject at both spawn sites. |
| `apps/daemon/src/control/session.ts` | **Modify.** Merge `msg.env` into the spawn env overlay. |
| `apps/server/src/router.ts` | **Modify.** `accounts.connect` / `accounts.disconnect` mutations. |
| `apps/web/src/features/settings/sections/shared.tsx` | **Modify.** Connect/disconnect UI. |

---

### Task 1: `accounts` table + repository

**Files:**
- Create: `apps/server/src/migrations/016-accounts.ts`
- Modify: `apps/server/src/migrations/index.ts`
- Create: `apps/server/src/store/accounts.ts`
- Test: `apps/server/src/store/accounts.test.ts`

**Interfaces:**
- Consumes: `SqlDatabase` from `@podium/runtime/sqlite`.
- Produces:
  ```ts
  export interface ManagedAccountRow {
    id: string            // 'managed:anthropic', 'managed:claude-oauth'
    provider: string      // 'anthropic' | 'openai' | 'openrouter'
    kind: 'api-key' | 'oauth'
    credential: string    // the secret. NEVER returned to a client.
    identity: string      // masked/display only, e.g. 'sk-a…f9x2'
    scope: 'role' | 'ambient'  // #216 always writes 'role'; 'ambient' is #214's
    createdAt: number
  }
  export class AccountsRepository {
    constructor(db: SqlDatabase)
    list(): ManagedAccountRow[]
    get(id: string): ManagedAccountRow | undefined
    upsert(row: ManagedAccountRow): void
    remove(id: string): void
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/store/accounts.test.ts`:

```ts
import { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, expect, it } from 'vitest'
import { MIGRATIONS, runMigrations } from '../migrations'
import { AccountsRepository } from './accounts'

let repo: AccountsRepository

beforeEach(() => {
  const db = openDatabase(':memory:')
  runMigrations(db, MIGRATIONS)
  repo = new AccountsRepository(db)
})

it('round-trips a managed account', () => {
  repo.upsert({
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk-ant-secret',
    identity: 'sk-a…cret',
    scope: 'role',
    createdAt: 1,
  })
  expect(repo.get('managed:anthropic')?.credential).toBe('sk-ant-secret')
  expect(repo.list()).toHaveLength(1)
})

it('upsert replaces an existing id rather than duplicating', () => {
  const base = {
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key' as const,
    identity: 'x',
    scope: 'role' as const,
    createdAt: 1,
  }
  repo.upsert({ ...base, credential: 'old' })
  repo.upsert({ ...base, credential: 'new' })
  expect(repo.list()).toHaveLength(1)
  expect(repo.get('managed:anthropic')?.credential).toBe('new')
})

it('remove deletes the row', () => {
  repo.upsert({
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  repo.remove('managed:anthropic')
  expect(repo.get('managed:anthropic')).toBeUndefined()
  expect(repo.list()).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bunx vitest run src/store/accounts.test.ts`
Expected: FAIL — cannot resolve `./accounts`.

- [ ] **Step 3: Write the migration**

Create `apps/server/src/migrations/016-accounts.ts`:

```ts
/**
 * Migration 016 — managed accounts [spec:SP-6454].
 *
 * Credentials Podium HOLDS and injects at spawn, as opposed to the native CLI
 * logins it merely observes. Deliberately its own table, NOT the settings blob:
 * `settings.get` round-trips the whole blob to the browser, so a credential
 * placed there would be shipped to every client.
 *
 * `credential` is plaintext in this migration — the same trust posture as the
 * existing settings.apiKeys. Encryption at rest is #218, which rewrites this
 * column in place and gates the refresh-token-bearing credentials (#214, and
 * managed OAuth). Only long-lived, non-refreshing credentials land here today.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      credential TEXT NOT NULL,
      identity TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'role',
      created_at INTEGER NOT NULL
    );
  `)
}
```

> **Why `scope` ships here unused.** #216 only ever writes `'role'` — an LLM
> credential selected per role. `'ambient'` (inject into *every* spawn) is what
> #214 needs for GitHub. The column lands now, with a default, purely so #214 does
> not have to add its own migration for one column: two issues racing to claim the
> next migration number is a collision this repo has hit before. The resolver in
> Task 5 ignores `scope` entirely.

- [ ] **Step 4: Register the migration**

In `apps/server/src/migrations/index.ts`, add the import alongside the others:

```ts
import { up as accounts } from './016-accounts'
```

and append to `MIGRATIONS` after the `superagent-pending-turns` entry:

```ts
  { version: 16, name: 'accounts', up: accounts },
```

- [ ] **Step 5: Write the repository**

Create `apps/server/src/store/accounts.ts`:

```ts
/**
 * Managed-account aggregate — credentials Podium holds and injects at spawn
 * [spec:SP-6454]. Separate from the settings blob on purpose: settings round-trip
 * to the browser wholesale, credentials must not.
 *
 * `credential` never leaves the server. Clients see only `identity` (masked),
 * via accountViews().
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export interface ManagedAccountRow {
  id: string
  provider: string
  kind: 'api-key' | 'oauth'
  credential: string
  identity: string
  /** 'role' = selected per role (#216, the only value written today).
   *  'ambient' = injected into every spawn (#214, GitHub). */
  scope: 'role' | 'ambient'
  createdAt: number
}

interface Row {
  id: string
  provider: string
  kind: string
  credential: string
  identity: string
  scope: string
  created_at: number
}

function toRow(r: Row): ManagedAccountRow {
  return {
    id: r.id,
    provider: r.provider,
    kind: r.kind === 'oauth' ? 'oauth' : 'api-key',
    credential: r.credential,
    identity: r.identity,
    scope: r.scope === 'ambient' ? 'ambient' : 'role',
    createdAt: r.created_at,
  }
}

export class AccountsRepository {
  constructor(private readonly db: SqlDatabase) {}

  list(): ManagedAccountRow[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY created_at ASC')
      .all() as Row[]
    return rows.map(toRow)
  }

  get(id: string): ManagedAccountRow | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined
    return row ? toRow(row) : undefined
  }

  upsert(row: ManagedAccountRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO accounts (id, provider, kind, credential, identity, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.provider,
        row.kind,
        row.credential,
        row.identity,
        row.scope,
        row.createdAt,
      )
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/server && bunx vitest run src/store/accounts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/migrations/016-accounts.ts apps/server/src/migrations/index.ts \
        apps/server/src/store/accounts.ts apps/server/src/store/accounts.test.ts
git commit -m "feat(accounts): managed-account table + repository (#216)"
```

---

### Task 2: `credentialEnv()` — the credential→env mapping

The pure function that decides which env var a credential becomes. Lives in
`packages/runtime` so both server and any future consumer share one truth.

**Files:**
- Modify: `packages/runtime/src/settings.ts` (append after `managedAccountId`, ~line 185)
- Test: `packages/runtime/src/settings-credential.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ManagedCredentialKind = z.enum(['api-key', 'oauth'])
  export interface ManagedCredential {
    provider: string
    kind: 'api-key' | 'oauth'
    credential: string
  }
  export function credentialEnv(c: ManagedCredential): Record<string, string>
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/runtime/src/settings-credential.test.ts`:

```ts
import { expect, it } from 'vitest'
import { credentialEnv } from './settings'

it('maps an anthropic api key to ANTHROPIC_API_KEY', () => {
  expect(credentialEnv({ provider: 'anthropic', kind: 'api-key', credential: 'sk-ant-1' })).toEqual({
    ANTHROPIC_API_KEY: 'sk-ant-1',
  })
})

it('maps an openai api key to OPENAI_API_KEY', () => {
  expect(credentialEnv({ provider: 'openai', kind: 'api-key', credential: 'sk-1' })).toEqual({
    OPENAI_API_KEY: 'sk-1',
  })
})

it('maps an anthropic oauth token to CLAUDE_CODE_OAUTH_TOKEN', () => {
  expect(credentialEnv({ provider: 'anthropic', kind: 'oauth', credential: 'oat-1' })).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: 'oat-1',
  })
})

it('yields nothing for a provider with no env mapping', () => {
  expect(credentialEnv({ provider: 'xai', kind: 'api-key', credential: 'x' })).toEqual({})
})

it('yields nothing for an empty credential rather than exporting a blank var', () => {
  expect(credentialEnv({ provider: 'anthropic', kind: 'api-key', credential: '' })).toEqual({})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/runtime && bunx vitest run src/settings-credential.test.ts`
Expected: FAIL — `credentialEnv` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/runtime/src/settings.ts`:

```ts
/** A credential Podium holds and injects (SP-6454, managed accounts). Only
 *  long-lived, non-CLI-refreshed credentials ride here: a provider API key, or a
 *  Claude `setup-token` OAuth token. The refreshing OAuth blobs (claudeAiOauth,
 *  codex auth.json) are credential FILES, not env, and are out of scope. */
export interface ManagedCredential {
  provider: string
  kind: 'api-key' | 'oauth'
  credential: string
}

/** Which env var a managed credential becomes on an agent spawn. An unmapped
 *  provider or an empty secret yields {} — never a blank env var, which some CLIs
 *  treat as "configured but broken" rather than "absent". */
export function credentialEnv(c: ManagedCredential): Record<string, string> {
  if (!c.credential) return {}
  if (c.kind === 'oauth') {
    // Only Claude has a long-lived, env-consumable OAuth token (`claude setup-token`).
    return c.provider === 'anthropic' ? { CLAUDE_CODE_OAUTH_TOKEN: c.credential } : {}
  }
  const KEY_ENV: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  }
  const name = KEY_ENV[c.provider]
  return name ? { [name]: c.credential } : {}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/runtime && bunx vitest run src/settings-credential.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/settings.ts packages/runtime/src/settings-credential.test.ts
git commit -m "feat(settings): credentialEnv() maps a managed credential to spawn env (#216)"
```

---

### Task 3: `SpawnMessage.env` — the wire seam

**Files:**
- Modify: `packages/protocol/src/messages/terminal.ts:271-287`
- Test: `packages/protocol/src/messages/terminal-env.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SpawnMessage.env?: Record<string, string>` — generic, provider-agnostic.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/messages/terminal-env.test.ts`:

```ts
import { expect, it } from 'vitest'
import { SpawnMessage } from './terminal'

const base = {
  type: 'spawn' as const,
  sessionId: 's1',
  agentKind: 'claude-code' as const,
  cwd: '/tmp',
  geometry: { cols: 80, rows: 24 },
}

it('accepts an env map', () => {
  const parsed = SpawnMessage.parse({ ...base, env: { ANTHROPIC_API_KEY: 'sk-1' } })
  expect(parsed.env).toEqual({ ANTHROPIC_API_KEY: 'sk-1' })
})

it('treats env as optional — an old server omitting it still parses', () => {
  expect(SpawnMessage.parse(base).env).toBeUndefined()
})

it('rejects a non-string env value', () => {
  expect(SpawnMessage.safeParse({ ...base, env: { A: 1 } }).success).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && bunx vitest run src/messages/terminal-env.test.ts`
Expected: FAIL — the first test fails (`env` is stripped, so `parsed.env` is `undefined`).

- [ ] **Step 3: Add the field**

In `packages/protocol/src/messages/terminal.ts`, inside `SpawnMessage = z.object({…})`,
add after `initialPrompt`:

```ts
  // Managed-credential + environment vars resolved SERVER-side and merged into the
  // daemon's spawn env overlay (SP-6454, #216). Generic on purpose — an LLM
  // credential, a GitHub token (#214) and machine-level pins (#234) all ride here.
  // Additive + optional: an older daemon ignores it, an older server omits it.
  env: z.record(z.string(), z.string()).optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/protocol && bunx vitest run src/messages/terminal-env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages/terminal.ts packages/protocol/src/messages/terminal-env.test.ts
git commit -m "feat(protocol): additive optional SpawnMessage.env (#216)"
```

---

### Task 4: Daemon merges `msg.env` into the spawn env

**Files:**
- Modify: `apps/daemon/src/control/session.ts:118-131`
- Test: `apps/daemon/src/control/session-env.test.ts`

**Interfaces:**
- Consumes: `SpawnMessage.env` (Task 3).
- Produces: nothing new — behavioral change to the existing spawn env overlay.

**Precedence:** `msg.env` is merged **first**, so Podium's own bindings
(`PODIUM_SESSION_ID`, `PODIUM_ISSUE_RELAY`, the hook URL) win a collision. A
managed credential must never be able to shadow the issue-relay wiring.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/control/session-env.test.ts`:

```ts
import { expect, it } from 'vitest'
import { spawnEnv } from './session'

it('passes a managed credential through to the spawn env', () => {
  const env = spawnEnv({
    sessionEnv: { ANTHROPIC_API_KEY: 'sk-1' },
    podiumEnv: { PODIUM_SESSION_ID: 's1' },
  })
  expect(env.ANTHROPIC_API_KEY).toBe('sk-1')
  expect(env.PODIUM_SESSION_ID).toBe('s1')
})

it('is a no-op when the server sends no env', () => {
  expect(spawnEnv({ podiumEnv: { PODIUM_SESSION_ID: 's1' } })).toEqual({
    PODIUM_SESSION_ID: 's1',
  })
})

it("podium's own bindings win a collision — a credential cannot shadow the relay", () => {
  const env = spawnEnv({
    sessionEnv: { PODIUM_SESSION_ID: 'evil' },
    podiumEnv: { PODIUM_SESSION_ID: 's1' },
  })
  expect(env.PODIUM_SESSION_ID).toBe('s1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && bunx vitest run src/control/session-env.test.ts`
Expected: FAIL — `spawnEnv` is not exported from `./session`.

- [ ] **Step 3: Extract + implement `spawnEnv`**

In `apps/daemon/src/control/session.ts`, add this exported helper above the spawn
handler (it is exported purely so the merge order is directly testable):

```ts
/** Merge the server-resolved session env (managed credentials, #216) under
 *  Podium's own per-session bindings. Podium's win a collision on purpose: an
 *  injected credential must never be able to shadow the issue-relay wiring. */
export function spawnEnv(opts: {
  sessionEnv?: Record<string, string>
  podiumEnv: Record<string, string>
}): Record<string, string> {
  return { ...(opts.sessionEnv ?? {}), ...opts.podiumEnv }
}
```

Then replace the `env: {…}` block inside `spawnOpts` (currently lines 118-131) with:

```ts
      env: spawnEnv({
        // Server-resolved managed credential / environment (SP-6454, #216).
        sessionEnv: msg.env,
        podiumEnv: {
          // Bind the loopback issue-relay + session id into every agent's env so its
          // `podium issue` CLI can reach the daemon for this exact session.
          ...issueRelayEnv(msg.sessionId, ctx.issueRelayEndpointFor(msg.sessionId)),
          // Subagent model rides as env — Claude Code reads it; harmless elsewhere.
          ...(msg.subagentModel ? { CLAUDE_CODE_SUBAGENT_MODEL: msg.subagentModel } : {}),
          // 'global-env' hook installs (codex): hooks.json is installed GLOBALLY
          // (per CODEX_HOME, not per spawn); the per-session ingest URL rides the
          // env instead. The hook command exits 0 instantly when the var is
          // absent, so runs outside Podium are unaffected.
          ...(AGENT_CAPABILITIES[msg.agentKind].hookInstall === 'global-env'
            ? { [PODIUM_CODEX_HOOK_URL_ENV]: ctx.hookEndpointFor(msg.sessionId) }
            : {}),
        },
      }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/daemon && bunx vitest run src/control/session-env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/control/session.ts apps/daemon/src/control/session-env.test.ts
git commit -m "feat(daemon): merge server-resolved env into the spawn overlay (#216)"
```

---

### Task 5: Server resolves the account into spawn env

`modelDefaults()` (`apps/server/src/modules/sessions/service.ts:1604`) is the
existing precedent: a private method that reads settings and returns spawn-message
fields. `accountEnv()` is its sibling.

**Files:**
- Modify: `apps/server/src/modules/sessions/service.ts` — add `accountEnv()`; call at the two `type: 'spawn'` sites (**:1390** create, **:1578** resurrect)
- Test: `apps/server/src/modules/sessions/account-env.test.ts`

**Interfaces:**
- Consumes: `AccountsRepository` (Task 1), `credentialEnv` + `resolveRole` (Task 2 / existing).
- Produces:
  ```ts
  // on SessionsService
  private accountEnv(): { env?: Record<string, string> }
  ```
  Returns `{}` (not `{ env: {} }`) when there is no managed credential, so the
  spawn frame stays byte-identical to today for native-account users.

**Note on resume:** `accountEnv()` reads settings live, exactly as `modelDefaults()`
already does for `model`/`effort` — a resurrected session picks up the *current*
account, not the one it was born with. That is correct and intentional for Phase 1:
both credential kinds here are account-wide and long-lived, and nothing about a
transcript is bound to them. It stops being correct in Phase 5, where
`CLAUDE_CONFIG_DIR` relocates transcripts — the design doc calls out persisting
`account_id` on the session row at that point. Do **not** add the column now.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/modules/sessions/account-env.test.ts`:

```ts
import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { MIGRATIONS, runMigrations } from '../../migrations'
import { AccountsRepository } from '../../store/accounts'
import { resolveAccountEnv } from './account-env'

function repoWith(...rows: Array<Parameters<AccountsRepository['upsert']>[0]>) {
  const db = openDatabase(':memory:')
  runMigrations(db, MIGRATIONS)
  const repo = new AccountsRepository(db)
  for (const r of rows) repo.upsert(r)
  return repo
}

it('resolves a managed api-key account into env', () => {
  const repo = repoWith({
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk-ant-1',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  expect(resolveAccountEnv(repo, 'managed:anthropic')).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-ant-1' },
  })
})

it('resolves a managed oauth account into CLAUDE_CODE_OAUTH_TOKEN', () => {
  const repo = repoWith({
    id: 'managed:claude-oauth',
    provider: 'anthropic',
    kind: 'oauth',
    credential: 'oat-1',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  expect(resolveAccountEnv(repo, 'managed:claude-oauth')).toEqual({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
  })
})

it('yields NO env key for a native account — the frame stays as it is today', () => {
  expect(resolveAccountEnv(repoWith(), 'native:claude-code')).toEqual({})
})

it('yields no env key when the account id has no stored credential', () => {
  expect(resolveAccountEnv(repoWith(), 'managed:anthropic')).toEqual({})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bunx vitest run src/modules/sessions/account-env.test.ts`
Expected: FAIL — cannot resolve `./account-env`.

- [ ] **Step 3: Implement the resolver**

Create `apps/server/src/modules/sessions/account-env.ts`:

```ts
/**
 * Resolve a role's account id into the env a spawn should carry (SP-6454, #216).
 *
 * Native accounts inject nothing — the CLI uses its own on-disk login, and the
 * spawn frame stays byte-identical to the pre-#216 shape. Only a MANAGED account
 * with a stored credential produces env.
 */

import { credentialEnv } from '@podium/runtime'
import type { AccountsRepository } from '../../store/accounts'

export function resolveAccountEnv(
  accounts: AccountsRepository,
  accountId: string,
): { env?: Record<string, string> } {
  if (!accountId.startsWith('managed:')) return {}
  const row = accounts.get(accountId)
  if (!row) return {}
  const env = credentialEnv({
    provider: row.provider,
    kind: row.kind,
    credential: row.credential,
  })
  return Object.keys(env).length > 0 ? { env } : {}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bunx vitest run src/modules/sessions/account-env.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into both spawn sites**

In `apps/server/src/modules/sessions/service.ts`:

Add the import at the top:

```ts
import { resolveAccountEnv } from './account-env'
```

Add this private method next to `modelDefaults` (~line 1604):

```ts
  /** The managed credential (if any) for the coding role, as spawn env (#216).
   *  Native accounts yield {} — the CLI uses its own login and the frame is
   *  unchanged. Read live at spawn, like modelDefaults. */
  private accountEnv(): { env?: Record<string, string> } {
    const role = resolveRole(this.store.settings.getSettings(), 'coding')
    return resolveAccountEnv(this.store.accounts, role.accountId)
  }
```

At **both** `this.toMachine(machineId, { type: 'spawn', … })` calls — the create
path (~line 1390) and the resurrect path (~line 1578) — add `...this.accountEnv(),`
as the final spread, immediately after the `...this.modelDefaults(…)` spread.

**Register the repository on the store aggregate first** — `this.store.accounts`
does not exist yet. In `apps/server/src/store.ts`, following the `SettingsRepository`
pattern exactly (verified line numbers):

```ts
// near line 45, with the other repository imports:
import { AccountsRepository } from './store/accounts'

// near line 65, with the other readonly fields:
  readonly accounts: AccountsRepository

// near line 104, with the other constructions:
    this.accounts = new AccountsRepository(this.db)
```

- [ ] **Step 6: Typecheck + run the sessions tests**

Run: `bun run typecheck && cd apps/server && bunx vitest run src/modules/sessions`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/sessions/account-env.ts \
        apps/server/src/modules/sessions/account-env.test.ts \
        apps/server/src/modules/sessions/service.ts apps/server/src/store/
git commit -m "feat(sessions): inject the managed credential as spawn env (#216)"
```

---

### Task 6: `accounts.connect` / `accounts.disconnect` + masked views

**Files:**
- Modify: `apps/server/src/accounts.ts` (`accountViews`, ~line 94)
- Modify: `apps/server/src/router.ts` (`accounts` router, ~line 655)
- Test: `apps/server/src/accounts.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `AccountsRepository` (Task 1).
- Produces:
  ```ts
  accounts.connect({ provider, kind, credential }) -> { id: string }
  accounts.disconnect({ id }) -> { ok: true }
  // accountViews(settings, accounts, homeDir?) — managed rows now read from the repo
  ```

**Security invariant this task must preserve:** no procedure ever returns
`credential`. `accountViews` returns only the masked `identity`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/accounts.test.ts`:

```ts
it('shows a connected managed account as connected, masked, and never leaks the secret', () => {
  const db = openDatabase(':memory:')
  runMigrations(db, MIGRATIONS)
  const accounts = new AccountsRepository(db)
  accounts.upsert({
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk-ant-supersecret',
    identity: 'sk-a…cret',
    scope: 'role',
    createdAt: 1,
  })

  const views = accountViews(DEFAULT_SETTINGS, accounts)
  const view = views.find((v) => v.id === 'managed:anthropic')

  expect(view?.status).toBe('connected')
  expect(view?.identity).toBe('sk-a…cret')
  expect(view?.comingSoon).toBeUndefined()
  expect(JSON.stringify(views)).not.toContain('sk-ant-supersecret')
})
```

Add the imports this test needs at the top of the file:

```ts
import { openDatabase } from '@podium/runtime/sqlite'
import { DEFAULT_SETTINGS } from '@podium/runtime'
import { MIGRATIONS, runMigrations } from './migrations'
import { AccountsRepository } from './store/accounts'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bunx vitest run src/accounts.test.ts`
Expected: FAIL — `accountViews` does not take an accounts repository.

- [ ] **Step 3: Read managed rows from the repo**

In `apps/server/src/accounts.ts`, change `accountViews` to take the repository and
build managed rows from it. Replace the existing `MANAGED_KEY_PROVIDERS` block:

```ts
export function accountViews(
  settings: PodiumSettings,
  accounts: AccountsRepository,
  homeDir: string = homedir(),
): AccountView[] {
  const native = [detectClaude(homeDir), detectCodex(), detectGrok(homeDir)]

  // Managed rows: a stored credential (#216) wins; otherwise fall back to the
  // legacy settings.apiKeys value so an existing key keeps showing as connected.
  const stored = new Map(accounts.list().map((a) => [a.id, a]))
  const managed: AccountView[] = MANAGED_KEY_PROVIDERS.map((provider) => {
    const id = `managed:${provider}`
    const row = stored.get(id)
    const legacyKey = settings.apiKeys[provider] ?? ''
    const identity = row?.identity || (legacyKey ? maskKey(legacyKey) : undefined)
    return {
      id,
      provider,
      source: 'managed' as const,
      kind: 'api-key' as const,
      identity,
      status: identity ? ('connected' as const) : ('not-configured' as const),
    }
  })

  // The Claude subscription OAuth token (`claude setup-token`) — a managed account
  // with no legacy settings equivalent, so it only ever comes from the store.
  const oauthRow = stored.get('managed:claude-oauth')
  const claudeOauth: AccountView = {
    id: 'managed:claude-oauth',
    provider: 'anthropic',
    source: 'managed',
    kind: 'oauth',
    identity: oauthRow?.identity,
    status: oauthRow ? 'connected' : 'not-configured',
  }

  return [...native, ...managed, claudeOauth]
}
```

Add the import:

```ts
import type { AccountsRepository } from './store/accounts'
```

- [ ] **Step 4: Add the mutations**

In `apps/server/src/router.ts`, replace the `accounts` router (~line 655):

```ts
  accounts: t.router({
    // The Accounts & Keys hub (SP-6454): native CLI logins on this machine
    // (observed read-only) + managed credentials Podium holds. Read at call-time —
    // native identity/quota drifts, so it's never cached as truth.
    // NB: never returns a credential — only its masked `identity`.
    list: t.procedure.query(({ ctx }) =>
      accountViews(mods(ctx).settings.getSettings(), ctx.store.accounts),
    ),
    connect: t.procedure
      .input(
        z.object({
          provider: z.enum(['anthropic', 'openai', 'openrouter']),
          kind: z.enum(['api-key', 'oauth']),
          credential: z.string().min(1),
        }),
      )
      .mutation(({ ctx, input }) => {
        // A Claude setup-token is its own account, distinct from an Anthropic API key.
        const id =
          input.kind === 'oauth' ? 'managed:claude-oauth' : `managed:${input.provider}`
        ctx.store.accounts.upsert({
          id,
          provider: input.provider,
          kind: input.kind,
          credential: input.credential,
          identity: maskCredential(input.credential),
          scope: 'role',
          createdAt: Date.now(),
        })
        return { id }
      }),
    disconnect: t.procedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
      ctx.store.accounts.remove(input.id)
      return { ok: true as const }
    }),
  }),
```

Export the mask helper from `apps/server/src/accounts.ts` so the router shares one
implementation (rename the existing private `maskKey`):

```ts
/** Display-only preview of a secret. The full value never leaves the server. */
export function maskCredential(secret: string): string {
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}
```

Update the internal call sites in `accounts.ts` from `maskKey(` to `maskCredential(`,
and import `maskCredential` + `z` in `router.ts` if not already imported.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/server && bunx vitest run src/accounts.test.ts && bun run typecheck`
Expected: PASS; no type errors. Fix any other `accountViews(` call sites the
typecheck flags (the new required `accounts` argument).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/accounts.ts apps/server/src/accounts.test.ts apps/server/src/router.ts
git commit -m "feat(accounts): connect/disconnect managed credentials, masked views (#216)"
```

---

### Task 7: Settings UI — connect / disconnect

**Files:**
- Modify: `apps/web/src/features/settings/sections/shared.tsx`
- Test: manual (see Step 3) — this is a small form over existing tRPC hooks.

**Interfaces:**
- Consumes: `accounts.list`, `accounts.connect`, `accounts.disconnect` (Task 6).

- [ ] **Step 1: Locate the Accounts hub rendering**

Run: `grep -rn "accounts.list\|comingSoon" apps/web/src/features/settings/sections/shared.tsx`

The managed rows currently render disabled with a "Coming soon" label. Those rows
are what this task makes live.

- [ ] **Step 2: Make managed rows connectable**

For each managed `AccountView`:
- `status === 'not-configured'` → render a **Connect** button opening a small form:
  a password-type input for the secret, plus a submit calling
  `trpc.accounts.connect.mutate({ provider, kind, credential })`. On success,
  invalidate/refetch `accounts.list`.
- `status === 'connected'` → render the masked `identity` plus a **Disconnect**
  button calling `trpc.accounts.disconnect.mutate({ id })`, then refetch.
- Drop the `comingSoon` disabling **only** for these managed rows. Native rows and
  any Phase 5 (credential-directory / rotation) affordances keep their existing
  treatment.

For the `managed:claude-oauth` row, label it *"Claude subscription (setup-token)"*
and include this helper text verbatim, because the token cannot be obtained from
inside Podium:

> Run `claude setup-token` in a terminal and paste the token here. It is a
> long-lived subscription token (about a year) and is not your API key.

- [ ] **Step 3: Verify in the real UI**

Run the app, open Settings → Accounts, and confirm all four:
1. Paste an Anthropic API key → the row flips to **connected** with a masked identity.
2. Reload the page → it is still connected (it persisted to the DB, not to component state).
3. Click **Disconnect** → it returns to **not-configured**.
4. In the browser devtools Network tab, inspect the `accounts.list` response and
   confirm **the full secret does not appear anywhere in the payload** — only the
   masked identity. This is the security invariant; do not skip it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/settings/sections/shared.tsx
git commit -m "feat(web): connect/disconnect managed accounts in the Accounts hub (#216)"
```

---

### Task 8: End-to-end verification

**Files:** none — this task proves the feature works against the real CLI.

- [ ] **Step 1: Confirm the credential actually reaches the agent**

The whole point of #216 is that an agent runs on a server-held credential. Prove it:

1. In Settings → Accounts, connect an **Anthropic API key**.
2. Set the coding role's account to `managed:anthropic`.
3. Spawn a new claude-code session.
4. In that session's terminal, run: `env | grep ANTHROPIC_API_KEY`
   Expected: the key is present in the agent's environment.
5. Ask the agent to answer a trivial prompt and confirm it responds — i.e. the
   credential is not merely present but *working*.

- [ ] **Step 2: Confirm the native path is unchanged**

1. Set the coding role's account back to `native:claude-code`.
2. Spawn a session and run `env | grep ANTHROPIC_API_KEY`.
   Expected: **absent** — a native account must inject nothing, and the agent must
   still work off its own on-disk login. This is the regression that would silently
   change every existing user's billing, so verify it explicitly.

- [ ] **Step 3: Full suite + typecheck**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 4: Update the issue and commit any fixes**

```bash
podium issue update --id 216 --stage review
```

---

## Out of scope — do not build these here

Each is a separate, already-filed issue. Adding any of them to this phase
reintroduces a risk the phase was designed to avoid:

- **Credential-directory provisioning** (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) —
  Phase 5. It relocates transcripts and needs refresh/rotation handling.
- **Encryption at rest** — **#218**. The `credential` column is plaintext here,
  matching today's `settings.apiKeys` posture. #218 rewrites the column.
- **The Environment object** (permission mode, plugins, hooks, system prompt) —
  **#217**. This phase carries credentials only.
- **Ambient accounts / GitHub** — **#214**. It consumes the generic
  `SpawnMessage.env` this phase lands, and adds `Account.scope`.
- **Account rotation / 429 failover** — `[spec:SP-d697]`, part of #217.
- **`account_id` on the session row** — needed only once transcripts are bound to
  an account (Phase 5). See the note in Task 5.
