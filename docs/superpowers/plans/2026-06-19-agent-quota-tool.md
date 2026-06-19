# Agent Quota Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new sidebar status-bar tool that shows live plan-quota usage per agent — Claude Code (5-hour + weekly) and Codex (5-hour + weekly) — with percent-of-window consumed and reset countdowns.

**Architecture:** The daemon (where agent credentials live) reads each agent's own usage endpoint read-only, caches per-agent with a short TTL, and returns the result over the existing `daemonRequest` control-message channel. The server exposes it as a tRPC `quota.summary` query; the web renders a new `QuotaView` reached from a sidebar tools-row button. Mirrors the existing `usage` feature end-to-end. Grok is intentionally excluded (no local quota source).

**Tech Stack:** TypeScript, Bun workspaces, Zod (`@podium/protocol` wire schemas), tRPC, React 19 + Tailwind v4 + shadcn/ui, Vitest, Biome.

## Global Constraints

- **Worktree only.** All work in `.worktrees/agent-quota` on branch `feat/agent-quota-tool`. NEVER edit the live `main` checkout (`/home/user/src/other/podium`) — it is the running backend's source.
- **Read-only credentials.** Never refresh-and-write-back any agent credential file. An expired token surfaces as `status: 'expired'`, never a write.
- **`AgentKind` values are `'claude-code'` and `'codex'`** (not `'claude'`). Reuse the existing `AgentKind` enum from `@podium/protocol`.
- **Per-agent failure isolation.** One agent failing must never block another; it renders its own error/empty state.
- **Deploy web + backend together.** New protocol message types mean a stale Vite would silently drop them. Standard for this repo.
- **Test runner:** `npx vitest run <file>` for one file; `bun run typecheck` for types; `bun run lint` for Biome. Vitest tests colocate as `<name>.test.ts` next to source.
- **Commit after every task** with a `feat:`/`test:` message scoped to the change.

---

### Task 1: Protocol — quota wire types & control messages

**Files:**
- Modify: `packages/protocol/src/messages.ts` (insert after line 610, the `UsageResultMessage` block; register in the `ControlMessage` union near line 612 and the `DaemonMessage` union near line 777)
- Test: `packages/protocol/src/messages.test.ts`

**Interfaces:**
- Consumes: `AgentKind` (already defined at `messages.ts:15`), `z`, `encode`/`decode` (already in this file).
- Produces:
  - `QuotaWindowWire = { key: '5h'|'weekly', label: string, usedPercent: number, resetsAt: string, windowMinutes: number }`
  - `AgentQuotaWire = { agent: AgentKind, status: 'ok'|'unauthenticated'|'expired'|'error', account?: {email?: string, plan?: string}, windows: QuotaWindowWire[], error?: string, fetchedAt: string }`
  - `AgentQuotaRequestMessage = { type: 'agentQuotaRequest', requestId: string, refresh?: boolean }`
  - `AgentQuotaResultMessage = { type: 'agentQuotaResult', requestId: string, hostname: string, agents: AgentQuotaWire[] }`

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/messages.test.ts` (it already imports from `./messages` and uses `encode`/`decode`):

```ts
import { AgentQuotaResultMessage, decode, encode } from './messages'

it('round-trips an agentQuotaResult over encode/decode', () => {
  const msg = {
    type: 'agentQuotaResult' as const,
    requestId: 'aq1',
    hostname: 'box',
    agents: [
      {
        agent: 'claude-code' as const,
        status: 'ok' as const,
        windows: [
          { key: '5h' as const, label: '5-hour', usedPercent: 42.5, resetsAt: '2026-06-19T20:00:00.000Z', windowMinutes: 300 },
          { key: 'weekly' as const, label: 'Weekly', usedPercent: 7, resetsAt: '2026-06-24T00:00:00.000Z', windowMinutes: 10080 },
        ],
        fetchedAt: '2026-06-19T18:00:00.000Z',
      },
    ],
  }
  expect(decode(encode(msg))).toEqual(msg)
  expect(AgentQuotaResultMessage.parse(msg)).toEqual(msg)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/src/messages.test.ts -t "agentQuotaResult"`
Expected: FAIL — `AgentQuotaResultMessage` is not exported / `decode` rejects the unknown `type`.

- [ ] **Step 3: Write minimal implementation**

In `packages/protocol/src/messages.ts`, insert immediately after the `UsageResultMessage` block (after line 610):

```ts
// ── Agent plan-quota (rate-limit windows). Distinct from UsageBucketWire, which
// is transcript-harvested token-cost analytics. Quota is the share of each rolling
// plan window consumed + when it resets, read live from each agent's own usage
// endpoint on the daemon host. Claude: 5h + weekly. Codex: 5h + weekly.
export const QuotaWindowWire = z.object({
  key: z.enum(['5h', 'weekly']),
  label: z.string(),
  usedPercent: z.number(), // 0..100
  resetsAt: z.string(), // ISO 8601 ('' when unknown)
  windowMinutes: z.number().int().positive(),
})
export type QuotaWindowWire = z.infer<typeof QuotaWindowWire>

export const AgentQuotaWire = z.object({
  agent: AgentKind,
  status: z.enum(['ok', 'unauthenticated', 'expired', 'error']),
  account: z.object({ email: z.string().optional(), plan: z.string().optional() }).optional(),
  windows: z.array(QuotaWindowWire),
  error: z.string().optional(),
  fetchedAt: z.string(), // ISO 8601
})
export type AgentQuotaWire = z.infer<typeof AgentQuotaWire>

export const AgentQuotaRequestMessage = z.object({
  type: z.literal('agentQuotaRequest'),
  requestId: z.string(),
  refresh: z.boolean().optional(),
})
export const AgentQuotaResultMessage = z.object({
  type: z.literal('agentQuotaResult'),
  requestId: z.string(),
  hostname: z.string(),
  agents: z.array(AgentQuotaWire),
})
```

Then add `AgentQuotaRequestMessage,` to the `ControlMessage` discriminated union (the list at ~line 612-629, e.g. right after `UsageRequestMessage,`) and `AgentQuotaResultMessage,` to the `DaemonMessage` discriminated union (the list at ~line 777-800, e.g. right after `UsageResultMessage,`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/protocol/src/messages.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/agent-quota add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git -C .worktrees/agent-quota commit -m "feat(protocol): agent quota wire types + control messages"
```

---

### Task 2: Claude quota fetcher (daemon)

**Files:**
- Create: `apps/daemon/src/quota-claude.ts`
- Test: `apps/daemon/src/quota-claude.test.ts`

**Interfaces:**
- Consumes: `AgentQuotaWire`, `QuotaWindowWire` (Task 1).
- Produces:
  - `parseClaudeUsage(body: ClaudeUsageResponse): QuotaWindowWire[]`
  - `fetchClaudeQuota(deps?: { homeDir?: string; now?: number; fetchImpl?: typeof fetch }): Promise<AgentQuotaWire>`
  - `interface ClaudeUsageResponse { five_hour?: {utilization?: number; resets_at?: string}; seven_day?: {utilization?: number; resets_at?: string} }`

> **Verification note for the implementer:** the Anthropic `oauth/usage` `utilization` field is treated here as a **0..1 fraction** (×100 for percent). Confirm against the live endpoint during Task 5 manual verification; if it is already 0..100, drop the `* 100` in `toPct`. Tests below pin the fraction convention.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/quota-claude.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchClaudeQuota, parseClaudeUsage } from './quota-claude'

function homeWithCreds(creds: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'podium-cq-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(creds))
  return home
}
const okBody = {
  five_hour: { utilization: 0.425, resets_at: '2026-06-19T20:00:00.000Z' },
  seven_day: { utilization: 0.07, resets_at: '2026-06-24T00:00:00.000Z' },
}
const now = Date.parse('2026-06-19T18:00:00.000Z')
const future = now + 3_600_000

describe('parseClaudeUsage', () => {
  it('maps fraction utilization to 0..100 percent + window minutes', () => {
    expect(parseClaudeUsage(okBody)).toEqual([
      { key: '5h', label: '5-hour', usedPercent: 42.5, resetsAt: '2026-06-19T20:00:00.000Z', windowMinutes: 300 },
      { key: 'weekly', label: 'Weekly', usedPercent: 7, resetsAt: '2026-06-24T00:00:00.000Z', windowMinutes: 10080 },
    ])
  })
})

describe('fetchClaudeQuota', () => {
  it('is unauthenticated when no credentials file exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'podium-cq-'))
    const r = await fetchClaudeQuota({ homeDir: home, now })
    expect(r).toMatchObject({ agent: 'claude-code', status: 'unauthenticated', windows: [] })
  })

  it('is expired (no network call) when the token is past expiry', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: now - 1 } })
    let called = false
    const r = await fetchClaudeQuota({
      homeDir: home, now,
      fetchImpl: (async () => { called = true; return new Response('', { status: 200 }) }) as typeof fetch,
    })
    expect(called).toBe(false)
    expect(r.status).toBe('expired')
  })

  it('returns ok windows on a 200 with a valid token', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r = await fetchClaudeQuota({
      homeDir: home, now,
      fetchImpl: (async () => new Response(JSON.stringify(okBody), { status: 200 })) as typeof fetch,
    })
    expect(r.status).toBe('ok')
    expect(r.windows.map((w) => w.key)).toEqual(['5h', 'weekly'])
  })

  it('maps 401 to expired and other failures to error', async () => {
    const home = homeWithCreds({ claudeAiOauth: { accessToken: 't', expiresAt: future } })
    const r401 = await fetchClaudeQuota({ homeDir: home, now, fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch })
    expect(r401.status).toBe('expired')
    const r500 = await fetchClaudeQuota({ homeDir: home, now, fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch })
    expect(r500.status).toBe('error')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/daemon/src/quota-claude.test.ts`
Expected: FAIL — `./quota-claude` has no exports.

- [ ] **Step 3: Write minimal implementation**

Create `apps/daemon/src/quota-claude.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/protocol'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

export interface ClaudeUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string }
  seven_day?: { utilization?: number; resets_at?: string }
}

// utilization is a 0..1 fraction (see verification note in the plan). Surface 0..100.
const toPct = (u: number | undefined): number =>
  typeof u === 'number' && Number.isFinite(u) ? Math.round(u * 1000) / 10 : 0

export function parseClaudeUsage(body: ClaudeUsageResponse): QuotaWindowWire[] {
  const windows: QuotaWindowWire[] = []
  if (body.five_hour) {
    windows.push({
      key: '5h', label: '5-hour',
      usedPercent: toPct(body.five_hour.utilization),
      resetsAt: body.five_hour.resets_at ?? '',
      windowMinutes: 300,
    })
  }
  if (body.seven_day) {
    windows.push({
      key: 'weekly', label: 'Weekly',
      usedPercent: toPct(body.seven_day.utilization),
      resetsAt: body.seven_day.resets_at ?? '',
      windowMinutes: 10_080,
    })
  }
  return windows
}

export async function fetchClaudeQuota(
  deps: { homeDir?: string; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<AgentQuotaWire> {
  const now = deps.now ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = { agent: 'claude-code' as const, windows: [] as QuotaWindowWire[], fetchedAt: new Date(now).toISOString() }
  const credPath = join(deps.homeDir ?? homedir(), '.claude', '.credentials.json')
  let token: string | undefined
  let expiresAt: number | undefined
  try {
    const raw = JSON.parse(await readFile(credPath, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number }
    }
    token = raw.claudeAiOauth?.accessToken
    expiresAt = raw.claudeAiOauth?.expiresAt
  } catch {
    return { ...base, status: 'unauthenticated' }
  }
  if (!token) return { ...base, status: 'unauthenticated' }
  if (typeof expiresAt === 'number' && expiresAt <= now) {
    return { ...base, status: 'expired', error: 'token expired (refreshes on next Claude use)' }
  }
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-code/2.1.0',
      },
    })
    if (res.status === 401) {
      return { ...base, status: 'expired', error: 'token expired (refreshes on next Claude use)' }
    }
    if (!res.ok) return { ...base, status: 'error', error: `usage endpoint ${res.status}` }
    const body = (await res.json()) as ClaudeUsageResponse
    return { ...base, status: 'ok', windows: parseClaudeUsage(body) }
  } catch (e) {
    return { ...base, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/daemon/src/quota-claude.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/agent-quota add apps/daemon/src/quota-claude.ts apps/daemon/src/quota-claude.test.ts
git -C .worktrees/agent-quota commit -m "feat(daemon): Claude plan-quota fetcher (read-only oauth/usage)"
```

---

### Task 3: Codex quota fetcher (daemon)

**Files:**
- Create: `apps/daemon/src/quota-codex.ts`
- Test: `apps/daemon/src/quota-codex.test.ts`

**Interfaces:**
- Consumes: `AgentQuotaWire`, `QuotaWindowWire` (Task 1).
- Produces:
  - `interface CodexRateLimitWindow { usedPercent?: number; resetsAt?: number; resetDescription?: string }`
  - `interface CodexRateLimits { primary?: CodexRateLimitWindow; secondary?: CodexRateLimitWindow }`
  - `type CodexRateLimitReader = (deps: { homeDir?: string }) => Promise<CodexRateLimits>`
  - `parseCodexRateLimits(rl: CodexRateLimits): QuotaWindowWire[]`
  - `decodeJwtEmail(idToken: string | undefined): string | undefined`
  - `fetchCodexQuota(deps?: { homeDir?: string; now?: number; readImpl?: CodexRateLimitReader }): Promise<AgentQuotaWire>`
  - `readCodexRateLimitsViaAppServer: CodexRateLimitReader` (the real `codex app-server` spawn; not unit-tested — injected away in tests)

> **Verification note for the implementer:** `readCodexRateLimitsViaAppServer` drives `codex app-server` over newline-delimited JSON-RPC. The framing, the method name `account/rateLimits/read`, the params, and the `result.rateLimits.{primary,secondary}.{usedPercent,resetsAt,resetDescription}` shape MUST be confirmed against the installed `codex` during Task 5. The parser and the fetcher (with injected `readImpl`) are the unit-tested parts; the spawn function is deliberately isolated and swappable.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/quota-codex.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeJwtEmail, fetchCodexQuota, parseCodexRateLimits } from './quota-codex'

const now = Date.parse('2026-06-19T18:00:00.000Z')
const rl = {
  primary: { usedPercent: 30, resetsAt: 1_750_356_000, resetDescription: 'in 2h' },
  secondary: { usedPercent: 12, resetsAt: 1_750_700_000 },
}
function homeWithAuth(auth: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'podium-xq-'))
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify(auth))
  return home
}
const jwt = (claims: object): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

describe('parseCodexRateLimits', () => {
  it('maps primary→5h, secondary→weekly with unix→ISO reset', () => {
    const w = parseCodexRateLimits(rl)
    expect(w.map((x) => [x.key, x.usedPercent, x.windowMinutes])).toEqual([
      ['5h', 30, 300],
      ['weekly', 12, 10080],
    ])
    expect(w[0].resetsAt).toBe(new Date(1_750_356_000 * 1000).toISOString())
  })
})

describe('decodeJwtEmail', () => {
  it('extracts the email claim, undefined on garbage', () => {
    expect(decodeJwtEmail(jwt({ email: 'a@b.com' }))).toBe('a@b.com')
    expect(decodeJwtEmail('not-a-jwt')).toBeUndefined()
    expect(decodeJwtEmail(undefined)).toBeUndefined()
  })
})

describe('fetchCodexQuota', () => {
  it('is unauthenticated without auth.json', async () => {
    const home = mkdtempSync(join(tmpdir(), 'podium-xq-'))
    const r = await fetchCodexQuota({ homeDir: home, now, readImpl: async () => rl })
    expect(r).toMatchObject({ agent: 'codex', status: 'unauthenticated' })
  })

  it('returns ok windows + account email from the JWT', async () => {
    const home = homeWithAuth({ tokens: { id_token: jwt({ email: 'me@example.com' }) } })
    const r = await fetchCodexQuota({ homeDir: home, now, readImpl: async () => rl })
    expect(r.status).toBe('ok')
    expect(r.windows.map((w) => w.key)).toEqual(['5h', 'weekly'])
    expect(r.account?.email).toBe('me@example.com')
  })

  it('maps a reader throw to error', async () => {
    const home = homeWithAuth({ tokens: {} })
    const r = await fetchCodexQuota({
      homeDir: home, now,
      readImpl: async () => { throw new Error('app-server timed out') },
    })
    expect(r.status).toBe('error')
    expect(r.error).toContain('app-server')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/daemon/src/quota-codex.test.ts`
Expected: FAIL — `./quota-codex` has no exports.

- [ ] **Step 3: Write minimal implementation**

Create `apps/daemon/src/quota-codex.ts`:

```ts
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentQuotaWire, QuotaWindowWire } from '@podium/protocol'

export interface CodexRateLimitWindow {
  usedPercent?: number
  resetsAt?: number // unix seconds
  resetDescription?: string
}
export interface CodexRateLimits {
  primary?: CodexRateLimitWindow
  secondary?: CodexRateLimitWindow
}
export type CodexRateLimitReader = (deps: { homeDir?: string }) => Promise<CodexRateLimits>

const isoFromUnix = (s: number | undefined): string =>
  typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : ''
const pct = (p: number | undefined): number => (typeof p === 'number' && Number.isFinite(p) ? p : 0)

export function parseCodexRateLimits(rl: CodexRateLimits): QuotaWindowWire[] {
  const windows: QuotaWindowWire[] = []
  if (rl.primary) {
    windows.push({ key: '5h', label: '5-hour', usedPercent: pct(rl.primary.usedPercent), resetsAt: isoFromUnix(rl.primary.resetsAt), windowMinutes: 300 })
  }
  if (rl.secondary) {
    windows.push({ key: 'weekly', label: 'Weekly', usedPercent: pct(rl.secondary.usedPercent), resetsAt: isoFromUnix(rl.secondary.resetsAt), windowMinutes: 10_080 })
  }
  return windows
}

export function decodeJwtEmail(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined
  const parts = idToken.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { email?: string }
    return typeof payload.email === 'string' ? payload.email : undefined
  } catch {
    return undefined
  }
}

// Real reader: drive `codex app-server` over newline-delimited JSON-RPC. SHAPE
// UNVERIFIED — confirm against the installed codex (see plan verification note).
export const readCodexRateLimitsViaAppServer: CodexRateLimitReader = ({ homeDir } = {}) =>
  new Promise<CodexRateLimits>((resolve, reject) => {
    const env = { ...process.env, ...(homeDir ? { CODEX_HOME: join(homeDir, '.codex') } : {}) }
    const child = spawn('codex', ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'], env,
    })
    let buf = ''
    let settled = false
    const finish = (err: Error | null, val?: CodexRateLimits) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      if (err) reject(err)
      else resolve(val ?? {})
    }
    const timer = setTimeout(() => finish(new Error('codex app-server timed out')), 25_000)
    timer.unref?.()
    const send = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        if (!line) continue
        let msg: { id?: number; result?: { rateLimits?: CodexRateLimits } }
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })
        } else if (msg.id === 2) {
          finish(null, msg.result?.rateLimits ?? {})
        }
      }
    })
    child.on('error', (e) => finish(e))
    child.on('exit', () => finish(new Error('codex app-server exited early')))
  })

export async function fetchCodexQuota(
  deps: { homeDir?: string; now?: number; readImpl?: CodexRateLimitReader } = {},
): Promise<AgentQuotaWire> {
  const now = deps.now ?? Date.now()
  const base = { agent: 'codex' as const, windows: [] as QuotaWindowWire[], fetchedAt: new Date(now).toISOString() }
  const authPath = join(deps.homeDir ?? homedir(), '.codex', 'auth.json')
  let email: string | undefined
  try {
    const auth = JSON.parse(await readFile(authPath, 'utf8')) as { tokens?: { id_token?: string } }
    email = decodeJwtEmail(auth.tokens?.id_token)
  } catch {
    return { ...base, status: 'unauthenticated' }
  }
  const read = deps.readImpl ?? readCodexRateLimitsViaAppServer
  try {
    const rl = await read({ ...(deps.homeDir ? { homeDir: deps.homeDir } : {}) })
    return { ...base, status: 'ok', windows: parseCodexRateLimits(rl), ...(email ? { account: { email } } : {}) }
  } catch (e) {
    return { ...base, status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/daemon/src/quota-codex.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/agent-quota add apps/daemon/src/quota-codex.ts apps/daemon/src/quota-codex.test.ts
git -C .worktrees/agent-quota commit -m "feat(daemon): Codex plan-quota fetcher (app-server rateLimits)"
```

---

### Task 4: Quota dispatcher + per-agent TTL cache (daemon)

**Files:**
- Create: `apps/daemon/src/quota-fetch.ts`
- Test: `apps/daemon/src/quota-fetch.test.ts`

**Interfaces:**
- Consumes: `fetchClaudeQuota` (Task 2), `fetchCodexQuota` (Task 3), `AgentKind`/`AgentQuotaWire` (Task 1).
- Produces:
  - `type QuotaFetcher = (deps: { homeDir?: string; now?: number }) => Promise<AgentQuotaWire>`
  - `makeQuotaFetcher(opts?: { homeDir?: string; ttlMs?: number; now?: () => number; fetchers?: { agent: AgentKind; fetch: QuotaFetcher }[] }): { getAgentQuota(refresh?: boolean): Promise<AgentQuotaWire[]> }`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/quota-fetch.test.ts`:

```ts
import type { AgentKind, AgentQuotaWire } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { makeQuotaFetcher } from './quota-fetch'

const wire = (agent: AgentKind, status: AgentQuotaWire['status']): AgentQuotaWire => ({
  agent, status, windows: [], fetchedAt: '2026-06-19T18:00:00.000Z',
})

describe('makeQuotaFetcher', () => {
  it('aggregates all fetchers and isolates a thrown fetcher as error', async () => {
    const f = makeQuotaFetcher({
      fetchers: [
        { agent: 'claude-code', fetch: async () => wire('claude-code', 'ok') },
        { agent: 'codex', fetch: async () => { throw new Error('boom') } },
      ],
    })
    const r = await f.getAgentQuota()
    expect(r.map((x) => [x.agent, x.status])).toEqual([
      ['claude-code', 'ok'],
      ['codex', 'error'],
    ])
    expect(r[1].error).toContain('boom')
  })

  it('serves a cached value within TTL and refetches after it / on refresh', async () => {
    let t = 1000
    const spy = vi.fn(async () => wire('claude-code', 'ok'))
    const f = makeQuotaFetcher({ ttlMs: 100, now: () => t, fetchers: [{ agent: 'claude-code', fetch: spy }] })
    await f.getAgentQuota()           // miss → 1 call
    t = 1050
    await f.getAgentQuota()           // within TTL → cached
    expect(spy).toHaveBeenCalledTimes(1)
    await f.getAgentQuota(true)       // refresh bypasses cache
    expect(spy).toHaveBeenCalledTimes(2)
    t = 1200
    await f.getAgentQuota()           // TTL elapsed → refetch
    expect(spy).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/daemon/src/quota-fetch.test.ts`
Expected: FAIL — `./quota-fetch` has no exports.

- [ ] **Step 3: Write minimal implementation**

Create `apps/daemon/src/quota-fetch.ts`:

```ts
import type { AgentKind, AgentQuotaWire } from '@podium/protocol'
import { fetchClaudeQuota } from './quota-claude'
import { fetchCodexQuota } from './quota-codex'

export type QuotaFetcher = (deps: { homeDir?: string; now?: number }) => Promise<AgentQuotaWire>

const DEFAULT_FETCHERS: { agent: AgentKind; fetch: QuotaFetcher }[] = [
  { agent: 'claude-code', fetch: fetchClaudeQuota },
  { agent: 'codex', fetch: fetchCodexQuota },
]
const DEFAULT_TTL_MS = 60_000

export function makeQuotaFetcher(
  opts: { homeDir?: string; ttlMs?: number; now?: () => number; fetchers?: { agent: AgentKind; fetch: QuotaFetcher }[] } = {},
): { getAgentQuota(refresh?: boolean): Promise<AgentQuotaWire[]> } {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now
  const fetchers = opts.fetchers ?? DEFAULT_FETCHERS
  const cache = new Map<AgentKind, { atMs: number; wire: AgentQuotaWire }>()

  const one = async (f: { agent: AgentKind; fetch: QuotaFetcher }, refresh: boolean): Promise<AgentQuotaWire> => {
    const t = now()
    const cached = cache.get(f.agent)
    if (!refresh && cached && t - cached.atMs < ttl) return cached.wire
    let wire: AgentQuotaWire
    try {
      wire = await f.fetch({ ...(opts.homeDir ? { homeDir: opts.homeDir } : {}), now: t })
    } catch (e) {
      wire = { agent: f.agent, status: 'error', windows: [], error: e instanceof Error ? e.message : String(e), fetchedAt: new Date(t).toISOString() }
    }
    cache.set(f.agent, { atMs: t, wire })
    return wire
  }

  return {
    getAgentQuota: (refresh = false) => Promise.all(fetchers.map((f) => one(f, refresh))),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/daemon/src/quota-fetch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/agent-quota add apps/daemon/src/quota-fetch.ts apps/daemon/src/quota-fetch.test.ts
git -C .worktrees/agent-quota commit -m "feat(daemon): quota dispatcher with per-agent TTL cache + failure isolation"
```

---

### Task 5: Daemon control-message wiring + live verification

**Files:**
- Modify: `apps/daemon/src/daemon.ts` (import near line 80; instantiate + handler near the `runUsageScan` block around lines 1102 / 1131-1158)

**Interfaces:**
- Consumes: `makeQuotaFetcher` (Task 4), `agentQuotaRequest` control message + `agentQuotaResult` daemon message (Task 1), `send`/`hostname`/`opts.discovery.homeDir` (already in `daemon.ts`).
- Produces: the daemon now answers `agentQuotaRequest` with `agentQuotaResult`.

- [ ] **Step 1: Add the import**

In `apps/daemon/src/daemon.ts`, next to `import { scanClaudeUsage } from './usage-scan'` (line 80) add:

```ts
import { makeQuotaFetcher } from './quota-fetch'
```

- [ ] **Step 2: Instantiate the fetcher**

Just above the `const USAGE_MEMO_TTL_MS = 120_000` line (~1131), add:

```ts
// Per-agent plan-quota reader (live, read-only, TTL-cached). Same homeDir override
// the discovery scans use, so tests can point it at a fixture home.
const quotaFetcher = makeQuotaFetcher({
  ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
})
```

- [ ] **Step 3: Add the switch case**

In the control-message `switch`, right after the `case 'usageRequest': void runUsageScan(msg); break` block (~1102-1104), add:

```ts
      case 'agentQuotaRequest':
        void runAgentQuotaScan(msg)
        break
```

- [ ] **Step 4: Add the handler**

Immediately after the `runUsageScan` function (after line 1158), add:

```ts
  const runAgentQuotaScan = async (
    msg: Extract<ControlMessage, { type: 'agentQuotaRequest' }>,
  ): Promise<void> => {
    const agents = await quotaFetcher.getAgentQuota(msg.refresh ?? false)
    send({ type: 'agentQuotaResult', requestId: msg.requestId, hostname: hostname(), agents })
  }
```

- [ ] **Step 5: Typecheck the daemon package**

Run: `bun run typecheck`
Expected: PASS (no type errors). If `ControlMessage`/`DaemonMessage` unions complain, re-check Task 1's union registrations.

- [ ] **Step 6: Live-verify the real fetchers (manual, on this dev box)**

This confirms the two `VERIFICATION NOTE`s (Claude `utilization` scale; Codex app-server shape) against the installed CLIs. Run a throwaway script with Bun:

```bash
cd .worktrees/agent-quota
node_modules/.bin/tsx -e "import('./apps/daemon/src/quota-claude').then(async m => console.log('CLAUDE', JSON.stringify(await m.fetchClaudeQuota(), null, 2)))"
node_modules/.bin/tsx -e "import('./apps/daemon/src/quota-codex').then(async m => console.log('CODEX', JSON.stringify(await m.fetchCodexQuota(), null, 2)))"
```

Expected: each prints an `AgentQuotaWire`. Confirm:
- Claude `usedPercent` looks like a sane 0..100 (e.g. not 4250). If it reads ~100× too big, the live `utilization` is already a percent → in `quota-claude.ts` change `toPct` to `Math.round(u * 10) / 10` (drop the extra ×100) and update the Task 2 test's expected values, then re-run `npx vitest run apps/daemon/src/quota-claude.test.ts`.
- Codex returns `ok` with two windows. If it errors, inspect the framing/method by running `codex -s read-only -a untrusted app-server` manually and adjust `readCodexRateLimitsViaAppServer` (only that function) until the throwaway script prints `ok`.

- [ ] **Step 7: Commit**

```bash
git -C .worktrees/agent-quota add apps/daemon/src/daemon.ts apps/daemon/src/quota-claude.ts apps/daemon/src/quota-codex.ts apps/daemon/src/quota-claude.test.ts apps/daemon/src/quota-codex.test.ts
git -C .worktrees/agent-quota commit -m "feat(daemon): answer agentQuotaRequest; verify live Claude/Codex quota shapes"
```

---

### Task 6: Server relay method + tRPC route

**Files:**
- Modify: `apps/server/src/relay.ts` (type import; `pendingAgentQuota` map near line 71; `agentQuota()` after `usage()` at ~606; `agentQuotaResult` case after the `usageResult` case at ~1030)
- Modify: `apps/server/src/router.ts` (new `quota` router after the `usage` router at line 241)

**Interfaces:**
- Consumes: `daemonRequest` (private, `relay.ts:536`), `AgentQuotaWire` (Task 1), `agentQuotaRequest`/`agentQuotaResult` (Task 1).
- Produces: `SessionRegistry.agentQuota(refresh?: boolean): Promise<{ hostname: string; agents: AgentQuotaWire[] }>`; tRPC `quota.summary` query.

- [ ] **Step 1: Add the type import**

In `apps/server/src/relay.ts`, add `AgentQuotaWire` to the existing `@podium/protocol` type import (the one that already brings in `UsageBucketWire`).

- [ ] **Step 2: Add the pending map**

Right after the `pendingUsage` map (lines 71-74), add:

```ts
  private readonly pendingAgentQuota = new Map<
    string,
    (r: { hostname: string; agents: AgentQuotaWire[] }) => void
  >()
```

- [ ] **Step 3: Add the registry method**

Immediately after the `usage(sinceMs?)` method (after line 606), add:

```ts
  /** Per-agent plan-quota (5h/weekly windows), read live read-only on the daemon
   *  host. Empty agents on timeout. Distinct from `usage` (token-cost analytics). */
  agentQuota(refresh?: boolean): Promise<{ hostname: string; agents: AgentQuotaWire[] }> {
    return this.daemonRequest(
      this.pendingAgentQuota,
      'aq',
      20_000,
      () => ({ hostname: '', agents: [] }),
      (requestId) => ({
        type: 'agentQuotaRequest',
        requestId,
        ...(refresh !== undefined ? { refresh } : {}),
      }),
    )
  }
```

- [ ] **Step 4: Add the result case**

Immediately after the `case 'usageResult': { … break }` block (after line 1030), add:

```ts
      case 'agentQuotaResult': {
        const resolve = this.pendingAgentQuota.get(msg.requestId)
        if (resolve) {
          this.pendingAgentQuota.delete(msg.requestId)
          resolve({ hostname: msg.hostname, agents: msg.agents })
        }
        break
      }
```

- [ ] **Step 5: Add the tRPC route**

In `apps/server/src/router.ts`, immediately after the `usage` router block (after line 241), add:

```ts
  quota: t.router({
    // Per-agent plan-quota (5h/weekly % used + reset times), read live on the
    // daemon host from each agent's own usage endpoint. Distinct from `usage`,
    // which is transcript-harvested token-cost analytics.
    summary: t.procedure.query(({ ctx }) => ctx.registry.agentQuota()),
  }),
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS. The web package's `AppRouter` type now includes `quota.summary` (consumed in Task 8).

- [ ] **Step 7: Commit**

```bash
git -C .worktrees/agent-quota add apps/server/src/relay.ts apps/server/src/router.ts
git -C .worktrees/agent-quota commit -m "feat(server): relay.agentQuota + quota.summary tRPC route"
```

---

### Task 7: Frontend quota formatters

**Files:**
- Create: `apps/web/src/quota.ts`
- Test: `apps/web/src/quota.test.ts`

**Interfaces:**
- Consumes: `AgentKind`, `AgentQuotaWire` (Task 1).
- Produces:
  - `formatReset(resetsAt: string, nowMs: number): string`
  - `type QuotaTone = 'ok' | 'warn' | 'crit'`; `percentTone(p: number): QuotaTone`; `toneBarClass(t: QuotaTone): string`
  - `agentLabel(agent: AgentKind): string`
  - `statusNote(a: AgentQuotaWire): string`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/quota.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { agentLabel, formatReset, percentTone, statusNote } from './quota'

const now = Date.parse('2026-06-19T18:00:00.000Z')

describe('formatReset', () => {
  it('renders m / h m / d h, and edge cases', () => {
    expect(formatReset(new Date(now + 40 * 60_000).toISOString(), now)).toBe('resets in 40m')
    expect(formatReset(new Date(now + 134 * 60_000).toISOString(), now)).toBe('resets in 2h 14m')
    expect(formatReset(new Date(now + (28 * 60 + 5) * 60_000).toISOString(), now)).toBe('resets in 1d 4h')
    expect(formatReset(new Date(now - 5_000).toISOString(), now)).toBe('resetting…')
    expect(formatReset('', now)).toBe('')
  })
})

describe('percentTone', () => {
  it('buckets at 75 and 90', () => {
    expect(percentTone(74)).toBe('ok')
    expect(percentTone(75)).toBe('warn')
    expect(percentTone(90)).toBe('warn')
    expect(percentTone(90.1)).toBe('crit')
  })
})

describe('agentLabel / statusNote', () => {
  it('labels known agents and notes non-ok statuses', () => {
    expect(agentLabel('claude-code')).toBe('Claude Code')
    expect(agentLabel('codex')).toBe('Codex')
    expect(statusNote({ agent: 'codex', status: 'unauthenticated', windows: [], fetchedAt: '' })).toBe('Not signed in')
    expect(statusNote({ agent: 'codex', status: 'ok', windows: [], fetchedAt: '' })).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/src/quota.test.ts`
Expected: FAIL — `./quota` has no exports.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/quota.ts`:

```ts
import type { AgentKind, AgentQuotaWire } from '@podium/protocol'

/** "resets in 40m" / "resets in 2h 14m" / "resets in 1d 4h". */
export function formatReset(resetsAt: string, nowMs: number): string {
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t)) return ''
  const ms = t - nowMs
  if (ms <= 0) return 'resetting…'
  const mins = Math.round(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `resets in ${d}d ${h}h`
  if (h > 0) return `resets in ${h}h ${m}m`
  return `resets in ${m}m`
}

export type QuotaTone = 'ok' | 'warn' | 'crit'
export function percentTone(p: number): QuotaTone {
  if (p > 90) return 'crit'
  if (p >= 75) return 'warn'
  return 'ok'
}
export function toneBarClass(t: QuotaTone): string {
  return t === 'crit' ? 'bg-red-500' : t === 'warn' ? 'bg-amber-500' : 'bg-emerald-500'
}

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  shell: 'Shell',
}
export function agentLabel(agent: AgentKind): string {
  return AGENT_LABELS[agent] ?? agent
}

export function statusNote(a: AgentQuotaWire): string {
  switch (a.status) {
    case 'unauthenticated':
      return 'Not signed in'
    case 'expired':
      return a.error ?? 'Token expired'
    case 'error':
      return a.error ?? 'Unavailable'
    default:
      return ''
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/src/quota.test.ts`
Expected: PASS (3 describe blocks).

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/agent-quota add apps/web/src/quota.ts apps/web/src/quota.test.ts
git -C .worktrees/agent-quota commit -m "feat(web): quota formatting helpers (reset countdown, tone, labels)"
```

---

### Task 8: QuotaView + sidebar button + view wiring + runtime verification

**Files:**
- Create: `apps/web/src/QuotaView.tsx`
- Modify: `apps/web/src/store.tsx` (`MainView` type line 107; `readStoredView` validation line 146)
- Modify: `apps/web/src/Sidebar.tsx` (lucide import line 14; new tools-row button after the Usage button at ~223)
- Modify: `apps/web/src/AppShell.tsx` (import line ~17; render branch at ~97)
- Modify: `apps/web/src/MobileApp.tsx` (import line ~36; render branch at ~284)

**Interfaces:**
- Consumes: `trpc.quota.summary` (Task 6), `agentLabel`/`formatReset`/`percentTone`/`toneBarClass`/`statusNote` (Task 7), `useStore`, `Button`, `AgentQuotaWire`.
- Produces: a `'quota'` `MainView` reachable from the sidebar tools row on desktop and mobile.

- [ ] **Step 1: Extend `MainView` and the persisted-view guard**

In `apps/web/src/store.tsx` line 107, change:

```ts
export type MainView = 'home' | 'workspace' | 'settings' | 'usage' | 'quota'
```

In `readStoredView` (line 146), change the return to include `'quota'`:

```ts
  return v === 'home' || v === 'workspace' || v === 'settings' || v === 'usage' || v === 'quota'
    ? v
    : 'home'
```

- [ ] **Step 2: Create the view**

Create `apps/web/src/QuotaView.tsx`:

```tsx
import type { AgentQuotaWire } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { agentLabel, formatReset, percentTone, statusNote, toneBarClass } from './quota'
import { useStore } from './store'

/**
 * Agent quota — a full main-content surface (not a modal): live plan-quota usage
 * per agent (Claude 5h+weekly, Codex 5h+weekly), read read-only on the daemon
 * host. Distinct from Usage & analytics, which shows transcript-harvested token
 * cost. Reached from the sidebar tools row.
 */
export function QuotaView(): JSX.Element {
  const { trpc, setView } = useStore()
  const [agents, setAgents] = useState<AgentQuotaWire[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      trpc.quota.summary
        .query()
        .then((r) => {
          if (!cancelled) setAgents(r.agents)
        })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [trpc])

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Agent quota">
      <div className="flex items-center justify-between border-b border-border px-[22px] py-3.5">
        <h2 className="m-0 text-base font-medium text-foreground">Agent quota</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Close agent quota"
          onClick={() => setView('home')}
        >
          ✕
        </Button>
      </div>
      {agents === null ? (
        <div className="px-4 py-3.5 text-xs text-muted-foreground/70">Loading quota…</div>
      ) : agents.length === 0 ? (
        <div className="px-4 py-3.5 text-xs text-muted-foreground/70">
          No agents reported quota (daemon offline?).
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
          {agents.map((a) => (
            <AgentQuotaCard key={a.agent} a={a} />
          ))}
          <p className="mt-1 mb-0.5 max-w-[60ch] text-xs text-muted-foreground">
            Read live from each agent's own usage endpoint on the dev machine. Percentages are the
            share of each rolling plan window consumed. Grok is omitted — it exposes no local quota.
          </p>
        </div>
      )}
    </section>
  )
}

function AgentQuotaCard({ a }: { a: AgentQuotaWire }): JSX.Element {
  const now = Date.now()
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">{agentLabel(a.agent)}</div>
        {a.account?.email ? (
          <div className="text-[11px] text-muted-foreground/70">
            {a.account.email}
            {a.account.plan ? ` · ${a.account.plan}` : ''}
          </div>
        ) : null}
      </div>
      {a.status !== 'ok' ? (
        <div className="mt-1.5 text-xs text-muted-foreground/70">{statusNote(a)}</div>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {a.windows.map((w) => (
            <div key={w.key}>
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{w.label}</span>
                <span className="text-foreground">
                  {Math.round(w.usedPercent)}% · {formatReset(w.resetsAt, now)}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className={`h-full rounded-full ${toneBarClass(percentTone(w.usedPercent))}`}
                  style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Add the sidebar tools-row button**

In `apps/web/src/Sidebar.tsx`, add `Gauge` to the `lucide-react` import (the block ending at line 14). Then, immediately after the closing `</Button>` of the Usage button (line 223), insert:

```tsx
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'border border-input text-muted-foreground hover:border-primary hover:text-foreground',
            view === 'quota' && 'border-primary bg-secondary text-foreground',
          )}
          aria-pressed={view === 'quota'}
          title="Agent quota"
          onClick={() => setView('quota')}
        >
          <Gauge size={15} aria-hidden="true" />
        </Button>
```

- [ ] **Step 4: Wire the render branches**

In `apps/web/src/AppShell.tsx`: add `import { QuotaView } from './QuotaView'` next to the `UsageView` import (~line 17). Then change the view switch (the `view === 'usage' ? (<UsageView />)` branch at ~97-98) to add a `quota` branch right after it:

```tsx
      ) : view === 'usage' ? (
        <UsageView />
      ) : view === 'quota' ? (
        <QuotaView />
      ) : (
```

In `apps/web/src/MobileApp.tsx`: add `import { QuotaView } from './QuotaView'` next to its `UsageView` import (~line 36), and the same `quota` branch right after its `view === 'usage'` branch (~284-285):

```tsx
        ) : view === 'usage' ? (
          <UsageView />
        ) : view === 'quota' ? (
          <QuotaView />
        ) : paneA ? (
```

- [ ] **Step 5: Typecheck + lint + full test suite**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run lint`
Expected: PASS (fix any Biome findings in the new files).

Run: `npx vitest run packages/protocol apps/daemon apps/web`
Expected: PASS — all new and existing tests green.

- [ ] **Step 6: Runtime verification in a real browser (REQUIRED — do not skip)**

UI work in this repo must be verified with real interaction, not just build/typecheck (per project memory). Build the web and drive it:

```bash
cd .worktrees/agent-quota
bun install   # only if deps changed; usually a no-op
bun run --filter @podium/web build
```

Then either (a) start a worktree-local host on non-default ports and click through, or (b) use the committed Playwright harness (`npx playwright test`, see `e2e/`). Confirm, with the daemon running so the tRPC call resolves:
- The new **Gauge** button appears in the sidebar tools row and is `aria-pressed` when active.
- Clicking it switches the main surface to "Agent quota".
- Claude + Codex cards render with two bars each; percentages and reset countdowns look sane; bar colors follow the 75/90 thresholds.
- A signed-out / error agent shows its inline note (e.g. "Not signed in") and does NOT blank the whole view.
- **Do NOT redeploy the live `main` checkout** to test — run from the worktree or the harness.

- [ ] **Step 7: Commit**

```bash
git -C .worktrees/agent-quota add apps/web/src/QuotaView.tsx apps/web/src/store.tsx apps/web/src/Sidebar.tsx apps/web/src/AppShell.tsx apps/web/src/MobileApp.tsx
git -C .worktrees/agent-quota commit -m "feat(web): Agent quota view + sidebar tool + desktop/mobile wiring"
```

---

## Follow-ups (non-blocking, out of scope for this plan)

- **Populate `account` for Claude** (email/plan) — would need a `claude auth status --json` call or a JWT decode of a Claude token; deferred to avoid an extra spawn. Codex email is already populated from its `auth.json` JWT.
- **True TTL-bypassing manual refresh** — the route already accepts `refresh` on `relay.agentQuota`; wire a `quota.summary` input + a Refresh button if users want to force a re-read.
- **Add Grok / other agents** — drop in a new fetcher module + an `AgentKind` entry; no schema change.

## Self-Review

- **Spec coverage:** scope (Claude+Codex, Grok skipped) → Tasks 2/3 + omission; daemon read-only fetchers → Tasks 2–5; protocol → Task 1; relay+route → Task 6; frontend view+sidebar+helpers → Tasks 7–8; per-agent error isolation → Tasks 4/7/8; caching/refresh → Task 4 + Task 8 poll; testing → Tasks 1–4,7 unit + Task 5/8 verification; worktree + deploy-together + read-only invariant → Global Constraints. All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; the two "verification notes" carry explicit live-check steps with concrete fix instructions (Task 5 Step 6), not hand-waving.
- **Type consistency:** `AgentQuotaWire`/`QuotaWindowWire` field names, `status` enum, and `'claude-code'`/`'codex'` `AgentKind` values are identical across protocol, fetchers, dispatcher, relay, route, helpers, and view. `getAgentQuota(refresh?)`, `agentQuota(refresh?)`, and the `agentQuotaRequest`/`agentQuotaResult` message names match across Tasks 1, 4, 5, 6.
