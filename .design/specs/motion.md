# Motion spec — micro-motion grammar (handoff option 1d)

Source of truth: `/home/podium/podium/.design/podium-handoff.html` (v2, verified 2026-07-14 — turns are in reverse order: #4 colour picker at top, then #3 collapse, #2 mobile, #1 final layout at the bottom)
- `#1d` (lines ~961–1046) — the live phase-driven POD-128 row demo (developer edition; the one to implement)
- Build note 4 "Motion rules" (line ~547) — prose statement of the grammar
- Keyframes: `<style>` block lines 16–23 of the handoff (**byte-identical to v1** — nothing changed)
- Phase→style mapping: the demo's `m2Vals()` script (lines ~1113–1172; values unchanged from v1)
- NEW in v2 touching this dimension: turn 3 collapse states (`#3a`/`#3b`/`#3d`, lines ~109–315) reuse the badge/spinner grammar on collapsed rails; turn 4 (`#4b`, line ~101) reserves the motion colours (#10b981 working, #f59e0b waiting, #D97757 Claude) — issue colours can never collide with them.

Product decisions (`.design/decisions.md`): rollout is **big bang** — the old pulse grammar is deleted outright, no feature flag, no coexistence.

The grammar in one sentence: **the braille spinner + a green counting timer are the ONLY permanent motion, running only while an agent computes; every phase change is a single one-shot morph (.35–1s), then total stillness — stillness means "needs you".** No pulses, no glows, no breathing rings.

---

## 1 · Current state (apps/web)

### Motion that exists today — and violates the grammar
| Where | What | File |
|---|---|---|
| `.dot-working::after` | **infinite** 2s `dot-breathe` breathing halo on every working dot | `apps/web/src/styles.css:39–66` |
| `.dot-starting` | **infinite** 0.9s `dot-starting-pulse` scale/opacity pulse | `apps/web/src/styles.css:80–93` |
| `conn-pulse` | infinite 1.2s opacity pulse (mic recording, connection) | `apps/web/src/styles.css:343,352` |
| `cursor-blink`, `term-spin` | composer caret blink; cold-start splash ring spinner | `apps/web/src/styles.css:144,173` |
| tw-animate-css | entrance/exit animations on dialogs, dropdowns, tooltips (`animate-in` etc.) | `apps/web/src/index.css:2`, `components/ui/*` |

There is **no braille spinner, no one-shot phase morph, no ignite/pop/flash** anywhere in the codebase.

### Status rendering today
- Status dot: `sessionDotClass()` in `apps/web/src/lib/derive.ts` maps `DotTone` (`working|attention|error|ready|neutral`) → `bg-live` / `bg-warning` / `bg-red-500` / `bg-info` / `bg-muted-foreground`, plus `dot-working` / `dot-starting` pulse classes. Used by sidebar rows (`sidebar-common.tsx` PanelRow), tab strip (`app/Workspace.tsx:470,500`), mobile menus.
- Timer: `WorkingTimer` in `apps/web/src/features/worklist/time-indicators.tsx` — ticks 1s via `useNow`, format `12m 34s` (not `12:34`), styled `text-[10px] tabular-nums text-[#6c6c78]` (grey, NOT green mono). `AgoStamp` renders grey `relativeTime`. Neither freezes/flips — they're independent renders, no morph between them.
- Attention meta: amber status **word** (`text-[#d4a017]`) right of the row name in PanelRow; no amber count pill, no pop-in.
- Rail: `app/RightDock.tsx` 44px icon rail — no per-issue corner badges (spinner / amber count / ✓).

### Data model — mostly already there
`packages/protocol/src/messages/runtime-state.ts`:
- `AgentPhase = unknown|working|idle|needs_user|errored|compacting|ended` + `AgentRuntimeState.since` (ISO of **last phase change**) — this is exactly the phase machine 1d needs. Pushed live via `SessionAgentStateChangedMessage`.
- `needs_user` + `since` ⇒ the frozen "Xm ago" stamp. `idle.kind === 'done'` ⇒ the ✓/done state. `busy` covers uninstrumented shells.
- Classification helpers already exist and are shared: `attentionGroup()` in `packages/client-core/src/focus.ts`, `isSessionWorking`, `splitSessions` in `packages/client-core/src/viewmodels/derive.ts`.

**Gap in the data model:** the done-state grey total `∑ 5:40` (cumulative compute time). `since` resets on every transition, so total working duration is not recoverable from `AgentRuntimeState`. This is the one genuinely NEW backend surface (see §5).

---

## 2 · Target design — exact values from the handoff

### 2.1 Keyframes (verbatim from handoff lines 16–23)

```css
/* THE spinner — pure CSS content animation, 10 braille frames */
@keyframes spB {
  0%{content:"⠋"} 11%{content:"⠙"} 22%{content:"⠹"} 33%{content:"⠸"}
  44%{content:"⠼"} 55%{content:"⠴"} 66%{content:"⠦"} 77%{content:"⠧"}
  88%{content:"⠇"} 100%{content:"⠏"}
}
/* one-shot morphs */
@keyframes ignite    { 0%{transform:scale(.5)} 55%{transform:scale(1.35)} 100%{transform:scale(1)} }
@keyframes popIn     { 0%{transform:scale(.3);opacity:0} 60%{transform:scale(1.18);opacity:1} 100%{transform:scale(1)} }
@keyframes rowFlash  { 0%{background-color:rgba(245,158,11,.32)} 100%{background-color:rgba(245,158,11,.10)} }
@keyframes tickIn    { 0%{transform:translateY(5px);opacity:0} 100%{transform:none;opacity:1} }
@keyframes flipAgo   { 0%{transform:scale(1.35);color:#10b981;opacity:.4} 45%{color:#f59e0b} 100%{transform:scale(1);opacity:1} }
@keyframes iconFlash { 0%{box-shadow:0 0 0 0 rgba(245,158,11,.6)} 100%{box-shadow:0 0 0 9px rgba(245,158,11,0)} }
```

Note: the handoff also defines `@keyframes ping` (a 2.2s infinite ring) — that belongs to the REJECTED non-1d variant. **Do not port it.** 1d is explicit: "No pulses, no glows."

### 2.2 Animation invocations (exact timings/curves)

| Trigger | Element | Animation |
|---|---|---|
| computing (permanent) | spinner glyph `::before` | `spB .8s steps(1,end) infinite` |
| → working | ID square / status chip / rail icon | `ignite .55s cubic-bezier(.34,1.56,.64,1)` |
| → working | spinner+timer cluster appears | `tickIn .35s ease` |
| → waiting | row background | `rowFlash .9s ease-out` (holds `rgba(245,158,11,.10)` after) |
| → waiting | amber count badge (row + rail) | `popIn .45s cubic-bezier(.34,1.56,.64,1)` |
| → waiting | timer freezes → "ago" stamp | `flipAgo .5s ease` |
| → waiting | rail icon amber ring | `iconFlash 1s ease-out` |
| → done | ✓ glyph (row) | `popIn .45s cubic-bezier(.34,1.56,.64,1)` |
| → done | ✓ corner badge (rail) | `popIn .4s ease` |
| every phase change | row/square/icon base | CSS `transition: background .4s, border-color .4s, opacity .4s` |

### 2.3 Spinner + timer typography and color

- Spinner glyph: rendered as `content` on a `::before` of an `inline-block` span, `min-width:8px` (9px in the 13px rail badge context, 12px in the legend); font `'Geist Mono', monospace`.
- Sizes seen in the doc: `font-size:9px` (sidebar row timers, tab strip), `10px` (mobile panel menu), `11px` (legend), `8px` inside the 13px rail badge.
- Color: `#10b981` (working green). Inside the rail corner badge the glyph is `#34d399` on `background:#0c1f18` with `border:1px solid #10b981`.
- Timer: Geist Mono, 9px, `#10b981`, format `m:ss` (`fmt = floor(s/60) + ':' + pad2(s%60)` → `6:30`), sits `gap:4–5px` right of the spinner, `margin-left:auto` in the row.
- Ago stamp (waiting): Geist Mono 9px `#f59e0b`; text `just now` for the first moments, then `Nm ago`. (The static 1a rows show the ago stamp inheriting the row's tint at `opacity:.85` — the live 1d row and build note 4 make **amber** canonical for the post-flip stamp.)
- Total stamp (done): Geist Mono 9px `#6c6c78`, text `∑ m:ss`.
- **Timer accumulation semantics** (from the demo's `applyPhase2`, v2 lines ~1100–1105): the working counter only ticks during `working`; on `waiting → working` (answer) it **resumes, not resets**; it resets only when entering working from `queued` or `done`. The done total `∑` is therefore cumulative *compute* time of the run, excluding waiting stretches.

### 2.4 Phase → row styling (from `m2Vals()`, the reference implementation)

Row base: `display:flex; gap:8px; padding:5px 8px; border-radius:7px; border:1px solid transparent; transition:background .4s, border-color .4s, opacity .4s`.

| Phase | Row | ID square (26×26, r7, Geist Mono 6.5px/600) | Right meta |
|---|---|---|---|
| queued | no bg, `opacity:.65–.8` | `background:#25252f; border:1px dashed #6c6c78`, text `#8d8d9a` | text "queued", `#6c6c78`, **no motion** |
| working | `background:color-mix(in srgb, ISSUE 20%, #16161c); border:1px solid rgba(ISSUE,.5)` | solid issue fill (e.g. `#8b5cf6`, text `#1e0b44`) + `ignite .55s` | spinner + green counting timer (`tickIn .35s` on entry) |
| waiting | `background:rgba(245,158,11,.10); border:1px solid rgba(245,158,11,.45)` + `rowFlash .9s` | solid issue fill, still | amber `1` pill (`popIn .45s`) + frozen amber ago (`flipAgo .5s`); then **perfectly still** |
| done | `background:color-mix(in srgb, ISSUE 8%, #16161c); border:1px solid rgba(ISSUE,.25); opacity:.85` | solid fill, `opacity:.6` | green ✓ 10px/700 (`popIn .45s`) + grey `∑ m:ss` |

Amber count pill: `border-radius:99px; background:#f59e0b; color:#161006; font-size:9px; font-weight:700; padding:0 5px`.
Uncoloured issues run identical mechanics in slate `#94a3b8` (handoff 1b, line ~744; per 4b + decisions.md, slate is the default no-colour flow, not a pickable colour).

**Colour reservation (4b, v2 line ~101):** the 10 pickable issue colours deliberately exclude the amber/orange and pure-green band — `#f59e0b` is reserved for "waiting on you", `#10b981` for working, `#D97757` for Claude. The motion colours can therefore be hardcoded without ever colliding with an issue colour.

### 2.5 Rail corner badge (26–30px ID square, badge at `top:-5px; right:-5px`)

- Working: 13×13 circle, `background:#0c1f18; border:1px solid #10b981`, spinner glyph 8px `#34d399`, enters with `tickIn .35s`.
- Waiting: `min-width:13px; height:13px; border-radius:99px; background:#f59e0b; border:1px solid <rail bg #131318>`, count 7.5px/700 `#161006`, `popIn .45s cubic-bezier(.34,1.56,.64,1)`.
- Done: green circle as working but `✓` 8px/700 `#34d399`, `popIn .4s ease`.
- Rail icon itself: working `ignite .55s` + solid issue fill; waiting `border:1px solid rgba(245,158,11,.7)` + `iconFlash 1s ease-out`.
- **Wide** sidebar ID squares use a smaller plain amber dot variant: 10×10 circle, `top:-4px; right:-4px; background:#f59e0b; border:2px solid #16161c` (no number) — the numbered count pill sits in the row meta instead.

### 2.5b Collapsed rails (NEW in v2, turn 3)

The identical badge grammar carries onto every collapsed surface — collapse must not lose the motion signals:

- **Collapsed left sidebar** (`#3a`, 52px rail of 26px ID squares): full 13px corner-badge grammar — numbered amber badge (`min-width:13px; height:13px; font-size:7.5px/700; color:#161006; border:1px solid <rail bg #16161c>`) for waiting, green braille-spinner badge (13px, glyph 8px `#34d399` on `#0c1f18`, `border:1px solid #10b981`) while computing, dashed+dimmed for queued. Note: unlike the wide rows, the collapsed rail badges ARE numbered.
- **Collapsed Tray header bar** (`#3b`): amber count pill moves into the bar itself (`min-width:13px; height:13px; border-radius:99px; font-size:7.5px/700`), still `popIn` on count appearance/increase; collapsed Super agent bar gets a 7px amber unread dot.
- **Engraved column folded to 44px vertical bar** (`#3d`): ▤ Tray icon (28px) carries the numbered amber corner badge (13px, `border:1px solid #0a0a0e`); ✦ Super agent icon carries a 9px amber unread dot (`top:-3px; right:-3px; border:2px solid #0a0a0e`).
- All of these are still/one-shot except the spinner badge — same grammar, no new motion primitives.

### 2.6 Everywhere the spinner appears in the final screens

1. Sidebar working rows (`working · subtasks 1/3 … ⠋ 6:30`) — 1a/1b/2a.
2. Native tab strip: a background tab that's computing shows spinner instead of a dot (`⠸`, 9px, `#10b981`) — 1a line ~394.
3. Uncoloured selected row (1b): spinner inside the ID-square corner badge (13px circle version).
4. Empty tray line (1c): `✓ Nothing waiting on you  ⠹ 3 agents working` (spinner + 9px mono green count).
5. Mobile panel dropdown rows (2b, 10px) and mobile home rows (2a, 9px) — same grammar.
6. Collapsed sidebar rail (3a) and the folded 44px column bar (3d) — 13px spinner corner badges on the 26px ID squares (see §2.5b).

---

## 3 · Gap list

1. **Kill all infinite pulses**: `.dot-working` breathing halo, `.dot-starting` pulse — replaced by the spinner grammar. (`conn-pulse` mic + splash `term-spin` are non-agent chrome — see open questions.)
2. **No braille spinner exists** → new `BrailleSpinner` primitive + `spB` keyframes.
3. **Timer wrong in every way**: grey not green, `12m 34s` not `12:34`, sans not enforced mono-9px, never freezes/flips; no `∑` total.
4. **No one-shot morph system**: no keyframes, no mechanism to fire an animation exactly once per phase *transition* (and not on mount/scroll-remount).
5. **No amber count pill with pop-in** (current UI shows an amber word).
6. **No corner badges anywhere** (RightDock has no per-issue state badge; the v2 collapsed-sidebar rail, Tray bar count, and folded-column bar badges don't exist either — those surfaces are new).
7. **No ✓-pop done treatment**; done sessions just leave the working list.
8. **No cumulative compute total** in the data model (backend gap).
9. **Reduced-motion story** only covers the dots being removed; needs a policy for the spinner + morphs.

---

## 4 · Implementation approach

### 4.1 New CSS — `apps/web/src/motion.css` (imported from `index.css`)

All keyframes from §2.1 under prefixed names (`podium-spb`, `podium-ignite`, …) plus utility classes:

```css
.spb { display:inline-block; min-width:8px; font-family:var(--font-mono); }
.spb::before { content:"⠋"; animation: podium-spb .8s steps(1,end) infinite; }

.morph-ignite    { animation: podium-ignite .55s cubic-bezier(.34,1.56,.64,1); }
.morph-pop       { animation: podium-popIn .45s cubic-bezier(.34,1.56,.64,1); }
.morph-pop-soft  { animation: podium-popIn .4s ease; }
.morph-row-flash { animation: podium-rowFlash .9s ease-out; }
.morph-tick-in   { animation: podium-tickIn .35s ease; }
.morph-flip-ago  { animation: podium-flipAgo .5s ease; }
.morph-icon-flash{ animation: podium-iconFlash 1s ease-out; }
.phase-surface   { transition: background-color .4s, border-color .4s, opacity .4s; }

@media (prefers-reduced-motion: reduce) {
  .spb::before { animation: none; }          /* static first frame */
  [class^="morph-"], [class*=" morph-"] { animation: none; }
}
```

Delete `.dot-working::after`, `dot-breathe`, `.dot-starting`, `dot-starting-pulse` from `styles.css` and strip the classes from `sessionDotClass()`.

### 4.2 Reusable primitives (new files under `apps/web/src/lib/motion/`)

1. **`BrailleSpinner.tsx`** — `<BrailleSpinner size={9} className />`; span with `.spb`, color `#10b981` by default (or `text-live` token — open question Q4). Zero JS animation; one CSS rule animates every instance.
2. **`PhaseTimer.tsx`** — the timer/ago component, the anchor of every morph:
   - props: `phase: 'working'|'waiting'|'done'|'idle'`, `sinceMs` (from `agentState.since`), `totalMs?`.
   - working → `<spinner/> m:ss` green mono 9px, ticking via existing `useNow(1000)` (reuse the coarse ≥1h → 60s trick from `time-indicators.tsx`); wrapped in `.morph-tick-in` when it first appears.
   - waiting → frozen `relativeTime(since)` in amber with `.morph-flip-ago` (fires once, keyed on the transition).
   - done → `∑ m:ss` grey (needs `totalMs`; render nothing until backend supplies it).
   - new `formatClock(ms)` → `m:ss` (`6:30`); keep `formatElapsed` for non-motion surfaces.
3. **`usePhaseMorph.ts`** — the one-shot mechanism: `const morphKey = usePhaseMorph(phase)` returns a `key`/class only when phase **changed after mount** (track previous phase in a ref; on first render return null so a freshly mounted list doesn't replay 30 flashes). Consumers key the animated node (`key={phase}`) so CSS animation restarts exactly once per transition.
4. **`StatusBadge.tsx`** — the corner badge: variant `spinner | count(n) | check`, geometry from §2.5 (13px circle, −5px offsets; 10px dot variant). Applies `.morph-pop` / `.morph-tick-in` via `usePhaseMorph`.
5. **Phase mapping helper** in `packages/client-core/src/viewmodels` (or reuse `attentionGroup`): collapse `AgentPhase` + `busy` + `SessionStatus` into the 4 motion phases `queued|working|waiting|done`:
   - `working|compacting` (or shell `busy`) → working
   - `needs_user|errored`, `idle.kind === question|approval|open_todos` → waiting
   - `idle.kind === 'done'` / `ended` → done
   - hibernated / no session yet / `unknown` → queued/idle (still, dimmed)

### 4.3 Wire-up (per surface)

- **Sidebar rows** (`sidebar-common.tsx` PanelRow, `SidebarUnified.tsx`): replace `trailingMeta`+dot with `PhaseTimer`; add `.phase-surface` + phase row classes (§2.4); amber word meta → amber count pill with `.morph-pop`; row-level `.morph-row-flash` on →waiting.
- **Collapsed sidebar rail + folded column bar** (new v2 surfaces, built by the layout dimension): reuse `StatusBadge` on the 26px ID squares (numbered amber / spinner / ✓, §2.5b) and on the ▤/✦ icons of the 44px bar; Tray header bar count pill uses the same pill + `.morph-pop`.
- **Tab strip** (`app/Workspace.tsx:470,500`): dot → `BrailleSpinner` when session computing; amber 6px dot when waiting (already the design for tabs); keep still otherwise.
- **Right rail** (`app/RightDock.tsx`): add ID-square rail items with `StatusBadge` (needs the issue-square work from the tokens/ID-square dimension); `ignite`/`iconFlash` on the square itself.
- **Empty tray line** (`features/superagent/SuperagentView.tsx:317` area): replace `dot-working` summary dot with `✓ Nothing waiting on you · <BrailleSpinner/> N agents working`.
- **Host indicator** (`features/machines/HostIndicators.tsx:260`): drop `dot-working`, spinner optional (it's chrome, likely stays a plain dot).
- **Mobile** (`app/MobileApp.tsx` panel menu + home rows): same components, 10px sizes.
- **Chat/terminal "thinking" states** (`AgentPanel.tsx`, `ChatView.tsx`): swap `animate-spin`/pulse loaders for `BrailleSpinner` where they represent agent compute.

Counts for amber pills: derive client-side per issue/row from `attentionGroup(s) !== 'working'` sessions (`splitSessions` already does this) — no backend change.

### 4.4 Backend (the one new surface)

Cumulative compute total for `∑`: extend `AgentRuntimeState` (or `SessionMeta`) with `workingMsTotal: number` accumulated by the daemon/agent-bridge on each phase transition out of `working|compacting` (it already stamps `since` on every transition in `packages/agent-bridge/src/agent-state/*.ts` + `harness/registry.ts`). Additive optional field — old clients ignore it; client renders `∑` only when present. Alternative (cheaper, lossy): client accumulates while subscribed — rejected, resets on reload.

## Files to touch

| File | Change |
|---|---|
| `apps/web/src/motion.css` (NEW) | keyframes + utilities (§4.1) |
| `apps/web/src/index.css` | import motion.css |
| `apps/web/src/styles.css` | delete dot-breathe / dot-starting-pulse blocks |
| `apps/web/src/lib/motion/BrailleSpinner.tsx` (NEW) | spinner primitive |
| `apps/web/src/lib/motion/PhaseTimer.tsx` (NEW) | timer/ago/total + morphs |
| `apps/web/src/lib/motion/usePhaseMorph.ts` (NEW) | one-shot transition hook |
| `apps/web/src/lib/motion/StatusBadge.tsx` (NEW) | corner badge |
| `apps/web/src/lib/derive.ts` | strip `dot-working`/`dot-starting` from `sessionDotClass` |
| `packages/client-core/src/viewmodels/derive.ts` | `motionPhase()` mapping helper |
| `apps/web/src/features/worklist/time-indicators.tsx` | `formatClock`, rebuild WorkingTimer/AgoStamp on PhaseTimer |
| `apps/web/src/features/worklist/sidebar-common.tsx`, `SidebarUnified.tsx` | row wiring |
| `apps/web/src/app/Workspace.tsx` | tab-strip spinner |
| `apps/web/src/app/RightDock.tsx` | rail badges |
| `apps/web/src/app/MobileApp.tsx` | mobile menu/home wiring |
| `apps/web/src/features/superagent/SuperagentView.tsx` | empty-tray line |
| `apps/web/src/features/machines/HostIndicators.tsx` | drop pulse |
| `packages/protocol/src/messages/runtime-state.ts` | `workingMsTotal` (optional) |
| `packages/agent-bridge/src/agent-state/*`, `harness/registry.ts` | accumulate workingMsTotal |

## Open questions (designer / product owner)

1. **∑ total semantics** — PARTLY RESOLVED by the v2 demo script (`applyPhase2`): ∑ accumulates working seconds only (waiting excluded) and resets when work restarts from queued/done. Still open: does it persist across hibernate/resume and page reload (argues for the backend `workingMsTotal` field, §4.4)?
2. **Reduced motion** — with `prefers-reduced-motion`, is a static braille frame acceptable as the "computing" signal (no other motion remains), or should a color-only treatment carry it? Are the one-shot morphs also dropped, or allowed since they're single-fire?
3. **Starting/reconnecting sessions** (process booting, agent not yet computing): spinner, dimmed stillness, or a distinct still glyph? The current UI pulses these; 1d has no state for them.
4. **Green hardcode vs theme token** — the handoff hardcodes `#10b981`, and v2's 4b now *reserves* `#10b981` for "working" against the issue palette, which leans toward hardcoded emerald everywhere; but the app's `--live` token retints activity per theme preset (e.g. Superade red). Confirm: spinner/timer stay emerald, or follow `--live`?
5. **Non-agent chrome exempt?** — cold-start splash ring, mic-recording pulse, composer caret blink, dialog enter/exit (tw-animate-css): keep as-is, or does "no permanent motion" extend to them?
6. **`errored` phase** — 1d shows queued/working/waiting/done only. Does errored use the waiting (amber) treatment, or a distinct red still state?
7. **"ago" wording thresholds** — demo fakes `just now` → `Nm ago`; confirm production granularity (reuse existing `relativeTime`: s/m/h/d?).
