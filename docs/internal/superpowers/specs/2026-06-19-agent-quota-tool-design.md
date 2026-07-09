# Agent Quota Tool — Design

**Date:** 2026-06-19
**Branch / worktree:** `feat/agent-quota-tool` → `.worktrees/agent-quota`
**Status:** Approved design, pending implementation plan

## Problem

Podium hosts multiple AI coding agents (Claude Code, Codex, Grok, …). Each runs
against a subscription plan with rate-limit windows (Claude: 5-hour + weekly;
Codex: ~5-hour + weekly). Users have no way to see, from inside Podium, how close
they are to those limits or when they reset. They currently learn they are
throttled only when an agent stalls mid-turn.

We want a new status-bar tool that shows **plan-quota usage per agent** — percent
of each rolling window consumed, plus the reset time — so a user can glance at it
and know whether they have headroom.

## Non-goals

- **Token-cost analytics.** The existing **Usage** view (`UsageView.tsx`,
  `usage.summary`) already shows tokens burned and API-equivalent dollar cost,
  harvested from harness transcripts. This tool is *not* that. It shows
  **rate-limit quota** (percent-of-plan + reset windows), which is a distinct
  concept with a distinct data source. The two views coexist.
- **Mutating agent credentials.** We never refresh-and-write-back an agent's
  credential file (see "Credential handling").
- **Grok quota.** Researched and deliberately out of scope (see "Grok").

## Scope of agents

| Agent | Quota source | Included? |
|---|---|---|
| **Claude** | OAuth usage API — `five_hour` + `seven_day` windows | ✅ |
| **Codex** | `app-server` `account/rateLimits/read` — `primary` + `secondary` | ✅ |
| **Grok** | None locally readable | ❌ skip |

### Grok

Per the integration reference (`docs/agent-harness-reference/grok.md` §5) and an
online research pass, Grok exposes **no account quota locally** — no file, no
subcommand. The only quota readouts that exist are browser extensions that scrape
`grok.com` / the xAI API console (e.g. "Grok Rate Limit Checker", "Grok Usage
Watch"), and those are widely reported as unreliable. `ccusage` is Claude-only.
There is therefore no clean, daemon-readable source, so Grok is **skipped**. The
data model is built so Grok (or any other agent) slots in later if a source
appears — adding an agent is a new fetcher module plus an `AgentKind` entry, no
schema change.

## Architecture (Approach A)

Live quota reads happen in the **daemon**, not the server or the browser, because:

1. The agent credential files (`~/.claude/.credentials.json`, `~/.codex/auth.json`)
   live on the agent host, which is the daemon's host — the same reason transcript
   harvesting already lives there.
2. It preserves the deliberate server/daemon process split (per-agent host work
   belongs in the daemon; the coordinating server must not be starved by it).
3. It is multi-machine-ready: each daemon reports its own host's quota, tagged by
   `hostname`, exactly like the existing `usage` flow.

This mirrors the existing **Usage** path end-to-end:

```
Sidebar button → setView('quota') → QuotaView.tsx
  → trpc.quota.summary.query()
    → router.ts  quota.summary  → ctx.registry.agentQuota()
      → relay.ts  agentQuota()  → daemonRequest('aq', …)
        → daemon  agentQuotaRequest handler
          → quota/index.ts dispatch → quota/claude.ts, quota/codex.ts
          → agentQuotaResult { hostname, agents[] }
```

### Rejected alternatives

- **B — Server fetches directly (skip daemon).** Fewer moving parts, but breaks the
  server/daemon split, won't work multi-machine, and puts per-agent host work back
  on the coordinating process. Rejected.
- **C — Derive quota from harvested transcript tokens.** No network/creds, but local
  token counts cannot yield plan *limits* or *reset windows*, so it cannot produce
  the 5h/weekly *percentages* the feature requires. Rejected.

## Data sources (daemon, read-only)

### Claude

- Read the bearer token from `~/.claude/.credentials.json`
  (`claudeAiOauth.accessToken`, with `expiresAt`).
- `GET https://api.anthropic.com/api/oauth/usage`
  - headers: `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
    `user-agent: claude-code/2.1.0`.
  - response: `{ five_hour: {utilization, resets_at}, seven_day: {utilization, resets_at} }`.
- Map `utilization` → `usedPercent`, `resets_at` → `resetsAt`, window minutes
  300 / 10080.

### Codex

- Spawn `codex -s read-only -a untrusted app-server`; perform the JSON-RPC
  handshake `initialize` → `initialized`, then call `account/rateLimits/read`;
  read `{ rateLimits: { primary, secondary } }`, each
  `{ usedPercent, resetsAt, resetDescription }`; then terminate the process.
- `primary` → 5h window, `secondary` → weekly window.
- Spawning app-server naturally self-refreshes the Codex OAuth token, so no manual
  refresh is needed on this path.
- **Fallback (documented, not primary):** `GET https://chatgpt.com/backend-api/wham/usage`
  with `Authorization: Bearer <access_token>` + `ChatGPT-Account-Id: <account_id>`
  from `~/.codex/auth.json`. Its response shape is unverified; keep as fallback only.
- **Implementation note:** verify the live `account/rateLimits/read` response shape
  against the installed `codex` during implementation before finalizing the parser.

### Credential handling (read-only invariant)

We **never** refresh-and-write-back a credential file. Claude's refresh token is
single-use/rotating; writing it back out-of-band could corrupt the live CLI's
credentials or burn the token. So:

- If the Claude token is expired (`expiresAt` passed) or the API returns 401, the
  agent's status is `expired` — surfaced as "token expired (refreshes on next
  Claude use)", not an error, and not something we try to fix.
- Codex refresh is owned by the spawned app-server itself (it reads/writes its own
  `auth.json` as the CLI normally would), which is acceptable because it is the
  CLI doing its own refresh, not us.

### Caching / freshness

- The daemon caches each agent's result with a short TTL (~60s) so polling does not
  hammer the Claude endpoint or repeatedly spawn `codex app-server`.
- A cache entry stores the last successful `AgentQuotaWire` plus a timestamp; on a
  request, fresh entries are returned directly and stale ones trigger a refetch.
- The frontend fetches on view-open, polls every ~60s, and offers a manual Refresh
  button (which bypasses the frontend interval but still respects the daemon TTL).

## Protocol

New wire types in `packages/protocol/src/messages.ts`:

```ts
// One rolling rate-limit window.
QuotaWindowWire = {
  key: '5h' | 'weekly',
  label: string,            // human label e.g. "5-hour" / "Weekly"
  usedPercent: number,      // 0..100
  resetsAt: string,         // ISO 8601
  windowMinutes: number,    // 300 | 10080
}

// One agent's quota snapshot. Agents are independent — one failing never
// blocks the others.
AgentQuotaWire = {
  agent: AgentKind,         // 'claude' | 'codex' (reuse existing AgentKind)
  status: 'ok' | 'unauthenticated' | 'expired' | 'error',
  account?: { email?: string, plan?: string },
  windows: QuotaWindowWire[],
  error?: string,           // short human message when status !== 'ok'
  fetchedAt: string,        // ISO 8601 of the underlying read
}

AgentQuotaRequestMessage  = { type: 'agentQuotaRequest', requestId, refresh?: boolean }
AgentQuotaResultMessage   = { type: 'agentQuotaResult',  requestId, hostname, agents: AgentQuotaWire[] }
```

`status` values:
- `ok` — creds present, fetch succeeded, `windows` populated.
- `unauthenticated` — no credential file / not signed in.
- `expired` — token present but expired/401 (read-only, we don't refresh).
- `error` — network/endpoint/parse failure; `error` carries a short message.

## Backend

- **`apps/server/src/relay.ts`** — add `agentQuota(refresh?: boolean): Promise<{ hostname; agents: AgentQuotaWire[] }>`
  using the existing `daemonRequest` helper with a new `'aq'` channel, ~20s
  timeout, empty-agents fallback, mirroring `usage()`.
- **`apps/server/src/router.ts`** — add a `quota` sub-router:
  `quota: t.router({ summary: t.procedure.query(({ ctx }) => ctx.registry.agentQuota()) })`,
  mirroring `usage.summary`.
- **Daemon** — register an `agentQuotaRequest` handler (alongside the existing
  usage-harvest request handler) that dispatches to a new `quota/` module and
  replies with `agentQuotaResult`. The plan phase locates the exact daemon source
  file (the same handler site as the `usageRequest` → transcript-harvest path).
- **`quota/` (new daemon module, colocated with the usage harvester):**
  - `claude.ts` — `fetchClaudeQuota(): Promise<AgentQuotaWire>` (HTTP read + parse).
  - `codex.ts` — `fetchCodexQuota(): Promise<AgentQuotaWire>` (app-server spawn + RPC + parse).
  - `index.ts` — dispatcher: a registry of `{ agent, fetcher }`, TTL cache, runs
    enabled fetchers concurrently, isolates failures per agent, returns
    `AgentQuotaWire[]`.

Each fetcher is a pure-ish function over its I/O: given the credential read and the
network/RPC response, it returns an `AgentQuotaWire`. Failures resolve to a wire
object with the appropriate `status`, never a thrown rejection that aborts the
batch.

## Frontend

- **`apps/web/src/store.tsx`** — `MainView` gains `'quota'`.
- **`apps/web/src/Sidebar.tsx`** — add a tools-row `Button` (lucide `Gauge` icon,
  15px) following the exact pattern of the existing Usage button: `setView('quota')`,
  `aria-pressed`, active-state styling, `title="Agent quota"`.
- **`apps/web/src/QuotaView.tsx` (new)** — fetch on mount + ~60s poll + manual
  Refresh; render one `Card` per agent:
  - header: agent name + account email/plan (when present) + last-updated.
  - per window (5h, weekly): labeled progress bar with `usedPercent`, a numeric
    percent, and a reset countdown ("resets in 2h 14m").
  - color thresholds: green < 75%, amber 75–90%, red > 90%.
  - graceful states: `unauthenticated` → "Not signed in"; `expired` → "Token
    expired (refreshes on next use)"; `error` → short message. One agent's failure
    renders an inline state on its card only.
- **`apps/web/src/quota.ts` (new)** — formatting helpers: `formatReset(resetsAt)`
  countdown, `percentColor(p)` threshold bucket, `formatPercent`. Pure functions.
- Styling reuses the shadcn `Card` + simple bar pattern already used by
  `UsageView`; no new design system primitives unless a reusable `Progress` bar is
  warranted (decide during implementation; a plain div bar is acceptable).

## Error handling

- Per-agent isolation everywhere: a failed Claude read shows an error card while
  Codex still renders normally.
- Daemon read timeouts and RPC failures resolve to `status: 'error'`, never crash
  the handler.
- `relay.agentQuota` keeps the existing `daemonRequest` timeout + empty fallback so
  the tRPC call always resolves (possibly with zero agents) and the view shows a
  neutral "no data / daemon offline" state rather than hanging.
- Frontend never throws on a partial/empty payload; missing agents simply don't
  render.

## Testing

- **Parser unit tests (vitest):**
  - `quota/claude.ts` — sample `oauth/usage` JSON → expected `AgentQuotaWire`
    (ok / 401-expired / missing-creds cases).
  - `quota/codex.ts` — sample `account/rateLimits/read` JSON → expected
    `AgentQuotaWire`; spawn/RPC failure → `status: 'error'`.
- **Formatter unit tests:** `quota.ts` — `formatReset` (future/past/edge),
  `percentColor` threshold buckets.
- **Dispatcher test:** `quota/index.ts` — one fetcher throwing leaves the other's
  result intact; TTL cache returns cached value within the window.
- Follow existing repo vitest conventions; mock all I/O (HTTP, child process, fs).

## Rollout / operational notes

- All work in the `feat/agent-quota-tool` worktree; never edit the live `main`
  checkout (it is the running backend's source).
- New protocol message types mean the **web and backend must be deployed together**
  (a stale Vite serving the old `@podium/protocol` would silently drop the new
  message types). Standard for this repo.
- No new runtime dependencies expected (HTTP via the platform fetch already in use;
  child-process spawn for Codex via existing tooling).

## Open implementation questions (resolve during build, not blocking)

- Exact live shape of Codex `account/rateLimits/read` — verify against the installed
  `codex` and adjust the parser.
- Whether to add a reusable shadcn `Progress` component or keep an inline bar.
- Codex app-server spawn time under a bloated `logs_2.sqlite`; the TTL cache +
  timeout + graceful `error` state already bound the worst case.
