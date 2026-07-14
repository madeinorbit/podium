# Session Handoff Between Machines — Design

**Issue:** #498 · **Date:** 2026-07-14 · **Status:** Approved by user

Continue a Podium session on another machine: right-click a session in the sidebar →
**Handoff** → pick a machine. Podium packages the session (git state + harness
transcript), transfers it through the server to the target daemon, reconstructs the
worktree there, and resumes the same conversation.

## User decisions (recorded in pspec)

1. **Move semantics** — the source agent is killed; the same session row re-homes to
   the target machine. One session, one sidebar row. No copy mode.
2. **Worktree sessions only** — sessions running in a repo's main checkout cannot be
   handed off (menu hidden). The target side always materializes a worktree; the
   target's main checkout is never touched.
3. **Both harnesses in v1** — claude-code and codex. Portability of both was proven
   experimentally (below).
4. **Canonical package format** — handoff is built on a reusable "session package"
   (manifest + transcript + git bundle), not ad-hoc plumbing, so the same format can
   later serve export, archive, and harness-to-harness transfer.
5. **Auto-clone deferred** — v1 requires the repo to already exist on the target
   machine. Cloning + GitHub credential propagation (#214) is a follow-up step.

## Experiment results (2026-07-14, ludovico ↔ vmi, verified live)

- **Claude Code resume is path-portable.** A transcript created on ludovico
  (`~/.claude/projects/<slug>/<sessionId>.jsonl`) copied to vmi into the slug dir of a
  *different* cwd (`-home-till-src-podium`) resumed fine with `claude --resume <id>`;
  the codeword from the pre-handoff turn was recalled. The ONLY constraint: the jsonl
  must sit in the project-slug directory matching the resume cwd (slug = cwd with
  non-alphanumerics → `-`, see `claudeProjectSlug`). Resume appends to the same file,
  same session id — no fork.
- **Codex resume is home-portable and not cwd-scoped.** A rollout file copied into a
  fresh `CODEX_HOME` under `sessions/YYYY/MM/DD/` (original filename preserved — the
  thread id is embedded in it) resumed via `codex exec resume <threadId>` from an
  unrelated cwd, recalled the codeword, and appended in place (same thread id, same
  file). Requirement on target: codex installed AND logged in (inventory #222 knows
  both).
- **Git packaging works without `git stash export`** (ludovico has git 2.43 < 2.51).
  Temp-index snapshot captures tracked + untracked changes without touching the real
  index/worktree:
  ```
  GIT_INDEX_FILE=<tmp> git read-tree HEAD && git add -A
  TREE=$(git write-tree); SNAP=$(git commit-tree $TREE -p HEAD -m "handoff snapshot")
  git update-ref refs/podium/handoff/<sessionId> $SNAP
  git bundle create out.bundle <branch> refs/podium/handoff/<sessionId> ^<base>
  ```
  Target: `git bundle verify` → `git fetch <bundle> <refspecs>` → `git worktree add`
  → `git restore --source=refs/podium/handoff/<sessionId> --worktree -- .` reproduced
  the exact dirty state (tracked edit + untracked file).
- **Bundle base must be negotiated.** A thin bundle against the source's `origin/main`
  failed `bundle verify` on vmi (its checkout was behind: "lacks prerequisite
  commits"). Rebundling against a SHA the target confirmed it has (its `main`)
  succeeded (2.8MB). The exporter must cut the bundle against refs the target proves
  it has.
- Staged-vs-unstaged distinction is flattened by the snapshot (restore leaves
  everything unstaged). Accepted for v1; noted in manifest as `snapshotFlattened`.

## 1. Session package format (canonical, v1)

A gzipped tar, staged on the server under `<state-dir>/handoff/<sessionId>-<ts>.tgz`:

```
manifest.json          format: 1
transcript.jsonl       claude jsonl OR codex rollout (verbatim bytes)
repo.bundle            git bundle (absent if session had no repo changes AND branch
                       already exists on target — manifest says so)
```

`manifest.json` fields:

| field | notes |
|---|---|
| `format` | `1` |
| `sessionId` | podium session id |
| `agentKind` | `claude-code` \| `codex` |
| `resume` | `{ kind: 'claude-session'|'codex-thread', value }` |
| `transcriptFilename` | original basename — codex needs it verbatim; claude derives `<resume.value>.jsonl` |
| `repoId` | canonical repo identity (`repo-id.ts`) |
| `branch` | branch name |
| `headSha` | branch tip in the bundle |
| `snapshotSha` | snapshot commit (null if worktree clean) |
| `snapshotFlattened` | `true` (staged/unstaged distinction lost) |
| `worktreeName` | source worktree dir basename, reused on target |
| `bundleBase` | SHAs the bundle is thin against |
| `title`, `issueId`, `sourceMachineId`, `exportedAt` | bookkeeping |

The package is self-describing: a future consumer (export download, harness transfer)
needs nothing outside the tar except a repo that contains `bundleBase`.

## 2. Protocol additions

New control/daemon messages (follow the `repoOp`/`fileRead` requestId-correlation
pattern in `packages/protocol/src/messages/` + `apps/server/src/modules/machines/rpc.ts`):

- `handoffExportRequest` (server→daemon): `{ requestId, sessionId, cwd, agentKind,
  resume, branch, baseShas }` → daemon builds snapshot + bundle + tar, replies
  `handoffExportResult { requestId, ok, manifest, sizeBytes, stagePath | error }`.
- Package pull (source→server): byte-range chunk reads against the daemon-side stage
  file `~/.podium/handoff/<sessionId>.tgz`, modeled on the transcript-mirror reader
  (`control/transcripts.ts:90` — offset+length, sequential, verify total size at end).
  Chunk ≤ 8MB raw so base64 stays inside the 10MB schema cap; frames well under the
  64MB daemon guard.
- `handoffImportRequest` (server→daemon): package pushed chunk-wise
  (`handoffImportChunk`) to the target's `~/.podium/handoff/` then
  `{ requestId, repoPath, worktreeName }` → daemon: `bundle verify` → `fetch` refs →
  `worktree add <repoPath>/.worktrees/<worktreeName> <branch>` → `restore --source=
  <snapshotRef> --worktree -- .` → place transcript (claude: `~/.claude/projects/
  <claudeProjectSlug(newCwd)>/<value>.jsonl`; codex: `~/.codex/sessions/<orig date
  path>/<transcriptFilename>`) → reply `handoffImportResult { ok, newCwd | error }`.
- Base negotiation: server asks target via new repo-op `revParseVerify` (batch of
  candidate refs: `main`, `origin/main`, branch name) which SHAs it has; source
  bundles `^<those>`. If target has none (unrelated history) → error, no fallback to
  full-history bundle in v1.
- Existing `RepoOp` enum gains: `revParseVerify`, `fetchBundle` is NOT a repo-op (it
  needs the staged file path — lives in the import handler).

## 3. Server orchestration (`sessions.handoff` tRPC mutation)

Input `{ sessionId, machineId }`. Preconditions validated server-side:
session live-or-resumable, has worktree cwd (reject main-checkout cwds — compare
against `repos.path` for the machine), target machine online, target has repo
(`repos` table row with same `repoId`), target inventory shows `agentKind` installed
with `login.state !== 'out'`.

Sequence (state machine persisted on the session row is NOT needed; orchestrate
in-memory with rollback):

1. Kill source agent gracefully (existing kill path; transcript flushes on exit).
2. `revParseVerify` on target → base SHAs.
3. `handoffExportRequest` to source daemon → pull package to server stage.
4. Push package + `handoffImportRequest` to target daemon.
5. On ok: update session row `machineId`, `cwd` (target worktree path), clear
   `pathHint`-adjacent state; call the normal `resumeSession` path (`sessions/
   service.ts:835`) so the agent starts with `--resume` / `codex resume` on target.
6. Broadcast; UI follows the row to the new machine automatically.

**Rollback:** any failure in 2–5 → resume the session on the SOURCE machine (row
unchanged; source worktree untouched). Import-side leftovers (fetched refs, partial
worktree, staged tar) are cleaned best-effort by the import handler on error.
`refs/podium/handoff/<sessionId>` on both sides is deleted after success too;
staged tars GC'd after 24h (mirror uploads-gc pattern).
Failures surface to the UI as a toast via the mutation error; session stays usable.

## 4. Web UI

`SessionContextMenu.tsx`: add **Handoff** group after Hibernate/Resume:
- Eligible when: session's repo resolvable, cwd is a worktree, and ≥1 other machine
  qualifies (online + has repo by `repoId` + inventory harness installed/logged-in).
  Reuse/extend `machinesWithRepo` (`packages/domain/src/machine-selection.ts`) with an
  inventory-aware `handoffTargets(session, repos, machines)` helper (pure, unit-tested).
- One flat submenu of machine names with online dot — mirror the existing New agent →
  Repo → Machine `DropdownMenuSub` pattern (`SidebarUnified.tsx:353`). The context
  menu is a hand-rolled portal; implement the submenu as a nested hover panel
  consistent with `IssueContextMenu.tsx`'s approach.
- During handoff the row shows a transient "Handing off → <machine>" status (reuse
  the optimistic overlay used for spawn drafts).

## 5. Testing & verification

- Unit: package manifest round-trip; snapshot-commit builder (tracked+untracked, does
  not touch real index); bundle base negotiation given target SHA sets; eligibility
  helper (`handoffTargets`) incl. inventory gating; import path placement for both
  harnesses (slug derivation, codex filename preservation).
- Integration: export→import round-trip against two temp repos in-process.
- Live E2E (required before landing): real session on the podium repo, ludovico →
  vmi via the actual server+daemons, send a message post-handoff proving memory and
  worktree dirty-state survived; then hand it back vmi → ludovico.

## Out of scope (v1)

- Auto-clone of missing repos + GitHub credential propagation (#214) — explicit
  follow-up, do last per user.
- Copy/duplicate handoff mode; main-checkout sessions; harness-to-harness transfer
  (format is designed to allow it later).
- Preserving staged-vs-unstaged split and untracked-ignored files (`.gitignore`d
  files are NOT transferred).
- Session hooks/env re-provisioning beyond what daemon spawn already injects
  (daemon-injected system prompt/hooks give parity automatically).
