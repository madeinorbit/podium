# Issue Tracker — Design Spec

Date: 2026-06-21
Branch: `worktree-issue-tracker`
Status: Approved design, ready for implementation plan

## 1. Purpose

Add a first-class **Issue** to Podium: a unit of work that owns one git worktree and
everything running in it (multiple agent sessions + shells), tracks its stage on a
kanban-style board, and has an always-on background AI assistant that keeps an activity
summary current, suggests stage moves for one-click approval, and flags cross-issue
dependencies. Issues are created from a free-text description or imported from Linear,
optionally starting work immediately.

This is v1 = **everything**: the entity, lazy worktree/session creation, the board UI,
quick git actions, and the full AI assistant (including cross-issue dependency rating).

## 2. Key decisions (locked)

- **Issue ↔ worktree is 1:1.** An issue owns exactly one worktree. Sessions/shells are
  members of an issue by living in that worktree's `cwd` — derived, not tagged. Any shell
  opened in the issue directory is automatically part of the issue.
- **Stages (6):** `backlog → planning → in_progress → review → verifying → done`.
  - `backlog`: created, not started (no worktree yet).
  - `planning`: research/planning; worktree + first agent exist.
  - `in_progress`: implementation underway.
  - `review`: PR open / under review.
  - `verifying`: merged or release candidate, being tested.
  - `done`: complete; can be archived.
- **Merge default:** `ff-only` (rebase on parent, then `git merge --ff-only`). Settable
  per the new `settings.gitWorkflow.mergeStyle` (`ff-only` | `pr` | `ask`).
- **UI home:** a new dedicated top-level **Issues board** view + per-issue detail panel.
- **Background AI = `settings.workLlm`** (the "background worker model", default
  Gemini Flash), via the existing `llmClient()` abstraction.
- **Stage moves are suggest-only.** The assistant auto-updates *activity notes* (no
  approval) but never auto-moves stage — it proposes a move the user approves in one click.
  The user can also move manually at any time.
- **No conversational chat with the issue assistant in v1.** The assistant is a structured
  background updater, not a chat thread. (A per-issue chat thread is a future option.)

## 3. Reused existing infrastructure

| Need | Existing piece | Location |
| --- | --- | --- |
| Background LLM call | `llmClient(backend, apiKeys).complete()` | `apps/server/src/llm.ts` |
| Background worker model | `settings.workLlm` | `packages/core/src/settings.ts` |
| Linear search/create/move | `searchIssues` / `createIssue` / `moveIssue` | `apps/server/src/linear.ts` |
| Linear API key | `settings.integrations.linearApiKey` | `packages/core/src/settings.ts` |
| Worktree creation | daemon `RepoOp` `worktreeAdd` | `apps/daemon/src/daemon.ts` |
| Session spawn | `SessionRegistry.createSession()` | `apps/server/src/relay.ts` |
| Session phase events | `sessionAgentStateChanged` broadcast | server relay |
| Transcript read for context | `read_session_transcript` helper | `apps/server/src/superagent.ts` |
| SQLite store + migrations | `SessionStore.migrate()` (schema_version) | `apps/server/src/store.ts` |
| Kanban column rendering | home/derive helpers | `apps/web/src/home.ts`, `derive.ts` |

## 4. Data model

New table `issues` (SQLite, schema_version bumped to **v5**, additive migration):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | `iss_<uuid>` |
| `repo_path` | TEXT | repo the issue belongs to |
| `seq` | INTEGER | per-repo human number (e.g. #7), assigned at create |
| `title` | TEXT | |
| `description` | TEXT | markdown; the problem statement |
| `stage` | TEXT | one of the 6 stages |
| `worktree_path` | TEXT NULL | null until work starts |
| `branch` | TEXT NULL | `issue/<seq>-<slug>` |
| `parent_branch` | TEXT | default from settings / repo default |
| `default_agent` | TEXT | agent kind for sessions started in this issue |
| `linear_id` | TEXT NULL | linked Linear issue id |
| `linear_identifier` | TEXT NULL | e.g. `ENG-123` |
| `linear_url` | TEXT NULL | |
| `activity_notes` | TEXT NULL | AI-maintained markdown summary |
| `notes_updated_at` | TEXT NULL | ISO |
| `suggested_stage` | TEXT NULL | AI proposal; null when none |
| `suggested_reason` | TEXT NULL | one-line rationale |
| `blocked_by` | TEXT NULL | JSON array of issue ids |
| `dependency_note` | TEXT NULL | AI advisory text |
| `pr_url` | TEXT NULL | set when a PR is opened |
| `created_at` | TEXT | ISO |
| `updated_at` | TEXT | ISO |
| `archived` | INTEGER | 0/1 |

Index on `repo_path`. Curated columns (`title`, `description`, `stage`, `archived`) are
authoritative; AI columns are recomputed and overwritten by the assistant.

**Membership derivation:** a session belongs to an issue iff
`session.cwd === issue.worktree_path` or `session.cwd` is under `issue.worktree_path + '/'`.
Pure function `sessionsForIssue(issue, sessions)`; no change to the `sessions` table.

## 5. Protocol

`packages/protocol/src/messages.ts`:

- `IssueWire` — wire shape of an issue plus derived `sessions: SessionMeta[]` (the members)
  and `sessionSummary` (counts by phase) computed server-side at serialization.
- Broadcasts: `issuesChanged` (full list invalidation) and `issueUpdated` (single issue),
  mirroring the existing session broadcast pattern.
- `RepoOp` extended with write ops: `rebase`, `mergeFfOnly`, `prCreate` (in addition to
  the start-point arg added to `worktreeAdd`).

## 6. tRPC procedures (`issues.*`, in `apps/server/src/router.ts`)

- `list({ repoPath? })` → `IssueWire[]`
- `get({ id })` → `IssueWire`
- `create({ repoPath, title, description?, parentBranch?, defaultAgent?, startNow, linearRef? })`
  → creates the row; if `startNow`, runs `start` inline.
- `start({ id })` → create worktree off parent, spawn first agent (seeded with description),
  set stage → `planning`.
- `update({ id, patch })` → manual edits incl. stage move, archive, title/description.
- `action({ id, kind: 'rebase' | 'pr' | 'merge' })` → run the git action on the worktree.
- `applySuggestion({ id })` / `dismissSuggestion({ id })` → accept/clear the AI stage proposal.
- `refreshAssistant({ id })` → force an assistant run now.
- `linearSearch({ query })` → proxy to `searchIssues` for the create dialog.
- `addSession({ id, agentKind })` / `addShell({ id })` → spawn another member in the worktree.

## 7. Creation + start flow

**New Issue dialog** (web): title (required), description textarea **or** "Import from
Linear" (calls `issues.linearSearch`, fills title/description, stores the link), repo
selector (default current), parent branch (default repo default / `settings.gitWorkflow.
defaultParentBranch`), agent selector (default `settings.sessionDefaults.agent`), and a
**Start work now** toggle (default ON).

- **Start now:** assign `seq`, branch `issue/<seq>-<slug>`; daemon
  `worktreeAdd(path, branch, startPoint=parent_branch)`; persist `worktree_path` + `branch`;
  `createSession({ cwd: worktree_path, agentKind: default_agent })` and **pre-fill that
  session's draft composer with the description** (the user reviews and sends it — not
  auto-sent), reusing the existing `session_drafts` mechanism; stage → `planning`; broadcast.
- **Not now:** insert row in `backlog`, no worktree. A **Start** button later runs `start`.

Branch slug = lowercased title, non-alphanumerics → `-`, collapsed, truncated ~40 chars.

## 8. Quick actions (git)

On the issue's `worktree_path` / `branch`, via new daemon `RepoOp`s + `issues.action`:

- **Rebase on parent:** `git -C <worktree> fetch` (best effort) then
  `git -C <worktree> rebase <parent_branch>`.
- **Open PR:** `gh pr create --base <parent_branch> --head <branch> --fill` run in the
  worktree; capture the URL → `pr_url`; on success the assistant may suggest `review`.
- **FF-only merge:** if `autoRebaseBeforeMerge`, rebase first; then in the repo root
  `git checkout <parent_branch> && git merge --ff-only <branch>`. On success the assistant
  may suggest `verifying`/`done`.

Each action returns `{ ok, output }` surfaced as a toast; failures are shown verbatim, not
swallowed. The primary button shown is driven by `settings.gitWorkflow.mergeStyle`; all
three remain available.

## 9. The AI assistant (`apps/server/src/issueAssistant.ts`)

A focused background worker — **one structured `llmClient(settings.workLlm)` call per run**,
JSON output, not a chat/tool loop.

**Triggers (debounced, ≤ 1 run per issue per ~2 min, coalesced):**
- a member session's `agentState`/phase changes or it exits,
- a quick action completes,
- manual `refreshAssistant`,
- issue created/started.

**Context gathered per run:**
- issue title/description/current stage/parent/branch,
- each member session: agentKind + phase + idle/need verdict + a short transcript tail,
- worktree `git status --porcelain` + recent `git log`,
- a compact digest of *other* non-archived issues in the repo: `{ id, seq, title, stage,
  branch }` (for dependency reasoning).

**Output (validated JSON):**
```jsonc
{
  "activityNotes": "markdown summary of state across all agents",
  "suggestedStage": "in_progress" | null,   // null = no move
  "suggestedReason": "PR opened against main",
  "blockedBy": ["iss_..."],                  // ids this likely depends on
  "dependencyNote": "Overlaps ENG-12 (#3) on auth.ts — consider waiting."
}
```

Persist results, clear/replace prior suggestion, broadcast `issueUpdated`. `activityNotes`
apply immediately; `suggestedStage` surfaces a one-click banner. Parsing is defensive: a
malformed/empty response leaves prior state intact and logs a warning.

**Stage-suggestion mapping** is a pure helper `suggestStage(stateDigest)` (unit-tested
independently of the LLM) that the prompt is anchored to, e.g.: plan/research artifact + idle
→ `in_progress`; `pr_url` set / "PR" in status → `review`; branch merged (ff-only done) →
`verifying`; tests green + verifying → `done`. The LLM may override with reason, but the
deterministic mapping is the tested backbone and the fallback when the model is unsure.

## 10. Settings

Add to `PodiumSettings` (`packages/core/src/settings.ts`) with defaults in
`normalizeSettings`:

```ts
gitWorkflow: {
  defaultParentBranch: string,        // '' = auto-detect repo default (main/master)
  mergeStyle: 'ff-only' | 'pr' | 'ask', // default 'ff-only'
  autoRebaseBeforeMerge: boolean,     // default true
},
issues: {
  assistantEnabled: boolean,          // default true
}
```

New **Workflow** tab in `apps/web/src/SettingsView.tsx` to edit these. **v1 ships global
settings only** (no per-repo override UI). Action code resolves the parent branch as
`gitWorkflow.defaultParentBranch || <repo default branch>`, leaving room to add a per-repo
override later without a schema change.

## 11. UI — Issues board

New top-level view (added to the view switcher):

- **Board:** 6 stage columns; issue cards show title + `#seq`, repo, default agent,
  member-session phase badges (reusing existing badge components), Linear identifier chip,
  a one-line activity-notes snippet, and a suggested-move banner when present. Manual move
  via click-to-stage or drag.
- **Detail panel:** description (markdown), AI activity notes, dependency note + blocked-by
  chips (links to other issues), the member sessions/shells list (open each, **+ Session**,
  **+ Shell**), quick-action buttons (primary chosen by `mergeStyle`), **Start** if
  unstarted, stage selector, and Approve/Dismiss for the current suggestion.
- **New Issue** button → the dialog in §7.

Built on existing shadcn/Base UI primitives; reuse session-row and badge components.

## 12. Server wiring

An `IssueRegistry` (in `apps/server`, alongside `SessionRegistry`) owns issue CRUD against
the store, derives membership from the live session list, serializes `IssueWire`, drives the
assistant scheduler (debounced per issue), and emits `issuesChanged`/`issueUpdated`. It
subscribes to session phase/exit events to trigger assistant runs.

## 13. Testing strategy (TDD)

Unit (pure, fast — fix the web `@/lib/utils` vitest alias so web logic is testable):
- `slugifyBranch(title)` and `nextSeq(repo)` generation.
- `sessionsForIssue` / membership derivation + `sessionSummary` counts.
- `suggestStage(stateDigest)` deterministic mapping across all transitions.
- assistant JSON parse/validate with a mocked `llmClient` (good, malformed, empty).
- `normalizeSettings` defaults + back-compat for the new `gitWorkflow`/`issues` blocks.
- store: `issues` CRUD + schema v4→v5 migration (additive, idempotent).

Integration:
- `create` (startNow=false) → row in `backlog`, no worktree.
- `start` → worktree created off parent, first session spawned, stage `planning`.
  (Guard PTY/worktree leaks per known agent-bridge test hygiene; reap by explicit pid.)

E2E (Playwright harness, real in-browser — interactive UI requires runtime verification):
- board renders with seeded issues; New Issue dialog; manual stage move; approve a seeded
  AI suggestion moves the card; quick-action button calls the procedure (git mocked/dry).

## 14. Build order (all in v1)

1. Data model + protocol + store (`issues` table, `IssueWire`, schema v5, CRUD).
2. Settings (`gitWorkflow`, `issues`) + `normalizeSettings` + Workflow tab.
3. Creation/start flow + lazy worktree (worktreeAdd start-point) + first session + Linear import.
4. Issues board UI + detail panel + view switcher entry.
5. Quick actions (rebase/PR/merge) — daemon RepoOps + `issues.action`.
6. AI assistant (`issueAssistant.ts`) + scheduler + suggestion apply/dismiss + dependency rating.

## 15. Out of scope (v1)

- Conversational chat with the issue assistant (background updater only).
- Auto-moving stage without approval.
- Per-repo merge-style override UI beyond the global setting (data layer may allow it).
- Multi-machine routing concerns beyond what session creation already handles.
- Bi-directional Linear sync (we import + link; we do not push stage changes back in v1).
