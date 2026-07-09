# Podium Tracker → beads Parity (native) — Design

- **Date:** 2026-06-30
- **Branch / worktree:** `worktree-tracker-beads-parity`
- **Status:** Approved design, pending spec review → implementation plan

## 1. Goal

Bring the issue-tracker capabilities of **beads (`bd`)** natively into Podium's own
Issues subsystem, so Podium becomes a full-featured tracker that **agents can drive
from a CLI / MCP** the same way they use `bd` today — without depending on `bd`,
Dolt, or any external store.

Three capability groups are in scope (user-selected), plus a CLI + MCP front-end:

1. **Rich fields** — priority, issue type, labels, assignee, acceptance/design/notes, comments.
2. **Dependencies + ready + hierarchy** — typed dependency graph, cycle detection,
   ready/blocked computation, epics with parent/child children.
3. **Lifecycle, hygiene & search** — defer/supersede/duplicate/stale/orphans/lint/preflight,
   search/filter/count/stats/doctor.
4. **`podium` CLI + MCP** — a single CLI (mirroring `bd` verbs) that is the base for a
   single MCP server, **role-gated** so not every agent can do everything.

## 2. Non-goals (explicitly out of scope for v1)

- **Orchestration engine** — formulas → molecules → swarms → gates / merge-slots (deselected).
- **Dolt-based versioned sync / federation / `refs/dolt/data`** — native uses Podium's
  existing SQLite store and its multi-machine persistence; there is no second DB.
- **External-tracker bridges** beyond the existing Linear link (no Jira/GitHub/GitLab/ADO/Notion sync).
- **AI duplicate detection** — v1 ships mechanical (Jaccard) similarity only.
- **Full query mini-language parser** — v1 ships structured flag filters; the parser is a stretch (P4).
- **History GC / compact / flatten** — Podium keeps no Dolt commit history to compact.
- **Audit log, persistent agent "memory"** — agents already have their own; not part of the tracker.

A one-shot importer from the repo's existing `.beads/issues.jsonl` is a possible P4 stretch, not required.

## 3. Settled architecture decisions

| Decision | Choice |
| --- | --- |
| Capability source | **Native** re-implementation in Podium's SQLite. No `bd`/Dolt dependency. |
| Where logic lives | **The server.** CLI + MCP are thin **online** clients of the running server's tRPC API (single source of truth → live web-UI updates for free). |
| MCP count | **One** — extend the existing `podium` MCP provider via composition; no second server. |
| CLI count | **One** — extend `scripts/cli.ts` with an `issue` command group. |
| Workflow axis | Keep the **6 kanban stages**; layer beads' lifecycle attributes on top. |
| Access control | **Role-gated** (reader / worker / maintainer) on the shared command layer. |
| Sync | None new — Podium's existing persistence. |

### Existing code this builds on (grounding references)

- Protocol: `packages/protocol/src/messages.ts` — `IssueWire` (≈581–609), `ISSUE_STAGES` (≈571).
- Store: `apps/server/src/store.ts` — `IssueRow` (≈105–129), `issues` schema (≈1129–1155),
  `upsertIssue`/`getIssue`/`listIssueRows`/`nextIssueSeq` (≈876–990), migration runner.
- Service: `apps/server/src/issues.ts` — `IssueService` (create/start/update/archive/action/assistant).
- Helpers: `apps/server/src/issue-util.ts` — `slugifyBranch`, `sessionsForIssue`, `isMemberCwd`.
- Router: `apps/server/src/router.ts:358-422` — the `issues` tRPC router.
- Assistant: `apps/server/src/issueAssistant.ts` — stage suggestion engine (unchanged).
- MCP: `apps/server/src/mcp-route.ts` — `McpToolProvider` + `registerMcpRoute`;
  `apps/server/src/superagent.ts` — `mcpToolSpecs()`/`callMcpTool()` + internal tool registry;
  `apps/server/src/server.ts:62-71` — wiring (single `mcpToken = randomUUID()`).
- CLI: `scripts/cli.ts` — mode launcher; built via `bun build --compile` → `dist-bun/podium`.
- tRPC client transport (reuse for CLI): `apps/web/src/trpc.ts` — `httpBatchLink` → `:18787/trpc`.
- Repo scoping: `apps/server/src/repo-registry.ts` — `(machineId, path)` registry.
- UI: `apps/web/src/IssuesView.tsx`, `IssueDetail.tsx`, `NewIssueDialog.tsx`, `Sidebar.tsx`,
  `derive.ts` (`issueNavList`/`filterIssueNav`), `issue-card.ts`.

## 4. Data model

### 4.1 New columns on `issues`

All nullable or defaulted, added by an additive migration (new schema version bump):

| Column | Type | Notes |
| --- | --- | --- |
| `priority` | INTEGER NOT NULL DEFAULT 2 | 0–4 (0=critical … 4=backlog). |
| `type` | TEXT NOT NULL DEFAULT 'task' | task/bug/feature/chore/epic/decision/spike/story/milestone. |
| `assignee` | TEXT | Free-form actor id (human or agent). Distinct from `default_agent` (which CLI kind to spawn). |
| `parent_id` | TEXT | Issue-hierarchy parent (epic → children). Distinct from `parent_branch` (git). |
| `design` | TEXT | Design/decision notes. |
| `acceptance` | TEXT | Acceptance criteria (used by `lint`). |
| `notes` | TEXT | Manual, append-able notes (distinct from AI `activity_notes`). |
| `due_at` | TEXT | ISO date; for `overdue` filter. |
| `defer_until` | TEXT | ISO date; non-null & future ⇒ deferred (hidden from `ready`). |
| `closed_reason` | TEXT | done / superseded / duplicate / wontfix (set when stage→done or via lifecycle cmd). |
| `superseded_by` | TEXT | Issue id (set by `supersede`). |
| `duplicate_of` | TEXT | Issue id (set by `duplicate`). |
| `pinned` | INTEGER NOT NULL DEFAULT 0 | Excluded from bulk hygiene/delete. |
| `estimate_min` | INTEGER | Optional estimate in minutes. |

`blocked_by` (existing JSON array) is **migrated** into `issue_deps` (type `blocks`) and then
treated as derived/legacy; new code reads/writes deps via `issue_deps`.

### 4.2 New tables

```sql
CREATE TABLE issue_labels (
  issue_id TEXT NOT NULL,
  label    TEXT NOT NULL,
  PRIMARY KEY (issue_id, label)
);
CREATE INDEX idx_issue_labels_label ON issue_labels(label);

CREATE TABLE issue_deps (
  from_id TEXT NOT NULL,   -- the dependent issue
  to_id   TEXT NOT NULL,   -- the issue it depends on
  type    TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX idx_issue_deps_from ON issue_deps(from_id);
CREATE INDEX idx_issue_deps_to   ON issue_deps(to_id);

CREATE TABLE issue_comments (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_issue_comments_issue ON issue_comments(issue_id);
```

**Dependency types:** `blocks` (default), `related`, `parent-child`, `discovered-from`,
`tracks`, `supersedes`, `caused-by`, `validates`. Only **`blocks`** gates `ready`/`blocked`;
`parent-child` is hierarchy (an epic stays open while children are open — a child is *not*
blocked by its open parent), and the rest are informational links.

### 4.3 Wire / protocol

`IssueWire` gains: `priority`, `type`, `assignee`, `parentId`, `design`, `acceptance`, `notes`,
`dueAt`, `deferUntil`, `closedReason`, `pinned`, `estimateMin`, `labels: string[]`,
`deps: { toId, type }[]`, `dependents: { fromId, type }[]`, `comments: Comment[]`, and derived
booleans `ready`/`blocked` plus `childCount`/`childDoneCount` for epics. Adding fields is
backward-compatible with the lenient per-element parse already in the broadcast path.

### 4.4 Derived status semantics (no separate status column)

The 6 stages remain the workflow. beads-style status is derived:

- **closed** = stage `done` (or any `closed_reason` set).
- **deferred** = `defer_until` set and in the future.
- **open** = not closed and not deferred.
- **blocked** = open AND has ≥1 incomplete `blocks` dependency (a `to_id` issue not closed).
- **ready** = open AND not deferred AND not blocked.

ID for humans/agents: the existing per-repo `seq`, shown as `<prefix>-<seq>` (prefix from
repo config, default derived from repo dir name, e.g. `pod-42`). The CLI/MCP accept the short
form, the bare seq, or the full `iss_<uuid>`.

## 5. Dependencies, ready & hierarchy

- `dep add <issue> <depends-on> [--type]` — inserts an `issue_deps` row after a **cycle check**
  (reject if it would create a cycle in the `blocks`/`parent-child` graph).
- `dep rm`, `dep list [--direction up|down]`, `dep tree` (recursive, depth-bounded).
- `ready` — list open, non-deferred, unblocked issues (optionally `--claim` to atomically grab
  the first: set assignee=caller + stage=in_progress in one transaction).
- `blocked` — list issues with ≥1 open blocker, with the blocker ids.
- **Hierarchy** via `parent_id`: `epic status` = children done / total; `epic close-eligible` =
  epics whose every child is closed. Setting `parent_id` also records a `parent-child` dep.
- Graph data: a `issues.graph(repoPath)` query returns nodes + edges for UI/CLI rendering
  (CLI text DAG now; web viz is P4).

## 6. Lifecycle, hygiene & search

| Feature | Behavior |
| --- | --- |
| `defer` / `undefer` | Set/clear `defer_until` (accepts relative dates: `+1d`, `tomorrow`). |
| `supersede <old> --with <new>` | Close `old` (stage→done, `closed_reason=superseded`, `superseded_by=new`) + add `supersedes` dep. |
| `duplicate <id> --of <canonical>` | Close as `closed_reason=duplicate`, set `duplicate_of`, add `related` dep. |
| `find-duplicates` | Mechanical Jaccard similarity over title+description; `--threshold`. (AI variant deferred.) |
| `stale` | Issues with `updated_at` older than `--days` (default 30), still open. |
| `orphans` | Scan repo git log (via repoOp) for issue ids referenced in commits but still open; optional `--fix` to close. |
| `lint` | Template completeness by type (bug ⇒ repro steps + acceptance; task/feature ⇒ acceptance; epic ⇒ children/success criteria). |
| `preflight` | Bundle: lint + stale + orphans + dep-cycle check; returns a pass/fail report. |
| `search` / `list` | Filters: stage, status (open/closed/deferred/ready/blocked), priority (+min/max), type, assignee/unassigned, labels (AND/any/exclude), parent, text (title/desc/notes contains), date ranges, sort, limit. |
| `count` / `stats` | Group counts by stage/priority/type/assignee; totals; ready count; simple lead-time. |
| `doctor` | Health: dependency cycles, dangling dep targets, orphaned parents, issues stuck in a stage; advisory only. |

## 7. Server API surface (tRPC)

Extend the `issues` router (`apps/server/src/router.ts`). New procedures (names indicative):

- Queries: `issues.list` (rich filter input), `issues.get`, `issues.search`, `issues.ready`,
  `issues.blocked`, `issues.graph`, `issues.count`, `issues.stats`, `issues.doctor`,
  `issues.labels` (distinct), `issues.epicStatus`.
- Mutations: extend `issues.create`/`issues.update` for the new fields; add `issues.setLabels`,
  `issues.addComment`, `issues.depAdd`/`issues.depRemove`, `issues.defer`/`issues.undefer`,
  `issues.supersede`, `issues.duplicate`, `issues.claim`, `issues.close` (with reason),
  `issues.reparent`, `issues.lint`, `issues.preflight`.

All field logic lives in `IssueService` (`apps/server/src/issues.ts`) and store methods
(`apps/server/src/store.ts`). The existing worktree/PR/merge/assistant behavior is unchanged;
issues without a worktree are first-class (worktree still only appears on `start`).

## 8. Shared command layer → CLI + MCP

To honor "the CLI is the base for the MCP" and "one source of truth," both front-ends are
generated from **one command registry**:

```ts
interface IssueCommand {
  name: string                 // e.g. "create", "ready", "dep add"
  description: string
  params: ZodSchema            // also rendered to MCP inputSchema + CLI arg parsing
  role: Role                   // minimum role required
  run(ctx: CmdCtx, args): Promise<CmdResult>   // calls the tRPC client
}
```

- **CLI** (`podium issue <verb> …`, plus top-level aliases `podium ready` / `podium create`):
  parses argv against the command's `params`, calls `run`, prints text (or `--json`).
  Built on `@trpc/client` `httpBatchLink` to `http://localhost:${PODIUM_PORT||18787}/trpc`,
  reusing the transport pattern from `apps/web/src/trpc.ts`. Repo is inferred from `cwd`
  (matched against the repo registry), overridable with `-C/--dir` or `--repo`.
- **MCP**: a new `IssueToolProvider` exposes the same commands as MCP tools. The server wires a
  **`CompositeMcpProvider`** = superagent tools ⊕ issue tools, passed to the existing
  `registerMcpRoute(app, composite, token)` — still one `podium` MCP server, just more tools.

`mcpToolSpecs()` is generated by mapping each `IssueCommand` to `{name, description, inputSchema}`
(zod → JSON Schema); `callMcpTool` dispatches to `run`.

## 9. Roles / access control

Three capability tiers:

| Role | Can do |
| --- | --- |
| **reader** | list, get, show, search, ready, blocked, graph, count, stats, doctor. |
| **worker** | reader **+** claim, update own issue's stage/notes/assignee, add comments, create `discovered-from` sub-issues, defer own. Default for spawned worker agents; **scoped to their issue** (the issue whose worktree they run in). |
| **maintainer** | everything: create/delete, dep & label edits, reparent, supersede/duplicate, lint/preflight, archive, lifecycle on any issue. |

**Enforcement is server-side** at the shared command layer (the single policy point):

- The server mints **role-scoped capability tokens**. When the daemon spawns a worker agent for
  an issue, it injects `PODIUM_ISSUE_TOKEN` (role=worker, issueId=X) into that agent's
  environment. Both the CLI and the in-agent MCP client read it and present it.
- The MCP route resolves the presented token → `{role, issueId?}` and passes it into the
  provider, which (a) filters `tools/list` to the allowed commands and (b) re-checks on each
  `tools/call`; worker calls are additionally constrained to `issueId`.
- The CLI presents the same token (env) on its tRPC calls via a header; a **human-run CLI on
  localhost with no token defaults to `maintainer`** (the trusted operator). 
- tRPC procedures validate the role from the header/context before mutating.

This mirrors beads' `--readonly` / `--role maintainer|contributor`, adapted to Podium's
spawn-time identity.

## 10. UI (phased)

- **Phase A (in this effort):** surface the new fields where issues already render —
  - `issue-card.ts` / `IssuesView.tsx`: priority + type badges, label chips, assignee, blocked/ready dot.
  - `IssueDetail.tsx`: editable priority/type/assignee/labels, acceptance/design/notes, parent &
    children links, dependency list (add/remove), comments thread, lifecycle actions
    (defer, supersede, duplicate, close-with-reason).
  - `NewIssueDialog.tsx`: type/priority/labels/assignee/parent at creation.
  - Board: filter + search bar (stage/priority/type/assignee/label/text) reusing `filterIssueNav`.
- **Phase B (stretch, P4):** dependency-graph visualization, saved-filter / query UI.

## 11. Build phasing

1. **P1 — Data model + API.** Migration (columns + 3 tables + `blocked_by`→`issue_deps`),
   `IssueRow`/`IssueWire` extension, store methods, `IssueService` field logic, derived
   ready/blocked, extended tRPC procedures. TDD.
2. **P2 — Deps + ready + hierarchy + lifecycle/hygiene/search server-side.** Cycle check,
   ready/blocked/graph, epic status, defer/supersede/duplicate/stale/orphans/lint/preflight,
   search/count/stats/doctor. TDD.
3. **P3 — CLI + MCP + roles.** Shared command registry, `podium issue` CLI, `IssueToolProvider`
   + `CompositeMcpProvider`, role-scoped tokens + spawn-time injection, enforcement. TDD +
   an end-to-end CLI-against-running-server smoke test.
4. **P4 — UI Phase A** (fields + filters in board/detail/new-issue dialog). Runtime-verified
   in-browser (clickable UI needs real-click verification, per project convention).
5. **P4+ stretch** — graph viz, AI dup-detect, query mini-language, `.beads/issues.jsonl` import.

Each phase: TDD, worktree-isolated, FF-merge to local main only when green and on user request.
Track work as beads issues (project convention) under one parent/epic.

## 12. Testing strategy

- **Unit (vitest):** store migration round-trip; ready/blocked/cycle/epic derivations;
  each lifecycle command; filter/search; role gating (each role × each command → allow/deny);
  zod→inputSchema generation; CLI argv parsing; MCP dispatch.
- **Integration:** CLI process against an isolated in-process server (reuse the
  isolated-podium harness pattern: `PODIUM_PORT` + `PODIUM_STATE_DIR`), exercising
  create→dep→ready→claim→close and a worker-token permission-denied path. Avoid the
  PTY/agent-spawning e2e suite during routine runs.
- **UI:** unit tests for new derivations + real-click browser verification of Phase A.

## 13. Risks & mitigations

- **Schema migration on the live DB.** Additive-only columns/tables + `blocked_by` backfill;
  never drop. Test forward-migration from a populated fixture DB.
- **Two front-ends drifting.** Single command registry generates both CLI and MCP — no parallel
  definitions.
- **Role bypass.** Enforce only server-side at the command layer; front-ends never self-authorize.
- **Live source safety.** All work in this worktree; main checkout (the live source) stays clean
  until an explicit FF-merge.
- **Scope creep toward the orchestration engine.** Held out by §2 non-goals.

## 14. Open questions (none blocking)

- Default repo prefix scheme for short IDs (derive from dir name vs. a per-repo config field) —
  decide in P1.
- Whether worker tokens expire with the session or persist — default: live for the session,
  re-minted on respawn.
