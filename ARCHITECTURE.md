# Architecture

Podium is a Bun-workspace monorepo. Design rationale lives in
`docs/internal/superpowers/specs/2026-06-01-monorepo-design.md`; this file is the day-to-day map.

## Runtime topology

- **`apps/server`** — API / web backend (Hono + tRPC). Can run apart from dev machines.
- **`apps/daemon`** — installed on each dev machine; wraps agent CLIs and streams PTYs.
- **`apps/web`** — responsive web UI (mobile-first), talks to the server.
- Later: cloud sandboxes for agents.

## Packages

`@podium/agent-bridge` (server-side) and `@podium/terminal-client` (browser) are the two
standalone libraries. They never depend on each other — they meet only through
`@podium/protocol`. This keeps the PTY layer and browser DOM code out of the same
package and lets each release independently.

## Dependency direction

```
@podium/web              ->  @podium/terminal-client, @podium/client-core, @podium/runtime
@podium/web              ~>  @podium/server   (type-only AppRouter; planned, no runtime dep)
@podium/server           ->  @podium/runtime, @podium/model, @podium/protocol
@podium/server           ->  @podium/commands, @podium/sync
@podium/daemon           ->  @podium/agent-bridge, @podium/protocol, @podium/runtime
@podium/client-core      ->  @podium/protocol, @podium/model, @podium/runtime, @podium/terminal-client
@podium/agent-bridge     ->  @podium/protocol
@podium/terminal-client  ->  @podium/protocol
@podium/protocol         ->  (leaf — no internal deps)
@podium/model           ->  (leaf — no internal deps, no @podium/protocol dep either)
@podium/commands         ->  @podium/model, @podium/protocol (L1 contracts only)
@podium/runtime          ->  @podium/protocol, @podium/model (near-leaf; nothing else)
```

- Apps depend on packages, never the reverse.
- No app→app runtime dependency; `apps/web` imports only the `AppRouter` *type* from
  `apps/server`.
- `@podium/protocol` and `@podium/model` are leaf packages. `@podium/runtime` is a
  near-leaf: it may depend only on those two leaves.

### Server role tiers: core → hub → cloud

One server codebase, composed by role (`docs/offline-sync-architecture.md` §4). Inside
`apps/server/src` the grouping is by directory, declared in `src/roles.ts`:

- **core** — everything a single-user node needs (store, registry/relay, sessions, sync
  incl. *dialing* an upstream hub, search, web-serving, transcripts, issues, login auth).
  Everything outside `src/hub/` is core.
- **hub** (`src/hub/`) — only for the rendezvous role: inbound daemon pairing, fleet admin,
  join-command minting. May import core freely; **core never imports hub**. The composition
  roots (`index.ts`, `server.ts`, `router.ts`) and test files are the declared exemptions —
  they activate hub surfaces per the runtime role config (`startServer({ role })`; default:
  hub on, unless `config.upstream` marks the process a node).
- **cloud** — the private SaaS module (tenancy, billing, managed agents). Lives in a
  separate repo; **nothing in this repo imports it** (`cloud/` paths are banned outright).
  It composes in at build time through the plugin seam: `startServer({ plugins })` with
  `PodiumPlugin.register({ hono, modules, bus, config, role })` (`src/plugins.ts`) — route
  registration plus typed access to the composed modules; the OSS build ships no plugins.

Enforced by `bun run lint:boundaries` (`scripts/check-boundaries.ts`, rule 6) and the
server's own `src/hub/import-boundary.test.ts`, both reading the `src/roles.ts` manifest.

## What goes where

| Working on… | Lives in… |
|-------------|-----------|
| PTY/tmux spawn, attach, resize, kill | `@podium/agent-bridge` |
| Harness / recent-conversation / project / worktree discovery | `@podium/agent-bridge` (used by `apps/daemon`) |
| Agent state detection (provider interface, reducer, per-agent providers) | `@podium/agent-bridge` `src/agent-state/`; HTTP hook ingest + spawn injection in `apps/daemon` |
| Browser↔server message types (input, output frame, resize, takeover, transcript) | `@podium/protocol` |
| xterm.js, mobile key toolbar, touch/scroll policy, reconnect | `@podium/terminal-client` |
| Pure domain logic (issue stage machine, authz, snooze/defer, worktree/machine identity, session dedup + priority) | `@podium/model` |
| Versioned command contracts (policy, exposure, offline class, redaction, ownership/attribution declarations); no feature handlers | `@podium/commands` |
| Command handlers and transport derivation | Feature-owned `apps/server/src/modules/*/registry.ts` + `trpc.ts`, joined at the server composition root |
| Node-runtime plumbing (config, sqlite shims, git identity, connectivity, auth-store, …) | `@podium/runtime` |
| tRPC routers, auth, persistence, conversation index, daemon fan-out | `apps/server` |
| Typed in-process event bus (module→module signals) | `apps/server` `src/modules/bus.ts` |
| THE write funnel — authorize → repo write → oplog append → broadcast; owns the metadata oplog | `apps/server` `src/modules/funnel.ts` (every publish pipeline ends here; issue mutations enter via `funnel.run`) |
| Wire message sync-class taxonomy (durable / live / command / bulk; total over Client/Server/Control/DaemonMessage) | `@podium/protocol` `src/messages/message-class.ts` |
| Session lifecycle, PTY frame relay, client/daemon ws data planes, queued sends, coalesced broadcast | `apps/server` `src/modules/sessions/` |
| Daemon sockets/pairing/auth, machine admin + routing; daemon request/response plumbing | `apps/server` `src/modules/machines/` (`service.ts`, `rpc.ts`) |
| The issue tracker itself (`IssueService`: CRUD + stage machine, reads/reports, archive/drafts, mail, git workflow + assistant) | `apps/server` `src/modules/issues/service/` (seam-per-file class chain) |
| Issue wire publishing, hub-issue mirror + write forwarding, daemon relay gate, in-process issue command surface (router-equal authz) | `apps/server` `src/modules/issues/` |
| Conversation index + upstream mirror + transcript lake | `apps/server` `src/modules/conversations/` |
| Host health, auto-hibernate, memory breakdown | `apps/server` `src/modules/hosts/` |
| Attention notifications (ntfy/telegram/in-app) | `apps/server` `src/modules/notify/` |
| Settings, model catalog, telegram setup | `apps/server` `src/modules/settings/` |
| Headless (PTY-less) harness sessions | `apps/server` `src/modules/superagent/` |
| Hub-only modules (inbound daemon pairing, join command) + the core/hub/cloud role manifest | `apps/server` `src/hub/`, `src/roles.ts` |
| Cloud/private extension seam (`PodiumPlugin`: Hono route registration + module/bus access) | `apps/server` `src/plugins.ts` (composed via `startServer({ plugins })`) |
| Module composition (acyclic, dependency order: bus → machines/rpc → settings/notify/hosts → issues wire → sessions → conversations → issues → commands) + the facade older callers hold | `apps/server` `src/relay.ts` (`SessionRegistry`; router procs use the typed `ctx.modules` seam instead) |
| React screens, command-center grid, modes | `apps/web` |
| Per-machine agent lifecycle + discovery orchestration | `apps/daemon` |
| Shared TS config | `tooling/tsconfig` |
| Design/architecture docs | `docs/` |

### Phase-3 command surface as built

Most mutation families are derived from `@podium/commands` contracts into the server's
tRPC surface; feature handlers stay with their L3 modules. The current repository-wide
census still allowlists two hand-written mutations in `apps/server/src/router.ts`:
`settings.set` and `discovery.scan`. The Phase-3 exit audit also still reports transport
reach-throughs, so the universal-write-surface cut is not yet complete.

For the session `CommandDef` family, the source gate now requires both `visibility` and
`exposure` declarations. Their runtime accessors remain independently default-closed to
`personal` and served-nowhere; POD-424 proved both directions by mutating the real contract
and both live fallback helpers.

The multi-user policy vocabulary exists in the model and command contracts (visibility
classes, owner/grant scopes, attribution pairs, machine verbs, default-closed exposure),
but the production authentication edge still resolves human tRPC/MCP calls through the
single shared-password first-admin `OPERATOR`. Mail and workflow composition retain named
single-user ceiling/machine-access defaults. Share/unshare commands and their rescope
emitter do not exist yet; superagent and automation persistence is not owner-scoped; and
system jobs do not yet construct system principals for their writes. Telegram binding is
the exception: inbound chats resolve through the claim-code binding or are refused, while
the bot token remains server-only.

The browser's flag-off engine classifies definitive outbox refusals and persists them in
the replica's third, non-drainable `outbox-dead-letter` collection. Its rendered recovery
component is mounted in `HostIndicators`. The as-built last hop is currently broken:
POD-424 drove a real HTTP 400 through the isolated Playwright harness and observed the
correct durable `invalid` record, while the recovery chip remained absent both live and
after reload. Focused outbox and component suites stay green because they do not cross
that engine/replica-to-render boundary; POD-1287 owns the repair.

These are current-state facts, not deferred architecture. The authoritative gate record
and remediation boundary are in `docs/gates/pod-424-phase-3-exit-gate.md`.

## Growth path (not yet scaffolded)

- `apps/mobile` — Expo / React Native (+ RN Web).
- `apps/desktop` — Tauri shell.
- Cloud-sandbox orchestrator service.
- `@podium/ui` — shared design system once web + native both consume it.
- `@podium/terminal-client-react` — React adapter split out of `terminal-client`.
- `@podium/conversation-index` — hybrid search over indexed sessions.
- TS project references + Turborepo caching, and a `@podium/source` export condition for
  source-level cross-package imports, added when build/typecheck time or imports warrant.

## Toolchain

Bun (package manager / task runner / bundler / **runtime** — `server`/`daemon` run on Bun from
source via the `@podium/source` condition; the PTY backend is runtime-selected, so `Bun.Terminal`
is used under Bun and `node-pty` is never loaded) · Node 22 only for the legacy `tsx`/single-binary
paths · TypeScript ESM-only · Biome (lint+format) · Vitest · tsup (library builds) · Changesets
(releases). Cross-workspace tasks run via `bun run --filter`.
