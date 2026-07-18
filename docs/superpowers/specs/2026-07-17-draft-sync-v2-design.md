# Draft Sync v2 — chat ↔ native composer synchronization (experimental)

Date: 2026-07-17 · Issue: POD-816 · Status: approved design (human-approved 2026-07-17)

## Goal

One draft per session, visible and editable in both the chat view and the native TUI view,
character-by-character while the session is live, persisted server-side so it is never lost,
with catchup + conflict resolution when sessions detach/reattach. Chat typing latency stays
local — the chat composer is never latency-coupled to the PTY round-trip. Fixes the codex
doubled-text bug structurally (not with more guards). Behind an experimental flag, default off.

## Human decisions (locked)

1. **Bidirectional merge** — both composers are editable replicas; neither is "the" truth
   while live. Rationale: chat typing must be low-latency and never coupled to native
   session latency.
2. **Daemon-side engine** — scrape/inject moves from the browser to the daemon (which owns
   the PTY). Works with zero browsers attached, mobile included.
3. **Versioned LWW + edit lease** conflict model (no diff3, no CRDT).

## Current state (what this replaces)

- `packages/terminal-client/src/prompt-extract.ts` — `extractClaudePromptDraft()` (box
  scrape) and `extractCodexPromptDraft()` (single `›` row — **broken for multiline**,
  POD-506).
- `apps/web/src/AgentPanel.tsx` (~lines 255–485) — client-side 150ms sampler (native→chat,
  controller+focus gated) and one-shot Ctrl-U flush (chat→native, on entering native mode).
- Server: `session_drafts` table (`session_id, text, updated_at`), debounced persist in
  `apps/server/src/modules/sessions/service.ts` (`draftBySession`, `draftWriteTimers`),
  replay on attach, `draft` broadcast in protocol + `connection.ts` (`draftObservers`,
  `publishDraft`/`onDraft`). `Session.draftUpdatedAt` seeds inbox ordering.
- Store: `apps/server/src/store/sessions.ts` `---- composer drafts ----` section.

The codex doubling mechanism (understood, must be covered by a regression test): codex
`Ctrl-U` only kills to line-start of the current line (whole-buffer clear is unbound by
default), and the single-row scrape truncates multiline composers, so the equality guards
misfire and the flush types the full draft on top of surviving lines.

## Research facts (verified 2026-07-17 against docs + source; cite in code comments where used)

Neither harness has an official composer API. Scrape + synthetic keystrokes is the only path.

**Claude Code**: no read API (hooks fire post-submit); launch-time prefill via deep links
only; `\`+Enter and Shift+Enter for newlines; paste may collapse to `[Pasted text #N]`
placeholder in the composer (expands on submit).

**Codex** (Rust TUI, openai/codex): `composer_text()` exists but is internal/test-only; the
app-server protocol carries finalized turns only, never draft state; `codex "prompt"`
submits (doesn't prefill). Bracketed paste supported (one `TuiEvent::Paste`); pastes ≥1000
chars collapse to `[Pasted Content N chars]` placeholder (expanded at submit). Plain chars
arriving ≤8ms apart trigger the PasteBurst heuristic; Enter within a 120ms paste window
inserts a newline instead of submitting. Newline: **Ctrl-J** is the reliable cross-terminal
binding (Shift+Enter needs kitty/modifyOtherKeys). Clear: **Ctrl-C only when the composer is
non-empty** wipes the whole draft (stashed to history); **Ctrl-C on an empty composer arms
quit / interrupts a running turn — never send blind**. `kill_whole_line` is unbound by
default. Known upstream hazard: kitty keyboard-enhancement doubles Enter/Backspace
(openai/codex#8324) — ensure our PTY never advertises kitty enhancement, or set
`CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT=1` in the codex spawn env.

## Design

### 1. Data model — versioned draft document

Extend `session_drafts` (additive migration; follow the repo's additive-only migration
policy and numbering ledger):

```
session_drafts: session_id PK, text, rev INTEGER, origin TEXT, edited_at, history JSON
```

`DraftDoc { sessionId, text, rev, origin: clientId | 'native' | 'seed', editedAt, history }`

- `rev`: server-assigned monotonic sequence per session; the server is the single sequencer.
- LWW by rev. Superseded non-empty text goes into `history` (small ring, e.g. last 5,
  deduped) so a lost race never destroys typing.
- Wire protocol (additive, backward-compatible — old clients keep working with the plain
  `draft` shape): `draft` broadcast gains `{rev, origin, editedAt}`; new client→server
  `draftEdit {sessionId, baseRev, text}`. Server accepts stale `baseRev` from a
  lease-holding sender, else rejects with the current doc; the client rebases (replaces its
  composer only if not mid-typing).

### 2. Topology

- **Chat replicas** (web ChatView, mobile): optimistic local echo; keystrokes render
  instantly; publish coalesced (~30–50ms) whole-text `draftEdit`s. Whole-text, not diffs.
- **Native replica**: a new daemon-side **ComposerSync engine** — one headless VT screen per
  flagged live session (`@xterm/headless`; same emulator family as the client so
  `prompt-extract` semantics carry over). Scrapes on PTY output (frame-coalesced), publishes
  native edits upstream; injects chat-originated edits via harness keystroke ops.
- The browser sampler + flush in AgentPanel are **disabled when the flag is on and the
  daemon advertises the capability** (daemon capability bit in the wire handshake); they
  remain the fallback for old daemons and flag-off.

### 3. Arbitration — soft edit lease (~1.5s)

- A replica that saw local typing within the lease window holds a soft lease (derived from
  edit timestamps server-side; no extra messages).
- Chat lease held → daemon **defers injection** (queues; injects on lease expiry).
- Native lease held (two signals: scrape deltas AND a passive **input-byte tap** — the
  daemon already sees every client→PTY byte; any keystroke activity marks the native
  replica hot; no byte parsing) → chat edits still accepted; conflicts resolve by rev;
  losers go to history.
- A replica never applies a remote update into a composer it is actively editing; it
  applies on its own lease expiry.

### 4. Adapter interface (harness-specific code lives ONLY here)

Home: the daemon's harness adapter layer (align with the existing HarnessAdapter seam from
the arch redesign; keep the pure extraction functions in a shared package so client
fallback and daemon reuse one implementation — move/extend `prompt-extract.ts` rather than
fork it).

```ts
interface ComposerDriver {
  /** null = no clean composer on screen (overlay/splash/menu) — never clobber on null. */
  extract(screen: ScreenLines): string | null
  /** Composer present & safe to write (agent not streaming, no overlay). */
  injectable(screen: ScreenLines): boolean
  /** Byte sequence clearing the WHOLE composer given its current text; null = cannot clear safely now. */
  clearSequence(currentText: string): string | null
  /** Byte sequence entering text WITHOUT submitting. */
  typeSequence(text: string): string
  /** Post-injection check; 'placeholder' = harness collapsed the paste (acceptable). */
  verify(screen: ScreenLines, expected: string): 'match' | 'placeholder' | 'mismatch'
}
```

- **Claude driver**: existing box extractor; `clearSequence` = Ctrl-U per line (line count
  from the scrape); multiline typing via `\`+Enter continuations; verify accepts
  `[Pasted text #N]` collapse.
- **Codex driver**: multiline-aware extractor — capture continuation rows below the `›` row
  up to the status/hint line (**this is the POD-506 fix**; fixture-test heavily);
  `clearSequence` = Ctrl-C **only when current scrape shows non-empty**, else null (and an
  empty composer needs no clear); `typeSequence` = one bracketed-paste burst
  (`ESC[200~…ESC[201~`) with newlines as-is inside the paste (bracketed paste makes them
  literal), Ctrl-J only for non-paste fallback; verify accepts the ≥1000-char placeholder.
  Set `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT=1` in codex spawn env (kitty doubling #8324).

### 5. Injection state machine (engine-owned; the doubling killer)

```
IDLE → (remote draft newer than native, no native/chat lease, injectable)
     → PRECHECK: scrape stable across 2 consecutive frames AND equals last-known native text
     → WRITE: clearSequence + typeSequence sent as ONE write
     → VERIFY: within N frames expect match/placeholder
        mismatch → DO NOT retry blind: republish scraped truth as a native edit, back off
                   (exponential), after K consecutive mismatches self-demote (see §7)
```

Exactly one in-flight injection per session, with timeout. Idempotency: an injection's
expected result is recorded so the engine's own echo is never re-published as a new native
edit (seed the scrape comparator with the expected text, like today's `lastPublished`).

### 6. Catchup on attach/resume/reattach

On session live (spawn, resume, daemon reattach): wait for `extract() !== null` (composer
settled), scrape native text N, compare doc D:

- `N == D.text` → done.
- `N` empty, `D` non-empty → inject D.
- `N` non-empty, `D` empty → publish N.
- Both non-empty, different → **D wins iff `D.editedAt` > session's last-live timestamp**
  (chat edits while the session was down), else N wins. Loser → history.

### 7. Rollout, failure containment, telemetry

- Experimental setting (server settings + per-session override), default OFF. Flag off =
  exactly today's behavior, zero new code paths active.
- Self-demotion: repeated verify-mismatch or emulator drift → engine drops to **read-only
  mode** (scrape/publish only, no injection) for that session and emits telemetry. Sync
  degrades to today's one-direction rather than corrupting a composer.
- Counters: injections, verify failures, lease conflicts, demotions, catchup outcomes.

### 8. Testing

- Extractor fixture suites: codex multiline (POD-506 regression), placeholders (both
  harnesses), overlays/menus/splash, dim placeholder, resize wraps.
- Injection state-machine unit tests with a scripted fake screen/PTY.
- Daemon engine against REAL harness PTYs via the existing `harness-exec` smoke infra
  (`apps/daemon/src/harness-exec.smoke.test.ts` pattern): type-in-native→doc updates;
  inject→verify; the codex doubling regression (multiline draft, repeated flush cycles,
  assert no duplication ever).
- Two-client race tests (lease arbitration) and the reattach-conflict matrix of §6.
- e2e (Playwright): chat-typing mirrors to native and back, flag on/off, old-daemon fallback.

## Build phases (each an internal child issue; keep commits coherent per phase)

1. Protocol + server: versioned DraftDoc, additive migration, `draftEdit`, lease tracking,
   history ring. Backward-compatible broadcast.
2. Daemon: headless screen plumbing + ComposerSync engine in READ-ONLY mode (scrape/publish
   only) behind the flag. This alone ships value: drafts sync native→everywhere with no
   browser attached (and gives the server draft visibility POD-693 wanted).
3. ComposerDriver extraction for both harnesses, shared-package refactor of
   prompt-extract, POD-506 fix + fixtures.
4. Injection state machine + lease arbitration + catchup (§5, §6) — full bidirectional.
5. Client: capability handshake, retire sampler/flush under flag, optimistic `draftEdit`
   with rev protocol (web; mobile client-core viewmodel follows the same protocol).
6. Smoke/e2e suites, telemetry counters, self-demotion polish.

## Non-goals

- No CRDT/diff3 merging; no keystroke-level input *parsing* (the byte tap is an activity
  signal only); no sync for harnesses without a ComposerDriver (they keep today's
  behavior); no draft-history UI beyond storage (surfacing "restore previous draft" is a
  possible follow-up).

## Implementation status & caveats (POD-859 — updated after Fable-5 review 2026-07-18)

What shipped in branch `issue/859-draft-sync-daemon-engine` (all behind `draftSync.enabled`,
default OFF), and the honest gaps:

- **Phase 5 client is PARTIAL.** The daemon-engine capability signal ships and the browser
  retires its native sampler + chat→native flush when the engine is active. But **no client
  actually sends the versioned `draftEdit` yet** — the web chat composer still publishes
  `setSessionDraft`, which the server routes through the versioned engine unconditionally
  (never rejected). The optimistic `draftEdit`-with-rev rebase path and the lease-rejection
  reply exist server-side and are test-only on the client. **Deferred** (tracked): the
  optimistic client protocol + net-new mobile draft sync (mobile has no session-draft path
  today). (Reviewer finding 9.)
- **Injection is gated on agent-idle.** The engine scrapes/injects only while the agent
  phase is `idle` (fed from the daemon's agent-state tracker) — never during a turn or an
  overlay, so a chat edit can't Ctrl-C a running codex turn and a submitted transcript `›`
  is never read as the live composer. (Reviewer blocker 2.)
- **`verify` is whitespace-normalized**, so a line wider than the PTY (which scrapes back
  wrapped, with an inserted newline) is not a false mismatch that would self-demote the
  feature. Verify is a coarse "did it land" check, not exact fidelity. (Reviewer blocker 3.)
- **Schema robustness.** The versioned-draft migration is numbered **011, not 010**: the
  arch-v2 lineage already ships a different 009/010 (issues-audience /
  issues-drop-verifying-stage), and the forward-only runner skips by version (never by
  name), so a 010 here would be skipped forever on that lineage. 011 runs on both a plain
  OSS DB (at 9) and an arch-v2 DB (at 10); gaps are legal. As belt-and-suspenders the
  versioned store reads/writes are ALSO column-guarded (with a one-time warn): on any
  schema-ahead DB where 011 is skipped, boot degrades to the legacy draft shape instead of
  crashing — flag-OFF boot never depends on the migration having run. Full flag-ON
  persistence still needs the columns (added by 011 on a normal DB). (Reviewer blocker 1 +
  re-review B.)
- **Runtime flag-toggle residue** (reviewer note 8): toggling `draftSync.enabled` at runtime
  is not fully live — the per-session `draftSyncEngine` meta only refreshes on the next
  `bind` (spawn/reattach), and the codex `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT` env is
  applied only at spawn. Flip the flag, then respawn/reattach a session for it to take
  full effect. Flag-OFF→ON mid-session is best-effort until the next bind.
- **Claude injection is proven only against a scripted fake PTY** that models Ctrl-U wiping
  the whole composer; the codex doubled-text regression is likewise a scripted-PTY unit
  test (deterministic). A **real-harness injection smoke** (spawn codex, inject a multiline
  draft, assert zero duplication) needs a codex binary and stays a CI/reviewer follow-up.
  (Reviewer note 6.)
