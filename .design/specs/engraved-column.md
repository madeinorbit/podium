# Engraved column — Tray + Super agent chat

Dimension spec for the middle "engraved" column of the Podium redesign. **Updated for handoff v2.**
Source of truth: `/home/podium/podium/.design/podium-handoff.html` — sections `#1a` (coloured flow),
`#1b` (slate/uncoloured flow), `#1c` (empty tray), `#1d` (motion grammar), `#2c` (mobile overlay),
build notes `#notes` items 1, 2, 4, 5, 6; **NEW in v2**: `#3b` (Tray / Super agent collapsed inside
the column), `#cnotes` item 3 (collapse rules), `#3d` (whole column as 44px vertical bar), `#3c`
(column-state overview), `#4a`/`#4b` (issue colour palette — consumed here, owned elsewhere).
Product decisions: `/home/podium/podium/.design/decisions.md` (big-bang rollout, every section
resizable, user-assigned 10-colour palette, keep current issue-id scheme).

> **POD-113 update (approved 2026-07-21, mock `.design/POD-113-offer-tray.html` v3.1):** the tray
> goes **global** (all tasks, no issue scoping — §5 replaced), the chat's standing event feed /
> changelog is **removed**, and the tray card contract in §2.3 is superseded by §2.3-v3 below.
> Offer artifacts (`podium offer --artifact`, thumbnails + lightbox) shipped as POD-120.

---

## 1 · Current state

### 1.1 Layout / component

- `apps/web/src/app/AppShell.tsx` — the superagent already IS the center column
  (`sidebar | superagent | workspace | right dock | rail`), collapsible via `superOpen`
  (store flag, also used by `MobileApp.tsx` and `CommandPalette.tsx`), drag-resizable
  320–860px, default 460px (`storageKey: podium:superagent:width`). Plain
  `bg-background` + `border-r border-border` — no engraved surface, no glow, no inset shadows.
- `apps/web/src/features/superagent/SuperagentView.tsx` (861 lines) — the whole column today:
  - 49px header ("Superagent" + Sparkles, open-in-terminal, clear, collapse buttons).
  - 37px scope sub-bar: thread switcher dropdown (Global / per-repo concierge / btw threads),
    "— orchestrating your projects", live `N agents active` dot (uses `isSessionWorking`).
  - Optional collapsed legacy-history block, then embedded `ChatView` bound to the thread's
    headless Podium session, or `FreshThreadComposer` (with `@`-mention menu, voice, BlockCaret).
  - Composer hint row already says `⏵⏵ auto-delegate on (shift+tab to cycle) · ? for shortcuts`.
- `apps/web/src/features/superagent/concierge.ts` — deterministic per-repo thread ids.
- Mobile: `apps/web/src/app/MobileApp.tsx` renders SuperagentView via `superOpen`
  (the design's `absolute inset-0` overlay pattern already exists in spirit).
- **There is no Tray anywhere.** Nothing in the web app renders an issue-scoped
  "needs a human" card stack. The closest things:
  - `apps/web/src/features/issues/IssuePage.tsx:230–248` — a single amber "Needs human" box
    with `issue.humanQuestion` and a **Resolve** button (`issues.clearNeedsHuman`).
  - Sidebar amber badges (worklist) driven by session attention.

### 1.2 Backend data available today (Tray sources audit — NEW CONCEPT ALERT)

| Design need | What exists | Gap |
|---|---|---|
| Issue question ("agent asks: …") | `IssueWire.needsHuman: boolean` + `humanQuestion?: string` (`packages/protocol/src/messages/issues.ts:117–118`; set/cleared in `apps/server/src/modules/issues/service/crud.ts:492–512`, events `issue.needs_human` / `issue.needs_human_cleared`) | One boolean + one plain string per issue. No timestamp, no asking-session attribution, **no options** → nothing to render answer chips from. |
| Answer chips → deliver answer | `answer_question` MCP tool (`apps/server/src/modules/superagent/tools.ts:250`) types a digit into a session's *native menu* when `phase === 'needs_user' && need.kind === 'question'`; it parses `questions[].options` out of the pending tool input. Server-side/superagent-only — **no tRPC proc for the web**, and it targets session menus, not `humanQuestion`. | Need a web-callable "answer this tray question" path that (a) posts the answer to the asking agent (`send_to_agent` / outbox / issue mail) and (b) clears `needsHuman`. |
| Review card ("ready for review", ✓ Done — merge / Send back / Discuss / session →) | `IssueStage 'review'` + `issue.stage_changed` events, `suggestedStage`/`suggestedReason`, `prUrl`, agent-published `IssuePanel` (todos/artifacts/deferred, `issues.ts:54–73`) | **No first-class review object**: no reviewer summary text, no merge/send-back actions, no record of what the buttons should execute. Genuinely new backend surface. |
| Session-level needs (permission prompts, plan approvals, errored) | `SessionMeta.agentState` — `AgentPhase 'needs_user'`, `AgentNeed {kind: question\|permission, summary}`, `IdleVerdict {question\|approval\|open_todos}` (`packages/protocol/src/messages/runtime-state.ts`); triage helpers `attentionGroup` / `attentionSummary` in `packages/client-core/src/focus.ts` | Exists and is issue-attributable via `SessionMeta.issueId`. Design does not show these explicitly — needs a product decision (§6). |
| Management-op approvals | `ApprovalWire` pending snapshot (`approvalsChanged`, `packages/protocol/src/messages/approvals.ts`), currently a modal `ApprovalDialog` | Candidate tray items; carries `issueId` already. |
| Empty-state "N agents working" spinner | Derivable: sessions filtered to the selected issue (`issueId` / `sessionsForIssue`) × `attentionGroup(s) === 'working'` | Pure client derivation; no backend work. |
| Cross-project event feed | Durable event log: `trpc issues.events` cursor query (`apps/server/src/modules/issues/service/reads.ts:443–449`, `listEventsSince` with `kinds`/`repoPath` filters); rich kinds already emitted (`issue.needs_human`, `issue.stage_changed`, `issue.closed`, `issue.started`, `issue.session_attached`, …) | No web UI consumes it; no "YOU WERE HERE" read cursor for the feed. |
| CTX = selected issue | `selectedIssueId` in the web store; superagent threads are **repo**-scoped (concierge) or global — `sendTurn` takes no issue context | Need issue-context injection per turn + a way for the reply to carry "answering with POD-x context". |
| Issue colour + ID square (POD-128) | Nothing — no colour field on `IssueWire`, ids are internal + `seq` | Owned by the tokens/ID-square dimension; this column consumes it. **Decided (decisions.md + 4a/4b):** user-assigned via colour picker, 10 predefined colours (`#f43f5e #ec4899 #d946ef #8b5cf6 #6366f1 #3b82f6 #06b6d4 #14b8a6 #22c55e #84cc16`); no-colour = slate `#94a3b8` flow; amber/orange band reserved (status collision). Keep the current id scheme (internal + `seq`) rendered in the new square style — POD-prefix wiring comes later. |
| Tray/Super-agent collapsed state persistence | `uiState`-style persisted keys exist (`podium:superagent:width`, `podium.rightPanel`) | No keys for per-section collapse (tray open/closed, super agent open/closed, whole-column 44px bar) — additive localStorage keys. |

---

## 2 · Target design (exact values from the handoff)

All fonts: **Geist** (UI) / **Geist Mono** (IDs, timers, section labels, composer).
`ISSUE` = selected issue's colour (e.g. `#8b5cf6`); when uncoloured, run the identical
mechanics in slate `#94a3b8` (1b). The chat area itself stays **neutral** — only the glow
and the tray items carry the issue colour.

### 2.1 Column shell

- Flex: `flex:1.05 1 0; min-width:0` between sidebar (262px) and native pane (`flex:1.45`).
- Background: `radial-gradient(560px 300px at 50% 12%, rgba(ISSUE, .10), rgba(ISSUE,0) 72%), #0a0a0e`
  (slate variant: `rgba(148,163,184,.09)`; mobile overlay 2c: `radial-gradient(340px 220px at 50% 6%, …)`).
- Engraving: `box-shadow: inset 3px 0 6px -3px rgba(0,0,0,.85), inset -3px 0 6px -3px rgba(0,0,0,.85), inset 0 3px 6px -3px rgba(0,0,0,.85)` (top/left/right; NOT bottom).
- `border-right: 1px solid #2a2a34`.

### 2.2 Section header bars (shared style, Tray + Super agent)

- Bar: `background:#08080c; padding:5px 13px; display:flex; align-items:center; gap:8px`.
- Hairlines `#2e2e38`: Tray bar has `border-bottom`; Super agent bar has `border-top` +
  `border-bottom` and casts `box-shadow: 0 5px 10px -5px rgba(0,0,0,.9)` downward.
- Glyph: `▤` (Tray) / `✦` (Super agent), colour `#f59e0b`, 11px.
- Title: 12px / 600 / `#f3f3f8`.
- Scope label: Geist Mono 8px, `letter-spacing:.12em`, `#5a5a66` —
  `ALL TASKS · NEWEST FIRST` (POD-113: static — the tray is global, no ISSUE-SCOPE variant)
  and `OVERARCHING · KNOWS THIS ISSUE`.
- **Super agent bar actions (POD-113):** two 20×20px icon buttons before the chevron —
  open-in-terminal and **clear context** (sends `/clear` to the headless global thread; starts
  the one global chat fresh, tray untouched). `#6c6c78` at rest, hover `#f3f3f8` on `#1b1b22`,
  5px radius.
- **v2: trailing collapse chevron on desktop too** (3b), `#6c6c78` 11px, `margin-left:auto`:
  `⌄` = section open, `▸` = section collapsed. On mobile (2c) the Tray bar's `⌄` doubles as
  the overlay-minimize affordance.
- Collapsed-state badges in the bar (see §2.7): Tray carries an amber count pill after the scope
  label (`min-width:13px; height:13px; border-radius:99px; background:#f59e0b`, Geist Mono 7.5px/700
  `#161006`); Super agent carries a 7×7px `border-radius:99px #f59e0b` unread dot after the title.

### 2.3 Tray — populated (only items needing a human)

Container: `display:flex; flex-direction:column; gap:6px; padding:8px 12px 10px` (`flex:none`; the chat below takes the rest).

**Review card** (e.g. POD-129):
- `border:1px solid rgba(ISSUE,.6); border-radius:10px; background:color-mix(in srgb, ISSUE 20%, #0e0e12); padding:9px 11px; gap:6px` (column).
- Title row (gap 6px): 8×8px square `border-radius:3px background:ISSUE` · title 11.5px/600
  (`#f6f3ff` tinted-white) "POD-129 Refresh-timer fix · ready for review" ·
  `· ◆ auth-refresh` 9.5px muted (`◆` = Claude orange `#D97757`) ·
  right-aligned frozen timestamp Geist Mono 9px `#f59e0b` "2m ago".
- Body: 11px/1.5 tinted `#cfc8e2`-class; inline code in Geist Mono `#f0edf8`.
- Action row (gap 6px):
  - Primary `✓ Done — merge`: `border-radius:6px; background:ISSUE; color:<dark on-colour>; font:600 10.5px; padding:3px 10px`.
  - `Send back`: `border:1px solid rgba(<near-white>,.3); border-radius:6px; 10.5px; padding:3px 9px`.
  - `Discuss ↓`: `border:1px solid #3a3a46; color:#9a9aa8; 10.5px; padding:3px 9px` (focuses the chat composer with the item as context).
  - `session →` link, right-aligned, 10px muted (opens the agent's session in the native pane).

**Question card** (e.g. POD-130):
- `border:1px solid rgba(ISSUE,.4); border-radius:10px; background:color-mix(in srgb, ISSUE 10%, #0e0e12); padding:8px 11px; gap:6px`.
- Row: 8px issue square · 11px/1.5 text `POD-130 Mobile session path · ◆ mobile-session asks: "…"` · right mono 9px amber "9m ago".
- Chips row (`gap:5px; padding-left:15px`): answer chips `border:1px solid rgba(ISSUE,.45); border-radius:5px; font-size:10px; padding:2px 8px; white-space:nowrap`, tinted text; trailing `Reply…` chip `border:1px solid #3a3a46; color:#9a9aa8`.

Slate variants (1b): same geometry with `#94a3b8` — border `.55`/`.4`, `color-mix … 14%` / `8%`,
primary button `background:#94a3b8; color:#141a24`.

### 2.3-v3 · Tray card contract — APPROVED (POD-113 v3.1, supersedes §2.3 above)

Colour is **issue identity, never state**: every card tints with its issue's user-assigned
palette colour (slate when unassigned) — amber/green/terracotta stay reserved for state, so
identity and state can't collide. Selected issue adds only a ring
(`0 0 0 1px rgba(ISSUE,.35)` + soft glow), never a re-sort.

**Offer card** (the workhorse; also used for failure decisions):
- Container: `border-radius:10px; padding:9px 11px; gap:6px`,
  `background:color-mix(in srgb, ISSUE 16%, #0e0e12)`, `border:1px solid rgba(ISSUE,.55)`,
  hover border `.8`. Whole card opens the session; inner controls stopPropagation.
- Header row (gap 6px): 8×8px `r3` issue square · mono 9.5px ref
  (`color-mix(ISSUE 65%, #f3f3f8)`) · issue title 10.5px `#9a9aa8` ellipsised ·
  `· ◆ agent` 9.5px (`◆` Claude `#D97757`) · right frozen mono 9px amber ago, `tabular-nums`.
- **Headline** = first line of the offer message, 12px/600,
  `color-mix(ISSUE 10%, #f3f3f8)`, `text-wrap:balance`.
- **State line** (machine-set, Geist Mono 9px `#9a9aa8`): stage · `⎇ branch` · `N ahead` ·
  `clean`/`N dirty` (dirty in `#f87171`) — gitState fields only; no invented stats.
- Body: remaining message lines, 11px/1.5, clamped at 2 lines; overflow → open session.
- **Artifact strip** (POD-120 semantics): agent-curated `--artifact` paths first, freshness
  fallback; ≤3 thumbs 70×44px `r5` + mono `+N`; images/videos → MediaLightbox in place,
  other kinds → artifact file tab.
- Action row — **all buttons on the 24px xs control scale** (11px label, 3px 12px padding,
  r6): primary = FIRST action, `background:ISSUE`, dark on-colour text
  (`color-mix(ISSUE 25%, #000)`), hover opacity .85; secondary bordered
  `rgba(243,243,248,.28)`; `--action-input` swaps the card body for a 2-row feedback field
  (Send/Cancel) and appends feedback to the prompt; `session →` link right-aligned 10px.

**Question card**: `color-mix … 9%` / border `.38`; header row as above;
`asks: "…"` free text (11px, quote in `#f3f3f8`); actions `Reply…` + `resolve ✓` as 24px
tertiary buttons. (Answer-option chips per old §2.3 need an options backend on
`needsHuman` first — deferred.)

**Finished card**: `color-mix … 7%` / border `.30`, `padding:7px 11px`, `opacity:.88`;
one line `closedReason · sha` + right-aligned **`Archive ✓` as a 24px tertiary button**
(deterministic client action — same affordance vocabulary as offer buttons).

**Arrival choreography** (motion.md keyframes; one-shot, then total stillness):
tray-bar count pill `popIn .45s cubic-bezier(.34,1.56,.64,1)` · card unfolds via
grid-template-rows 0fr→1fr `.35s ease-out` (never animate height) · surface `rowFlash .9s`
(amber .32 → 0) · ago stamp `flipAgo .5s` · action row `tickIn .35s`. Reduced-motion:
instant, no morphs.

**Sort (global tray)**: decisions first (offers + questions), finished last, newest-first
within each — identical whatever is selected. Never re-sort on selection.

**Never rendered in the tray:** working/status rows, spinners-per-item, done items.
Motion (1d): a card *arriving* may row-flash amber once (`rowFlash` 0%: `rgba(245,158,11,.32)` → 100%: `rgba(245,158,11,.10)`)
and the "ago" stamp uses the one-shot `flipAgo` morph (`.5s ease`: scale 1.35 green → amber → settle);
after that, total stillness — stillness IS the "needs you" signal.

### 2.4 Tray — empty (1c)

One quiet centred line replacing all cards
(`display:flex; align-items:center; justify-content:center; gap:9px; padding:16px 12px 17px`):
- `✓` in `#3f3f4a` 12px (dim, NOT green).
- "Nothing waiting on you" 11px `#6c6c78`.
- POD-113: copy is global — "Nothing waiting on you — anywhere"; count spans ALL live agents.
- Live agent counter: braille spinner + "3 agents working", Geist Mono 9px `#10b981`;
  spinner = CSS `content` keyframes `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, `animation: spB .8s steps(1,end) infinite`,
  `min-width:8px` reserved so glyphs don't jitter. Count = working sessions **scoped to the
  selected issue** (see §5). Spinner only renders while count > 0.

### 2.5 Super agent chat (below the second bar)

Feed area: `flex:1; min-height:0; overflow(-y auto); padding:12px 14px; column; gap:8px`.

> **POD-113: the standing event feed / changelog is REMOVED.** The chat takes the space;
> cross-issue "what happened" is a super-agent question (it knows the event stream), and the
> YOU-WERE-HERE divider marks the return point. The event-row treatment below survives only
> if events are ever interleaved into the transcript — no standing pane.

- **Event rows** (cross-project): 10.5px `#6c6c78`, `gap:8px` — mono 9px clock ("14:07") ·
  7×7px `border-radius:2.5px` square in the *event's* issue colour (teal Tartlet event sits in a
  violet-selected view: the feed is global) · one-line text · amber pointer suffix
  (`→ Home` for other-issue events, `↑` for "landed in your tray").
- **"YOU WERE HERE · 14:20" divider**: two 1px `rgba(245,158,11,.4)` rules flanking a
  Geist Mono 9px `.08em` `#f59e0b` label.
- **Messages**: left accent bar `flex:0 0 3px; border-radius:2px` — `#3b82f6` (YOU) /
  `#10b981` (SUPER AGENT); role label 9px/600 `.07em` (`#9a9aa8` for YOU; `#f59e0b` "SUPER AGENT"
  + non-tracked muted suffix `· answering with POD-128 context`); body 11.5px, line-height 1.5 (you) / 1.55 (agent); issue refs bold `#f6f3ff`.

Composer (`padding:8px 12px 7px`, Geist Mono):
- Box: `border:1.5px solid #f59e0b; border-radius:9px; background:rgba(8,8,12,.7); padding:8px 11px; gap:8px`.
  (1c shows the same box with `border:1.5px solid #3a3a46` — amber reads as the focused/active state; confirm, §6.)
- `>` prompt `#9a9aa8` · block caret `7×14px background:#f59e0b` ·
  placeholder 11.5px `#6c6c78` "Ask about anything — @ to pull other issues into context" ·
  right icon set 13px `#8d8d9a`: paperclip, mic, arrow-up.
- Hint row (`padding:5px 3px 0`, mono 9.5px `#6c6c78`): `⏵⏵` amber · `auto-delegate on` `#c5c5d0` ·
  `(shift+tab to cycle)` · right `? for shortcuts`.

### 2.6 Mobile (2c)

`✦` in the 44px header (lit `#f59e0b` when open) toggles the whole column as a full-screen
overlay (`absolute inset-0 z-20`, repo's existing `superOpen`); `⌄` in the Tray bar minimizes.
Identical structure/values; tray card paddings 9px 11px / 8px 11px, container `padding:8px 10px 10px`;
tray action buttons get slightly taller padding (`4px 10px` / `4px 9px`), chips `3px 8px`.
Mobile CTX suffix is the short form `· POD-128 context` (desktop: `· answering with POD-128 context`).
Composer keeps only the arrow-up icon (no paperclip/mic) and no hint row.

### 2.7 Collapsed states inside the column (3b, cnotes item 3 — NEW IN V2)

Tray and Super agent each collapse **to their compact header bar, never further** — the bars
never disappear. Chevron at `margin-left:auto`: `⌄` open, `▸` collapsed. Each state is
independent + persisted (cnotes item 1).

**Tray collapsed** (3b variant 1):
- Column = Tray bar (collapsed) directly above the Super agent bar; the Super agent bar keeps
  `border-bottom` + downward `box-shadow: 0 5px 10px -5px rgba(0,0,0,.9)`; chat feed + composer
  take all remaining space.
- The Tray bar keeps the "needs you" signal: amber count pill (`min-width:13px; height:13px;
  border-radius:99px; background:#f59e0b`, Geist Mono 7.5px/700 `#161006`, e.g. "2") sitting
  after the `ISSUE SCOPE` label. Count = number of tray items.

**Super agent collapsed** (3b variant 2):
- Its bar drops to the **bottom** of the column (`border-top:1px solid #2e2e38`, no bottom
  hairline/shadow); the Tray takes all the space above it (`flex:1; overflow:hidden` container).
- The bar keeps a 7×7px amber unread dot (`border-radius:99px; background:#f59e0b`) after the
  title while there are unseen feed entries/replies.
- **A collapsed Super agent has no composer** — the input collapses with it (per 3b caption;
  in 3a the input rides with the open chat).

**Both collapsed**: the column is just the two bars; whichever section is open gets the space.

**Whole column as 44px vertical bar, in place** (3d — one step short of fully closing into the
right rail, state C in 3c):
- `flex:0 0 44px; padding:10px 0; gap:12px; align-items:center`; surface keeps the engraving +
  glow: `background:linear-gradient(180deg, color-mix(in srgb, ISSUE 14%, #0a0a0e), #0a0a0e 300px), #0a0a0e;
  border-right:1px solid rgba(ISSUE,.35); box-shadow:inset 2px 0 5px -2px rgba(0,0,0,.85), inset -2px 0 5px -2px rgba(0,0,0,.85)`.
- Top `⟩` expand glyph (`#8d84a6` 11px). Then two 28×28px `border-radius:7px; background:#16161c;
  border:1px solid #2e2e38` buttons: `▤` (amber 12px) with the amber count corner badge
  (13px pill, `border:1px solid #0a0a0e`, top/right −5px) and `✦` (amber 12px) with a 9×9px unread
  corner dot (`border:2px solid #0a0a0e`, top/right −3px).
- Middle: rotated label `TRAY · SUPER AGENT` — Geist Mono 8px, `.18em`, `#5a5a66`,
  `writing-mode:vertical-rl`, `flex:1`.
- Bottom: the CTX ID square at 22px (`border-radius:6px`, mono 5.5px) in the issue colour —
  the colour still bridges sidebar → bar → native pane.
- `⟩` or clicking `▤`/`✦` expands back, **landing on the clicked half** (i.e. that section open).
- Fully closed (3c state C, owned by the shell dimension): the `✦` moves into the right rail and
  the amber tray count moves onto it; reopen from there.

**Resizing (decisions.md)**: every section is resizable — in addition to the column's 320–860px
width, the Tray/Super-agent horizontal split gets a drag handle (tray height clamped to its
content vs. chat minimum), even though the handoff doesn't show one explicitly.

---

## 3 · Gap list

1. **Tray component — missing entirely** (UI). New feature.
2. **Tray item data model — missing** (backend). `needsHuman`+`humanQuestion` is one
   un-timestamped string per issue with no options and no asking-session; no review object at all.
3. **Tray scope derivation** — tray shows items from the selected issue's *subtree*
   (POD-129/130 are children of selected POD-128). No client helper exists; server has
   `childCount`/`parentId` and `sessionsForIssue`.
4. **Answer path from web** — no tRPC proc to answer a question (chips / Reply…); only
   `clearNeedsHuman` (drops the question without answering) and the superagent-only
   `answer_question` MCP tool.
5. **Review actions** — `✓ Done — merge`, `Send back` have no backend verbs.
6. **Single chat** — current UX is a *thread switcher* (global + per-repo concierge + btw);
   design is ONE chat with the selected issue as CTX. Consolidation + migration story needed.
7. **Cross-project event feed in the chat** — `issues.events` exists server-side but is
   rendered nowhere; needs interleaving with the transcript + a persisted feed read cursor
   for "YOU WERE HERE".
8. **CTX badge / issue-context turns** — `sendTurn` has no issue param; replies can't label
   "answering with POD-x context".
9. **Visual re-skin** — engraved surface, #08080c bars, dark composer, event rows, accent-bar
   message layout; all of SuperagentView's current header/scope-bar/legacy chrome replaced.
   Big-bang per decisions.md: the old layout is retired outright, no feature flag.
10. **Section collapse states (NEW, v2 3b/3d)** — no per-section collapse exists today
    (`superOpen` only toggles the whole column). Need: tray collapsed-to-bar, super agent
    collapsed-to-bottom-bar (composer hidden), whole-column 44px vertical bar, amber count pill +
    unread dot in the bars, persisted state, and expand-landing-on-clicked-half behaviour.
    "Unread" for the super agent dot needs a definition (see §6).
11. **Dependencies on other dimensions** — issue colour + ID-square component (tokens dimension;
    colour model is now decided — user-picked from the 10-colour palette, slate fallback),
    braille-spinner/one-shot morph keyframes (motion dimension), Geist/Geist Mono (tokens),
    right-rail ✦ reopen affordance for the fully-closed column (shell dimension, 3c state C).

---

## 4 · Implementation approach

1. **Shell first**: new `EngravedColumn` wrapper in the AppShell slot (keeps `superOpen`,
   `ResizableColumn` 320–860/460); applies §2.1 surface + accepts the selected issue's colour
   (`selectedIssueId` from the store; slate fallback). Two `SectionBar` instances (§2.2) owning
   the collapse chevrons/badges; column-level state machine for §2.7
   (`open | trayCollapsed | superCollapsed | bothCollapsed | verticalBar`, modelled as two
   booleans + a bar flag), persisted in localStorage (e.g. `podium:tray:open`,
   `podium:superagent:open`, `podium:engraved:bar`). Big-bang replacement — delete the old
   header/scope-bar chrome rather than flagging it.
2. **Tray data**: server derives a typed `TrayItem[]` per issue subtree —
   `{ kind: 'question' | 'review', issueId, issueSeq, issueTitle, sessionId?, agentName?, text, options?: string[], since: ISO }`.
   - Phase A (no schema change): questions from `needsHuman`/`humanQuestion` (+ `issue.needs_human`
     event timestamp for `since`); reviews synthesized from `stage === 'review'` (+ latest
     `issue.stage_changed → review` event, `panel`/`prUrl` for body/links). Extend
     `setNeedsHuman` to accept `options?: string[]` and `askedBy: sessionId` (additive columns
     on `IssueRow`, additive fields on `IssueWire`).
   - Expose as `trpc issues.tray({ issueId })` or fold into `IssueWire`; push updates ride the
     existing `issuesChanged` broadcast.
3. **Tray UI**: `features/tray/Tray.tsx` + `TrayCard.tsx`; empty state per §2.4 with
   working-count derived client-side from `sessions` × `issueId`/subtree × `attentionGroup === 'working'`
   (reuse `packages/client-core/src/focus.ts`).
4. **Actions**:
   - Question chip / Reply → new `trpc issues.answerQuestion({ id, answer })`: deliver via the
     asking session's input path (`send_to_agent`/outbox; native-menu digit typing can reuse the
     `answer_question` matching logic in `apps/server/src/modules/superagent/tools.ts`), then `clearNeedsHuman`.
   - Review actions → pending product answers (§6); minimum viable: `Done — merge` sends the
     merge instruction to the issue's session + moves stage; `Send back` sends composed feedback;
     `Discuss ↓` prefills the super agent composer; `session →` = existing open-in-workspace flow.
5. **Chat**: keep the headless-session + embedded `ChatView` machinery; default to the
   `global` thread as "the" chat; add `issueContext: selectedIssueId` to `sendTurn`
   (server injects an issue-context preamble like the existing `[CONCIERGE CONTEXT]` seeds);
   assistant turns render the CTX suffix from the turn's recorded context. Feed = merge
   `issues.events` rows (cursor-paged) into the transcript by timestamp; persist a
   `feedReadAt` cursor for the YOU-WERE-HERE divider.
6. **Collapse states (v2)**: chevrons toggle each section; collapsed super agent unmounts the
   composer; collapsed tray shows the count pill (tray item count); vertical-bar mode renders the
   3d 44px strip and expands landing on the clicked half. Unread-dot source: feed entries/agent
   replies newer than the last time the chat was visible (same cursor as YOU WERE HERE).
   Add the tray/chat drag handle (every section resizable, decisions.md).
7. **Mobile**: reuse the same component tree inside `MobileApp`'s overlay; add the `⌄` bar affordance.

### Files to touch

- `apps/web/src/app/AppShell.tsx`, `apps/web/src/app/MobileApp.tsx` — column shell/overlay.
- `apps/web/src/features/superagent/SuperagentView.tsx` — decompose: header bars, feed, composer restyle; retire the 49px header + 37px scope bar + thread pills.
- NEW `apps/web/src/features/tray/` — `Tray.tsx`, `TrayCard.tsx`, `derive-tray.ts` (+ tests).
- `apps/web/src/features/chat/ChatView.tsx` — event-row interleave + YOU-WERE-HERE (or a feed wrapper around it).
- `packages/client-core/src/focus.ts` — issue-scoped working-count helper.
- `packages/protocol/src/messages/issues.ts` — `TrayItem` wire / `needsHuman` extensions (options, askedBy, askedAt).
- `apps/server/src/modules/issues/service/crud.ts` (`setNeedsHuman` extensions), `reads.ts` (tray derivation), router procs (`issues.tray`, `issues.answerQuestion`, review verbs).
- `apps/server/src/modules/superagent/service.ts` / `headless.ts` / `tools.ts` — `sendTurn` issue context; answer routing reuse.
- Right-dock/rail + sidebar tie-ins are other dimensions; this column only consumes `selectedIssueId` + issue colour.

---

## 5 · Scoping rule — RESOLVED (POD-113, supersedes the subtree proposal)

**The tray is GLOBAL**: every live offer, question and finished item across all tasks,
always. No issue scoping, no scope toggle — `trayScopeIssues` narrowing is deleted. The
selected issue influences rendering only via the colour ring on its cards (§2.3-v3); sort is
stable regardless of selection. Agent-count in the empty state = all non-archived,
non-headless sessions with `attentionGroup === 'working'`, machine-wide.

---

## 6 · Open questions (designer / product owner)

1. **Review semantics**: what exactly do `✓ Done — merge` and `Send back` execute?
   (Instruct the agent to merge via the merge-lock workflow? Close the issue? Human merges and
   the button just records it?) There is no review/merge object in the backend today.
2. ~~Tray scope~~ **RESOLVED (POD-113)**: global, stable sort, ring-only selection effect (§5).
   ~~Changelog~~ **RESOLVED (POD-113)**: standing feed removed (§2.5 note).
   ~~Offer evidence~~ **RESOLVED (POD-120)**: `--artifact` curated-first + freshness fallback.
3. **Tray membership beyond issue questions**: do session-level `needs_user` items
   (permission prompts, plan approvals, retryable errors — today's `attentionGroup`) and pending
   `ApprovalWire` ops appear as tray cards too, or does the tray show only issue-level
   questions/reviews with everything else staying in sidebar badges?
3. **Scope**: selected issue's subtree (per §5) — confirmed?
4. **One chat**: is the thread switcher (global / per-repo concierge / btw threads) fully
   retired in favour of one global chat with per-turn issue CTX? What happens to existing
   concierge/btw threads and their history?
5. **Answer delivery**: does a chip answer go to the asking agent session directly, become an
   issue comment, or both? And should answering auto-clear `needsHuman`?
6. **Composer border**: 1a/1b/2c/3a/3b show `1.5px #f59e0b`, only 1c shows `#3a3a46` — working
   assumption: amber = focused/active, grey = idle/blurred. Confirm.
7. **YOU WERE HERE cursor**: persisted server-side (cross-device) or per-client localStorage?
   (Proposal in §4.6 reuses it for the collapsed-✦ unread dot.)
8. **Feed event vocabulary**: which event kinds appear in the chat feed (agent finished,
   question asked, started, closed, …) and is it capped/collapsible for busy periods?
9. ~~Issue colours assignment model~~ **RESOLVED** (decisions.md + 4a/4b): user-assigned via a
   10-swatch picker; no-colour = slate flow; picker itself is owned by the sidebar/tokens
   dimension — this column only consumes the colour.
10. **Collapsed super agent + new question**: when the super agent itself needs the human while
    collapsed, is the unread dot enough, or does it auto-expand / land in the tray?
11. **Tray count semantics**: bar pill and 3d badge show "2" with 2 tray cards — is the count
    item count (cards) or per-issue waiting-session count (sidebar badge semantics)? Assumed:
    tray item count.
