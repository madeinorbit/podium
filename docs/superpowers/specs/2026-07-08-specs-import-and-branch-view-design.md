# Specs: session importer + repo/branch-aware viewer (issue #172)

Approved design, 2026-07-08.

## Part A — Importer: `podium spec import`

A Podium-orchestrated, rerunnable pipeline: deterministic distillation → agent map → agent reduce.
Goal: layered spec — feature components form the tree, explicit human decisions/constraints as
content under each node.

### A1. Discovery & incremental state

- Enumerate all conversations for the repo across agents via the conversation registry /
  transcript lake (stable conversation IDs, not native session ids).
- Import state at `$PODIUM_STATE_DIR/spec-import/<repoId>.json`: per conversation ID a cursor
  (content hash / byte offset of last processed transcript content).
- Reruns process only new conversations and grown tails of known ones.

### A2. Deterministic distillation (no LLM)

Parse transcripts with `packages/agent-bridge/src/transcript/*` parsers; emit one compact
"decision digest" (markdown) per session:

- User messages verbatim; pasted blobs/logs truncated after ~30 lines.
- AskUserQuestion tool calls + answers extracted as structured Q&A pairs; same for plan approvals.
- For other user messages: tail (~500 chars) of the preceding assistant text and a short head of
  the assistant follow-up, so it is clear which question the user answered and what it led to.
- Drop tool results, code dumps, thinking, subagent transcripts.
- Session header: date, branch/issue, cwd, agent kind.

### A3. Map phase (parallel agents)

Digests batched chronologically (~50–100k chars/batch). Each agent extracts candidate spec facts
as structured output: `{featureArea, kind: decision|constraint|behavior, statement, why, quote,
conversationId, date}`. Prompt embeds the spec duty-of-care rules (only explicit human
decisions/context).

### A4. Import phase (a real agent — revised 2026-07-08)

The prepared artifacts (digests + facts.json) are handed to a HARNESS AGENT running headless in
an isolated worktree on the import branch, driven by a structured playbook
(`importAgentPlaybook`): orient → VERIFY each fact against the current codebase (fanned out to
fast/cheap-model subagents, ~10 facts each) → resolve superseded decisions by date vs code
reality → structure the layered tree → write pspec/*.html → self-review checklist → commit.
Rationale: correctness requires code navigation; a chat completion cannot check whether a
recorded decision still holds. The single-shot LLM reduce (recency-wins, `applyImportOps`,
plumbing commit) is retained as `--mode llm` for servers without a daemon/harness;
`--mode prepare` stops after artifact preparation.

### A5. Review via git

Import runs on a `spec-import/<date>` branch/worktree, never on main. User reviews with the
Part B diff view and merges.

## Part B — Repo/branch-aware Specs viewer

### B1. Dropdown fix

Populate from canonical repos (dedupe worktrees to parent repo, label with repo name). Main
Specs view reads/edits the repo root working tree — main is canon; branches are overlays.

### B2. Server: git-aware reads

- `specs.branchDiff({repoPath, branch})`: merge-base with main; `git diff --name-only -- pspec/`;
  read both sides via `git cat-file`; return per-component
  `{id, title, parentChain, changeKind: added|modified|removed|moved, baseHtml, headHtml}`.
- `specs.branchesTouchingSpec({repoPath})`: issue branches with pending pspec changes, mapped to
  Podium issues where possible.

### B3. Main Specs view — ongoing issues

Panel listing those branches/issues. Selecting one overlays the diff onto the spec tree: changed
nodes get A/M/D badges, ancestors kept for navigation, unchanged siblings dimmed. Selecting a
changed node shows the rendered rich diff.

### B4. Right sidebar "Specs" tab

Per active session: worktree → branch → same branchDiff data. Mini component tree of changed
nodes + ancestors with A/M/D badges; click → rendered rich diff inline. Tab only appears when
the branch touches `pspec/`.

### B5. Rich diff rendering

htmldiff-style word-level diff of base vs head HTML producing one merged document with
`<ins>`/`<del>` spans, rendered read-only with prose styling. Added/removed components render
whole with a tinted header badge.

## Rejected alternatives

- Union view of all branches in one spec tree (provenance chaos).
- Reading only native session files without the registry (unstable IDs break rerunnability).
- Side-by-side before/after panes (less scannable than inline diff).

## Defaults

- Import batches run with the session's default model.
- Sidebar tab hidden when branch has no pspec changes.
