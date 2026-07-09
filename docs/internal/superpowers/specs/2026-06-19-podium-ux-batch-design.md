# Podium UX Batch — Design Spec

Date: 2026-06-19
Status: Approved design → ready for implementation plan
Scope: One feature branch, grouped commits across four workstreams.

## Overview

A 13-item batch of bug fixes and features spanning the Grok/Codex harnesses, the
chat transcript viewer, the sidebar information architecture, and settings. Each
item below states the problem, the root cause (file:line where known), the fix
approach, and how it's verified.

Decisions already made with the user:
- **Image delivery**: primary = save image to a temp file + insert its path into
  the prompt (works over the PTY today); best-effort native paste passthrough
  where the agent accepts it. Temp-file **cleanup is a first-class concern**.
- **NEEDS YOUR ATTENTION** = sessions waiting on you + finished/idle + errored.
- **Repo sort** default = last-used; first manual drag creates a custom order and
  flips the selector to "custom".
- **Chat styling** = "transcript / document" direction (full-width, role-rail),
  with rails **only** on user messages and the agent's final Answer — intermediate
  agent narration has no rail.

---

## Workstream A — Harness bug fixes (backend)

### A1. Grok new chat binds to an already-running transcript
- **Problem**: Opening a new Grok while another Grok chat is active in the same
  cwd associates the new session with the running session's transcript.
- **Root cause**: `packages/agent-bridge/src/agent-state/grok.ts`
  `findLatestGrokSessionPaths()` (~L101–131) selects the session dir by newest
  `summary.json` mtime within the cwd. On reattach `sinceMs` is `undefined`, so it
  matches *any* session; with two recent sessions the choice is ambiguous and can
  latch the wrong dir.
- **Fix**: Establish a per-spawn watermark and bind to the session dir whose
  creation/first-write is *after* that watermark; once a session is bound, never
  re-bind it to a different dir. Discovery on a fresh spawn must ignore
  pre-existing session dirs in the cwd. Reattach uses the persisted bound
  `sessionId`, not "latest".
- **Test**: unit test over a fixture `~/.grok/sessions/<cwd>` with two session
  dirs (one pre-existing, one created after the watermark) asserting the observer
  binds the new one; and that an already-bound observer keeps its dir when a newer
  dir appears.

### A2. Grok auto-titles show transient status and flap
- **Problem**: Grok tab titles show rapidly-changing status text.
- **Root cause**: `apps/server/src/relay.ts` title case (~L866–881) rebroadcasts
  every title with no debounce; `packages/agent-bridge/src/session.ts` scanner
  (~L61–75) only dedups exact repeats, so spinner/status frames pass through.
- **Fix**: (1) Debounce title emission with a trailing window (~400–600ms) so only
  a settled title is broadcast. (2) Filter transient titles: drop values that are
  empty/whitespace, contain spinner/braille/ANSI control glyphs, or look like
  status chatter, keeping the last stable title. Applies generally but resolves
  the Grok case.
- **Test**: unit test feeding a burst of spinner-frame titles + a final stable
  title asserting only the stable one is emitted after the debounce window.

### A3. Grok native view renders into the top-left quarter on return
- **Problem**: Returning to a Grok native tab, the terminal fills only ~¼ (top
  left); "Take control" doesn't help and can hide it.
- **Root cause**: `packages/terminal-client/src/terminal-view.ts` `fit()`
  (~L144–154) silently swallows FitAddon exceptions and returns the stale grid; on
  tab re-show the container may not be laid out yet, so the terminal keeps its old
  (small) dimensions and xterm paints into a corner.
- **Fix**: On tab re-show / viewport change, retry `fit()` across animation frames
  until the container reports real (non-zero, stable) dimensions, then
  `sendResize()` and issue the redraw nudge (`session.ts` `redraw()`). Don't treat
  a measurement failure as success.
- **Test**: prefer a runtime check in the Playwright harness (hide/show a native
  pane, assert the terminal grid matches the container); add a unit guard on the
  fit-retry helper if it can be isolated.

### A4. Codex chat transcripts are misclassified
- **Problem**: Codex chat transcripts render with wrong roles / dropped messages.
- **Root cause**: `packages/agent-bridge/src/transcript/codex.ts`
  `codexRecordToItems()` (~L12–63). The `response_item` path filters to
  `role === 'assistant'` (~L39) and drops anything else; user/other roles and some
  record shapes are lost or mislabeled. Tool pairing relies on `call_id` (~L86–98)
  and silently drops on mismatch.
- **Fix**: Re-derive classification against **real rollout JSONL** captured from a
  live Codex session, then rework the parser to: map `event_msg` user_message →
  user; map `response_item` message by its actual role (user *and* assistant);
  classify `function_call` / `function_call_output` as tool call/result with
  resilient id pairing; and handle reasoning/encrypted items explicitly (skip
  rather than mislabel). Keep `firstCodexPrompt`/title behavior intact.
- **Test**: golden-file unit test — a captured Codex rollout fixture in →
  expected `TranscriptItem[]` out (roles, tool pairing, ordering).

### A5. Codex (and others) not pinned to bottom on switch-in; scroll jumps
- **Problem**: Switching into a Codex pane often lands mid-scroll and jumps around.
- **Root cause**: `apps/web/src/ChatView.tsx`. The initial-scroll one-shot
  (`didInitialScroll`, ~L165–175) keys off `blocks.length` going 0→N; with the
  keep-mounted panel deck a pane that already had blocks doesn't re-fire on
  switch-in. Async markdown/code layout after switch-in shifts height → jumps. The
  `reset:true` transcript batch has no dedicated snap.
- **Fix**: (1) Snap to bottom when a pane becomes visible/active if pinned. (2)
  Force-pin on a `reset:true` transcript batch. (3) Re-pin after content layout
  settles via a `ResizeObserver` on the stream while `pinnedToBottom` is true
  (instead of relying on one rAF). Generalizes to all chat agents.
- **Test**: Playwright harness — switch between two chat panes and assert the
  scroller is at the bottom after switch-in; unit test for the reset-pin path if
  isolable.

---

## Workstream B — Chat view (frontend)

### B1. Minimap markers don't match scroll position; clicks land wrong
- **Problem**: The birds-eye minimap's tick positions and the viewport box don't
  correspond to the real scroll position, so clicking scrolls to the wrong place.
- **Root cause**: `apps/web/src/ChatView.tsx` `Minimap` (~L669–763) +
  `apps/web/src/chat.ts` `minimapSegments` (~L74–89). Tick heights are **log-
  weighted by content length** (`seg.weight/totalWeight`), but the viewport box
  (`scrollTop/scrollHeight`, ~L686) and `scrubTo` (~L700–708) are **linear** in
  scroll space. Two coordinate systems → permanent mismatch.
- **Fix**: Drive the minimap from **measured DOM offsets**. For each rendered
  block (`[data-block]`), compute `top = offsetTop/scrollHeight` and
  `height = offsetHeight/scrollHeight` against the scroller. Position ticks
  absolutely by those ratios (color by role/answer as today). The viewport box and
  `scrubTo` already use the linear scroll space, so all three now share one space.
  Re-measure on the existing scroll listener, on `ResizeObserver`, and when blocks
  change. Replaces the log-weight geometry (keep weighting only as a fallback
  before first measurement, or drop it).
- **Test**: unit test the offset→ratio mapping helper; Playwright harness check
  that clicking a known user tick scrolls that block into view.

### B2. Chat view restyle — "transcript / document" direction
- **Problem**: Chat styling is very basic.
- **Fix**: Adopt the approved Direction B in `ChatView.tsx` (and `index.css`
  `.chat-md` as needed):
  - Full-width column (wider max than the current 760px), no bubbles.
  - **Role rail only on user + final Answer** — user = accent rail (blue/identity),
    Answer = primary (amber) rail. Intermediate assistant narration: **no rail**,
    just well-typeset prose. System/tool stay quiet.
  - Refined header row per message (role name + optional time), improved spacing,
    line-height, and code-block styling (window bar, mono, syntax-tinted).
  - Tool rows: quiet monospace, collapsible, indented result.
  - AskUserQuestion card + activity badge restyled to match.
  - Preserve existing behavior: search highlight/dim, pending optimistic bubbles,
    minimap, jump-to-bottom, composer.
- **Test**: Playwright harness screenshot/visual sanity at desktop + mobile widths;
  no logic regressions in search/scroll.

### B3. Image input in the composer
- **Problem**: No way to attach images; the attach button is a disabled
  "coming soon" placeholder (`ChatView.tsx` ~L398–407).
- **Design**:
  - **Composer UX**: enable the attach button (file picker, `accept="image/*"`,
    multiple); handle clipboard **paste** of image data; handle **drag-and-drop**
    with a **dropzone overlay** shown while a drag is over the composer. Show
    thumbnail chips with a remove (×) affordance for pending attachments.
  - **Delivery**: upload image bytes to the machine that hosts the session, write
    them to a Podium temp dir (e.g. `~/.podium/uploads/<sessionId>/<uuid>.<ext>`,
    **outside the repo** so the worktree isn't polluted), and insert the absolute
    file path into the outgoing prompt text. Claude Code reads images referenced by
    path. Best-effort native paste passthrough for agents/terminals that accept it
    is a secondary enhancement, not the primary path.
  - **Protocol/transport**: new tRPC mutation (e.g. `sessions.uploadImage`
    `{ sessionId, filename, mimeType, dataBase64 }` → `{ path }`) routed through
    the relay to the session's daemon, mirroring how `input` is routed, so the file
    lands on the daemon host. The prompt is then sent via the existing `sendText`
    path with the path(s) prepended/appended. Tag the user transcript item with the
    existing `TranscriptTag { kind:'image' }` so the chip renders.
  - **Cleanup (GC)**: a periodic sweep removes upload files older than a TTL
    (e.g. 24h) and removes a session's upload dir on session close/removal. Files
    are never deleted before the agent has had the chance to read them (TTL ≫ a
    turn); GC runs on the daemon host that owns the files.
- **Test**: unit test the upload-path + GC sweep (age/TTL, session-close removal);
  Playwright harness for paste + drag-drop overlay + picker producing a chip and a
  path-bearing prompt. Confirm a real image lands in Claude Code.

---

## Workstream C — Sidebar / Information architecture (frontend)

Files: `apps/web/src/Sidebar.tsx`, `apps/web/src/derive.ts`
(`sidebarSections`), `apps/web/src/store.tsx`, plus settings (Workstream D store).

### C1. Restructure sidebar sections
New top-to-bottom structure:
1. **Top icon button bar** (existing command-center / superagent / usage /
   settings row) — **add Search and Add-repo here**, moved out of the WORKTREES
   header.
2. **WORK ITEMS** (new umbrella section), containing in order:
   - **NEEDS YOUR ATTENTION** — sessions that are waiting on you (AskUserQuestion /
     permission), finished/idle, or errored/exited. Always expanded.
   - **WORKING** — sessions actively running (phase working/compacting).
     **Collapsed by default**; the collapsed header shows a **count** of sessions
     inside (e.g. "WORKING · 3"). Expandable to list them.
   - **PINNED PANELS** — the existing pinned individual sessions.
3. **WORKTREES** header (moved to sit **above** the pinned worktrees), then:
   - **PINNED WORKTREES**
   - regular repos / worktrees (subject to sort — C2).
- **Derivation**: extend `sidebarSections` to compute the attention/working
  partitions from `SessionMeta.agentState.phase` + status. **Precedence rule (no
  duplication):** pinned sessions always stay in **PINNED PANELS** (their status
  dot already conveys state), so the NEEDS YOUR ATTENTION and WORKING buckets show
  only **unpinned** sessions — surfacing the ones you'd otherwise lose track of. An
  unpinned session falls into exactly one bucket: attention (waiting/finished/
  errored) takes precedence over working; sessions that are neither aren't in WORK
  ITEMS at all. The WORKING collapsed/expanded state is remembered (localStorage),
  defaulting to collapsed.
- **Test**: unit test the partitioning (given sessions with mixed phases/status →
  correct buckets + working count); Playwright harness for collapse/expand + count.

### C2. Repo reorder + sort selector
- **Selector**: a sort control in the WORKTREES area with three modes:
  `alphabetical`, `lastUsed`, `custom`.
- **Default**: `lastUsed` (most-recently-active repo first; "last used" derived
  from the most recent session activity across the repo's worktrees).
- **Custom order**: drag-to-reorder repos; the first manual reorder writes a custom
  order and switches the selector to `custom`. Reordering is available regardless
  of selected mode but only takes visual effect (and is shown) in custom.
- **Persistence**: store `sidebar.repoSort` (mode) and `sidebar.repoOrder`
  (array of repo ids) in `PodiumSettings` (per-user, server-side, round-tripped via
  the existing settings get/set). New repos not in `repoOrder` sort to the end (by
  last-used) until placed.
- **Test**: unit test the sort comparator for each mode + new-repo fallback;
  Playwright harness for drag-reorder persisting and flipping to custom.

---

## Workstream D — Settings (frontend + core)

Files: `packages/core/src/settings.ts` (schema + `normalizeSettings`),
`apps/web/src/SettingsView.tsx`, `apps/web/src/theme.tsx`,
`apps/web/index.html` (anti-flash), `apps/web/src/AgentPanel.tsx`.

### D1. "System" theme mode
- **Problem**: Themes are manual light/dark only; no system-follow option.
- **Fix**: Theme **mode** becomes `light | dark | system` (preset stays
  `shadcn | podium`). When `system`, resolve via
  `matchMedia('(prefers-color-scheme: dark)')`, apply the resolved `.dark` class +
  `data-theme`, and **live-update** on the media-query `change` event. Update:
  - `theme.tsx` `readStoredTheme`/`applyTheme`/`ThemeProvider` to carry the
    three-way mode and subscribe to the media query when in system mode.
  - `index.html` anti-flash script to resolve system → light/dark before mount.
  - `<meta name="theme-color">` to track the resolved mode.
  - `SettingsView.tsx` AppearanceSection to offer a 3-way mode toggle
    (Light / Dark / System).
  Storage stays in localStorage (`podium.theme.mode` now accepts `system`).
- **Test**: unit test the resolver (system + prefers-dark → dark; live change
  flips); Playwright harness toggling to System and emulating color scheme.

### D2. New agents start on the native screen by default (configurable)
- **Problem**: New sessions choose native/chat by device heuristic only.
- **Fix**: Add `sessionDefaults.startScreen: 'native' | 'chat' | 'auto'` to
  `PodiumSettings` (default **`native`**; migrate via `normalizeSettings`). In
  `AgentPanel.initialMode()`, use the setting for the initial mode (`auto` keeps
  the current device heuristic). A manual per-panel Native/Chat toggle still wins
  and should persist **per-session** (not as a single global), so toggling one
  panel doesn't change the default for others. Surface the setting in the Sessions
  tab of `SettingsView.tsx`.
- **Test**: unit test `initialMode` for each setting value (+ chat-incapable agents
  like shell forced to native); Playwright harness creating an agent and asserting
  it opens native.

---

## Cross-cutting

### PWA bottom spacing
- **Problem**: The installed PWA leaves too much empty space at the bottom.
- **Approach**: Audit the app-shell height + safe-area handling (root layout,
  `index.html`, mobile layout). Likely causes: using `100vh` (includes absent
  browser chrome in standalone) instead of `100dvh`, or a bottom safe-area inset
  applied both globally and in the composer (double inset). Fix: use `100dvh` for
  the shell and apply `env(safe-area-inset-bottom)` exactly once (composer). Verify
  in standalone display mode in the browser harness. (Folded into Workstream B/D
  frontend work.)

### Protocol / schema changes
- `PodiumSettings`: add `sidebar { repoSort, repoOrder }`,
  `sessionDefaults.startScreen`. Bump defaults + `normalizeSettings` migration.
- New tRPC `sessions.uploadImage` (routed to daemon) + relay message for the
  upload, mirroring `input` routing.
- No change to `TranscriptItem` (reuse `TranscriptTag { kind:'image' }`).

### Verification strategy
- **Unit / TDD** for pure logic: Grok binding, title debounce/filter, Codex
  classification (golden file), minimap offset mapping, sidebar partitioning, repo
  sort comparator, theme resolver, `initialMode`, upload GC.
- **Runtime browser verification (required for interactive UI)**: drive the
  sidebar restructure + reorder, chat restyle, image paste/drag-drop, minimap
  click, native resize, and scroll-pin in the committed Playwright harness with
  real clicks/drops — not just build + review. (Per the lesson that clickable UI
  must be runtime-tested before being called done.)
- **Host**: the dev host redeploys from local main on HEAD move; protocol/settings
  changes require deploying web + backend together; a settings-schema change may
  need a manual `bun install` only if deps change (they don't here).

### Sequencing (phased, one branch)
1. Backend harness bugs (A1–A5) — independent, mergeable early, mostly unit-tested.
2. Minimap fix (B1) + scroll-pin (A5) — small, high-value chat correctness.
3. Settings schema (D1, D2) + PWA spacing — low risk, unblock sidebar persistence.
4. Sidebar restructure + reorder/sort (C1, C2).
5. Chat restyle (B2).
6. Image input (B3) — largest; depends on composer being stable post-restyle.

### Risks / open items
- Codex classification depends on capturing accurate live rollout JSONL; the parser
  rework is only as good as the fixture. Capture first.
- Image native-paste passthrough is genuinely fragile; treat as best-effort, keep
  the path-based delivery authoritative.
- Per-session panel-mode persistence changes current global behavior — intentional;
  call it out in the plan.
- Multi-machine: image upload must write on the daemon host that owns the session;
  ensure routing is correct even though current deploys are single-host.
