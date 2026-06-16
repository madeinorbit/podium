# Chat View ↔ Native Realtime Sync — Design

**Date:** 2026-06-16
**Status:** Approved (brainstorming) — pending spec review
**Scope:** `apps/web` (ChatView, store), `apps/server` (relay/router/protocol), `packages/agent-bridge` (Claude transcript parser), `packages/terminal-client` (prompt extraction)

## Problem

The web **chat view** (`apps/web/src/ChatView.tsx`) is a Claude-app-style render of a
session's structured transcript with its own composer. Four gaps make it feel
disconnected from the live agent:

1. **Misclassification** — some Claude messages render as a "You" bubble when they
   are not the user's turn.
2. **No activity indicator** — the chat gives no "thinking…" signal while the agent
   is working; the user can't tell a submitted prompt is being processed.
3. **Submitted message vanishes** — `send()` clears the composer and the message
   only reappears once the transcript tail echoes it back (latency, sometimes a
   visible gap). It should move into a "You" bubble immediately.
4. **Composer ↔ native divergence** — the chat draft and the native PTY prompt are
   unrelated. A prompt half-typed in native does not appear in chat (or on another
   device), and vice-versa.

## Key architectural findings

- **Claude live transcript** is produced *only* by `claudeRecordToItems`
  (`packages/agent-bridge/src/transcript/claude.ts`) via the tailer. There is **no
  heuristic role-guessing** — role comes from the JSONL record `type`. So the
  misclassification is a parser gap, not a fuzzy classifier.
- The parser renders **every** `type:'user'` record with text as a `user` item,
  including Claude Code's **non-conversational injected records**: `isMeta` entries,
  `<command-name>`/`<local-command-stdout>` wrappers, and `<system-reminder>`
  blocks. Those are not the user's turn but render as "You".
- **Agent state already exists** in the store. `SessionMeta.agentState.phase`
  (`working`/`compacting`/`idle`/…) and `SessionMeta.busy` are live; `derive.ts`
  already maps them via `agentBadge(meta)`. The chat view simply doesn't read it.
- **Native input is write-only.** The backend keeps **no terminal screen model**
  (it forwards raw PTY bytes; only a `SCREEN_RESET` regex resets the replay
  buffer). The **only** emulator is the visible xterm, mounted **only in native
  mode** (`AgentPanel` renders `ChatView` *or* the terminal, never both). So the
  in-progress native prompt text is recoverable only by scraping the xterm buffer
  while a native terminal is mounted. The store already documents this:
  `store.tsx:64` — *"The native PTY input line is opaque bytes we can't read
  back."*
- The chat **draft already syncs across web views** of a session via the store
  (`drafts[sessionId]`, `setSessionDraft`), but it is **local to one client**.

## Non-goals

- **Flawless key-by-key bidirectional editing** of the native TUI line. Fighting
  Claude's own line editor (autocomplete, slash menus, cursor) is not realistic and
  not attempted. Phase 2 delivers *prompt continuity*, not a shared text field.
- Chat→native per-keystroke injection. `chat→native` stays **send-only** (type the
  full text + Enter), exactly as today.
- Mirroring for non-Claude kinds in Phase 2 (Grok/Codex prompt-box extraction is a
  later follow-up; the extractor is written to return `null` for them).

---

## Phase 1 — Clean wins (asks 1, 3, 4 + draft consistency)

Independent, low-risk, shippable on its own.

### 1.1 Fix Claude role misclassification

**Where:** `packages/agent-bridge/src/transcript/claude.ts`, `userItems()`.

**Change:** a `type:'user'` record is only a real user turn when it is genuine
conversational input. Reclassify/skip the injected variants:

- `r.isMeta === true` → **drop** (Claude's own bookkeeping; never a user bubble).
- Content that is wholly an injected wrapper — `<command-name>…`,
  `<local-command-stdout>…`, `<command-message>…`, `<system-reminder>…` — →
  emit as a **`system`** item (so it's visible but not tagged "You"), or drop if
  empty after unwrapping. Detect by leading/whole-string tag match on the joined
  text.
- Plain text / image / document user content → unchanged (`user`).
- `tool_result` blocks → unchanged (`tool`).

**Method (TDD):** capture a real Claude JSONL record that currently mis-renders
(from `~/.claude/projects/**/*.jsonl`), add it as a fixture in
`claude.test.ts`, write the failing assertion (expect `system`/dropped, not
`user`), then implement. Keep the classifier a pure function over the record.

**Risk:** over-dropping real user turns. Mitigate by matching only the known
wrapper tags / `isMeta`, never on heuristics like length or content tone.

### 1.2 Optimistic "You" bubble

**Where:** `ChatView.tsx`.

- Add local pending state: `pending: { id: string; text: string; at: number }[]`.
- `send()` appends a pending item *before* the network call (keep clearing the
  draft and pinning to bottom). Render pending items after `blocks`, styled as a
  `chat-user` block with a subtle "sending" affordance (e.g. reduced opacity +
  a small clock until reconciled).
- **Reconciliation (single rule):** keep a set of transcript `user`-item ids seen
  on the previous render. When items update, for each *newly appeared* `user` item
  whose trimmed text equals a pending entry's trimmed text, remove the **oldest**
  matching pending entry (FIFO). The real block then owns that turn (correct
  ordering/markdown); the optimistic one disappears with no flicker.
- **Fallback:** if no echo arrives within a timeout (e.g. 30 s), keep the pending
  bubble but drop the "sending" affordance — the prompt was still sent. (Chat is
  only offered for transcript-capable sessions, so an echo is expected, but a slow
  tail must not lose the bubble.)
- On send failure (`sendText` rejects, or session not sendable), mark the pending
  bubble as failed with a retry affordance rather than silently dropping it.

### 1.3 Live thinking indicator

**Where:** `ChatView.tsx`, reading `session.agentState` / `session.busy`.

- Render a "thinking…" row pinned at the bottom of the scroll area while the agent
  is active: `agentState.phase === 'working' || 'compacting'`, or (for
  uninstrumented kinds) `session.busy === true`. Reuse `agentBadge(session)` tone
  so it matches the state dots; show the phase label (`working`/`compacting`).
- **Optimistic show:** display it immediately after `send()` (a short-lived local
  "submitted" flag) so there's instant feedback before the first `working` event,
  clearing once real `agentState` reports `working` (which then keeps it shown) or
  resolves to `idle`/`needs_user`.
- When `phase` resolves to `needs_user` / `idle(question|approval)`, surface that
  inline too (e.g. "waiting for you") instead of "thinking", reusing `agentBadge`.

---

## Phase 2 — Native → chat prompt mirror (best-effort)

Delivers prompt continuity: a prompt being typed in the native terminal appears in
the chat composer, including on another device. Explicitly best-effort and scoped
to Claude.

### 2.1 Extraction (client, native mode)

**Where:** `packages/terminal-client` (pure helper) + `AgentPanel.tsx` /
`session-mount` wiring.

- Pure, unit-tested function
  `extractClaudePromptDraft(screenLines: string[]): string | null`:
  - Locate Claude's prompt box near the bottom (rounded box: `╭─…─╮` / `│ > … │` /
    `╰─…─╯`).
  - Extract text after the `> ` marker; join wrapped continuation lines; trim box
    chrome.
  - Return `null` when the box is absent or shows a menu/overlay (slash-command
    palette, autocomplete) — *never clobber the draft on ambiguity*.
  - Treat placeholder text (empty `> `) as `""`.
- While a native terminal is mounted **and this client controls it**, after each
  frame (debounced ~120 ms) read the bottom rows from the xterm buffer, run the
  extractor, and if the result changed publish it (2.2). Only the **controller**
  publishes, to avoid multi-writer races from passive viewers.

### 2.2 Publish + reflect (cross-client draft sync)

**Protocol (`packages/protocol/src/messages.ts`):**
- Client→server: `SetSessionDraftMessage { type:'setSessionDraft', sessionId, text }`.
- Server→clients: `SessionDraftChangedMessage { type:'sessionDraftChanged', sessionId, text }`.
- Mirror the existing `sessionAgentStateChanged` pattern (a dedicated low-frequency
  WS message, not a full `SessionMeta` push).

**Server (`apps/server/src/relay.ts` + `router.ts`):**
- Keep an **ephemeral** `draftBySession: Map<sessionId, { text, updatedAt }>` (not
  persisted — drafts are transient). On `setSessionDraft`, store and broadcast
  `sessionDraftChanged` to **other** clients (not the sender).
- Include the current draft map in the **initial state sync** so a freshly
  connected client (e.g. mobile opening chat) immediately sees the in-progress
  native prompt.

**Store (`apps/web/src/store.tsx`):**
- On `sessionDraftChanged`, update `drafts[sessionId]`. The composer already binds
  to `drafts[sessionId]`, so it reflects native automatically — no ChatView change
  needed for the reflect direction.
- `setSessionDraft` (already called on composer edits) additionally sends
  `setSessionDraft` over the wire so chat edits propagate to other views/devices.

### 2.3 Conflict / echo handling

- **Focused-editor-wins.** A pane is either native or chat, so within one client
  there is no self-conflict. Across clients: the side currently being edited
  publishes; the native extractor only publishes while the native terminal is the
  controller. Last-write-wins is acceptable for a best-effort draft.
- The native extractor returning `null` (menu/overlay/non-Claude) **does not**
  publish — the last good draft stands.
- No keystroke is ever injected into native from a draft change; `chat→native`
  remains send-only. This removes any feedback loop where extraction → draft →
  re-injection could oscillate.

---

## Data flow (summary)

```
Phase 1:
  user types in composer ──► drafts[sessionId] (store, already shared across web views)
  user hits send ──► append pending "You" bubble ──► sessions.sendText ──► PTY
  agentState.phase=working (WS) ──► thinking indicator
  JSONL echo ──► transcript item (role=user) ──► reconcile, drop pending

Phase 2 (Claude, native mounted, controller):
  PTY frame ──► xterm buffer ──► extractClaudePromptDraft ──► setSessionDraft (WS)
            ──► server draftBySession ──► sessionDraftChanged (WS, other clients)
            ──► store.drafts[sessionId] ──► chat composer reflects it
```

## Testing

- **Parser (1.1):** unit fixtures in `claude.test.ts` — `isMeta`, command-stdout,
  system-reminder records classify as `system`/dropped; real user turns and
  tool_results unchanged.
- **Extractor (2.1):** unit fixtures of captured Claude screen snapshots (empty
  prompt, single-line, wrapped multi-line, slash-menu open → `null`, non-Claude →
  `null`).
- **Server (2.2):** `relay.test.ts` — `setSessionDraft` stores + broadcasts to
  others not sender; initial sync includes draft map.
- **ChatView (1.2/1.3):** component tests for optimistic bubble lifecycle
  (append → reconcile on echo → failure path) and indicator visibility per phase.
- **Manual / Playwright:** the committed browser harness (per memory) can drive a
  live session — type in native, observe the chat composer reflect it; submit in
  chat, observe the You-bubble + thinking indicator.

## Rollout

- Phase 1 lands first and is independently valuable.
- Phase 2 protocol changes require deploying **web + backend together** (per the
  protocol-version memory) — new message types are dropped by schema validation if
  one side is stale.
