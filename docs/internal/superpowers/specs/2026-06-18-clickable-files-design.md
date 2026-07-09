# Clickable file references → inline editor

**Date:** 2026-06-18
**Branch:** `worktree-clickable-files`
**Status:** Design — awaiting review

## Goal

Make file references that appear in a Podium session clickable. Clicking opens the
file in an inline CodeMirror editor panel where the user can view **and edit** it,
then save back to disk. This works in **both** surfaces:

- **Chat view** (`ChatView.tsx`) — Podium's reconstructed transcript UI.
- **Native view** (`terminal-client` / `terminal-view.ts`) — the live xterm.js
  terminal rendering the real agent TUI.

A secondary deliverable: fix the bug where links that **wrap across terminal rows**
("multiline links") are not clickable — observed on mobile, where the narrow
terminal makes wrapping the common case.

## Decisions (locked with user)

1. **Editor is editable + save** (not read-only). Full read → edit → write-back.
2. **Detection is "highlighted-only".** A path becomes a link only when the agent
   has *highlighted* it:
   - Chat: the path is inside an inline-code span (backticks) **or** is a
     structured tool/attachment path.
   - Native: the path run carries ANSI styling (non-default fg colour, bold, or
     underline).
   This matches agent intent and keeps false positives near zero.
3. **Both structured and prose** references are in scope, subject to the
   highlighted-only gate above.
4. **Write is sandboxed to the repo** (the session `cwd` subtree). Files outside
   the repo are **read-only**.
5. **Multiline bug:** diagnose root cause; fix at the correct layer. The new
   file-link provider handles wrapping from the start. For the existing URL addon,
   if the root cause is upstream in `@xterm/addon-web-links`, apply a local
   `bun patch` and file an upstream PR. **Do not reimplement the addon.**
6. **Editor library: CodeMirror 6** (lazy-loaded), chosen over Monaco for weight
   and touch/mobile support (Podium is frequently used on mobile / as a PWA).

## Background — how files appear (verified against real data)

### Claude Code transcript JSONL

Files appear in two regimes:

- **Plain prose:** when the agent writes a path in its response text, it is just
  markdown text. A bare filename and a full repo path are indistinguishable — no
  marker. (This is the "prose" case, gated by backticks above.)
- **Structured, machine-readable (absolute paths):**
  - `tool_use` blocks (Read/Edit/Write/Grep/Glob): `input.file_path` (absolute).
    Podium already extracts this via `toolInputPreview()` priority list
    (`packages/agent-bridge/src/transcript/claude.ts`).
  - `@`-mention → separate top-level line
    `{type:"attachment", attachment:{type:"file", filename:<abs>, displayPath:<rel>, content:{file:{filePath,content,...}}}}`.
  - Edits → `{type:"attachment", attachment:{type:"edited_text_file", filename, snippet}}`.
  - Compaction → `{type:"attachment", attachment:{type:"compact_file_reference", filename:<abs>, displayPath:<rel>}}`.

  Podium's parser currently turns inline `document` content-blocks into `tags`,
  but does **not** read the top-level `attachment` lines — so @-mention/edit paths
  are not yet surfaced.

### Native terminal

The native view renders the raw PTY stream — terminal glyphs only, no structured
metadata. All detection there is text + per-cell-style based. Hybrid precision
booster: the session is already tailing the transcript, so the set of absolute
paths the agent actually touched is known and can be fed to the terminal detector.

## Architecture

The system decomposes into five units with clear boundaries:

```
                       ┌──────────────────────┐
  chat detector  ─────▶│  openFile(sessionId, │
  native detector ────▶│         path)        │──▶ FileEditorPanel
                       └──────────────────────┘        │
                                                        ▼
                                            files.read / files.write (tRPC)
                                                        │
                                                        ▼
                                          relay.readFile / writeFile
                                                        │ daemonRequest
                                                        ▼
                                          daemon fs (sandboxed)
```

### Unit 1 — File transport (daemon RPC)

**What it does:** read/write a file by path on the machine that owns the session.
**Why daemon, not server-side fs:** with multi-machine support the file may live on
a different host's daemon. Mirrors the existing `TranscriptReadRequest` pattern.

Protocol (`packages/protocol/src/messages.ts`):

```ts
FileReadRequest  = { type:'fileReadRequest',  requestId, sessionId, path }
FileReadResult   = { type:'fileReadResult',   requestId, ok, path,
                     content?, baseHash?, truncated?, tooLarge?, binary?, error? }
FileWriteRequest = { type:'fileWriteRequest', requestId, sessionId, path,
                     content, baseHash? }
FileWriteResult  = { type:'fileWriteResult',  requestId, ok, baseHash?,
                     conflict?, error? }
```

- `baseHash` = cheap signature (e.g. `mtimeMs:size`). Returned by read, echoed by
  write. On write, daemon compares current signature to `baseHash`; mismatch →
  `conflict:true` (no write performed).
- Read caps: refuse files over a size limit (e.g. 2 MB) with `tooLarge:true`;
  detect binary (NUL byte sniff) → `binary:true` and no content.

tRPC (`apps/server/src/router.ts`): `files.read`, `files.write` → `relay.readFile`,
`relay.writeFile`, both using the `daemonRequest` helper exactly like
`relay.readTranscript` (`apps/server/src/relay.ts`).

### Unit 2 — Security sandbox (in the daemon handler)

The single trust boundary. Podium is network-exposed (tailscale serve / funnel), so
path access must be constrained:

- Resolve the requested path with `realpath` (follow symlinks).
- Compute the session's allowed roots:
  - **repo root** = the session `cwd` (resolved).
  - **transcript-known set** = absolute paths that appear in this session's
    transcript (already disclosed to anyone who can view the session).
- **Read allowed** iff resolved path is inside repo root **or** is a member of the
  transcript-known set.
- **Write allowed** iff resolved path is inside repo root. Known-but-outside-repo
  paths are read-only.
- Reject everything else with `error`. No path-traversal escape (the realpath check
  is what enforces this, not string prefixing of the raw input).

### Unit 3 — Inline editor panel (web)

`apps/web/src/FileEditorPanel.tsx`, mounted in the existing keep-mounted panel deck.

- CodeMirror 6, **lazy-loaded** (dynamic import) so it doesn't bloat first paint.
- Language by file extension.
- Loads content via `files.read`; shows `tooLarge`/`binary`/`error` states.
- Edit + Save (⌘/Ctrl-S and a button). Save calls `files.write` with `baseHash`.
  - `conflict:true` → prompt: reload (discard local) or overwrite (resend without
    `baseHash`).
- Dirty indicator; confirm-on-close when dirty.
- Outside-repo files open read-only (no Save).

### Unit 4 — openFile action (web)

A single dispatcher `openFile(sessionId, path)` (small store/context helper). Both
detectors call only this; it owns "ensure panel open + load this file". This is the
seam that keeps detection decoupled from the editor.

### Unit 5a — Chat detector

- **Structured paths:** extend `TranscriptItem` (`packages/protocol/src/messages.ts`)
  with `toolPaths?: string[]`. Populate in `transcript/claude.ts`:
  - from `tool_use` inputs (`file_path`/`path`/`notebook_path`),
  - from the top-level `attachment` lines (`file`/`edited_text_file`/
    `compact_file_reference`) — new parsing.
  Render these as clickable chips in `ToolBlock()` / message tags in `ChatView.tsx`.
- **Prose paths:** in `apps/web/src/markdown.ts`, post-process rendered HTML —
  **only within `<code>` inline spans** — linkify tokens that look path-like
  (contain `/` or a known code-file extension). Existence is validated lazily: the
  click attempts `openFile`; if the daemon reports not-found, show a subtle toast.
  (Underline styling is scoped to path-like code spans only.)

### Unit 5b — Native detector + multiline fix

A custom xterm link provider registered in `terminal-client/src/terminal-view.ts`
via `term.registerLinkProvider`. Per the row xterm asks about:

1. Reconstruct the **wrap-stitched logical line**: walk `isWrapped` continuation
   rows so a path split across rows is one logical string, remembering each char's
   buffer coordinate.
2. Read **per-cell style** (fg colour / bold / underline) so only **ANSI-styled**
   runs are considered (the highlighted-only gate).
3. Match path-like runs; cross-check against the **transcript-known path set** fed
   in from the web layer for precision.
4. Emit `ILink`s whose `range` maps back to buffer coords — **including multi-row
   ranges** for wrapped paths. `activate` → `openFile(sessionId, resolve(cwd,path))`.

The web layer (`AgentPanel.tsx`) configures the provider with `sessionId`, `cwd`,
the known-path set, and the `openFile` callback. `terminal-client` stays free of
app/protocol deps — config is injected.

**Multiline bug:** reproduce at narrow width (long URL + path that wraps).
Determine whether the failure is (a) the stock `@xterm/addon-web-links` wrap-range
math, (b) Podium's terminal integration (renderer / `dom-viewport` scroll / mobile
remount at the 768px breakpoint), or (c) tap-target handling on the continuation
row. Fix at that layer: a local `bun patch` (+ upstream PR) if it's the addon; a
Podium fix otherwise. The new file-link provider handles wrap natively regardless.

## Affected files

| Area | File |
|---|---|
| Protocol | `packages/protocol/src/messages.ts` (new msgs, `TranscriptItem.toolPaths`) |
| tRPC router | `apps/server/src/router.ts` (`files.read`/`files.write`) |
| Relay | `apps/server/src/relay.ts` (`readFile`/`writeFile` via `daemonRequest`) |
| Daemon | agent-bridge / daemon request handler (fs + sandbox) |
| Transcript parse | `packages/agent-bridge/src/transcript/claude.ts` (attachment lines, `toolPaths`) |
| Chat UI | `apps/web/src/ChatView.tsx`, `apps/web/src/markdown.ts` |
| Editor | `apps/web/src/FileEditorPanel.tsx` (new), panel-deck wiring, `openFile` helper |
| Native | `packages/terminal-client/src/terminal-view.ts`, `apps/web/src/AgentPanel.tsx` |

## Build order (phases)

1. **Transport + viewer:** `files.read` RPC + daemon fs/sandbox + read-only CM6
   panel + `openFile`. One known path → clickable → opens. End-to-end skeleton.
2. **Chat detection:** structured chips (tool + attachment paths) → prose
   code-span links.
3. **Native detection + multiline fix:** styled-run link provider with wrap
   handling + transcript-known hybrid; diagnose & fix the URL wrap bug.
4. **Editing:** `files.write` + save / conflict / dirty UX.

## Testing strategy

- **Unit (agent-bridge):** transcript parser emits `toolPaths` from tool inputs and
  from each attachment subtype; existing `toolInputPreview` tests stay green.
- **Unit (sandbox):** path resolution — inside repo (read+write ok), outside repo
  but in transcript set (read ok / write rejected), traversal & symlink escape
  (rejected). This is the security-critical surface; test it hard.
- **Unit (terminal-client):** wrap-stitch produces one logical line + correct coords
  for a path spanning rows; styled vs unstyled gating; multi-row `ILink` range.
  Regression test for the multiline bug repro.
- **Unit (web):** markdown post-processor linkifies only path-like tokens inside
  code spans; conflict/dirty/large/binary panel states.
- **Manual:** mobile narrow-terminal wrapped link tap; chat chip + code-span click;
  edit + save round-trip; conflict path.

## Out of scope (YAGNI)

- File tree / browser UI.
- Diff view, multi-file tabs, search-in-file.
- Editing files outside the repo (read-only there).
- New-file creation, rename, delete.
- LSP / autocomplete / linting in the editor.
