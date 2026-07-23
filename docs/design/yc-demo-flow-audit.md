# YC Demo Flow — Screen Map + Impeccable Audit Summary

Scope: the 3:00 demo script (shell orientation → tasks → agent spawn → RAM pressure → VPS setup → new machine → handoff → mobile). Six parallel `/impeccable audit` passes, one per screen cluster. Companion narration: `yc-demo-narration.md`.

## Screen map (demo beat → surfaces)

| Beat | Surfaces | Score |
|---|---|---|
| Orientation (shell, sidebar, header) | `AppShell.tsx`, `SidebarUnified` / `sidebar-common`, `HostIndicators`, `QuotaIndicator` | 15/20 |
| Tasks / "I want something done" | `superagent/Tray`, `TrayCard`, `SectionBar`, `EventFeed`, `issues/*` | 15/20 |
| New agent + native pane | `NewPanelMenu`, `Workspace` tabs, `AgentPanel` (PTY) | 14/20 |
| VPS setup (superagent + settings) | `SuperagentView` composer, `ConciergeButton`, `MachinesPanel`, `SetupView` | 15/20 |
| RAM pressure + handoff | `HostMemoryView`, `ConnectionIndicator`, `SessionContextMenu` (handoff submenu) | 16/20 |
| Mobile beat | `apps/mobile` (own design system, Superade-faithful) | ~3/4 avg |

**Overall: the flow is filmable today.** Every cluster passes the AI-slop test; the issue-color channel, carved elevation, and braille-spinner grammar are distinctive and consistent. All weaknesses are self-inconsistencies against Podium's own DESIGN.md, concentrated in a few camera-visible spots.

## Script ↔ product gaps (fix the script or build UI)

1. **The VPS "setup shows install → connect → credentials" progress sequence does not exist in the web UI.** MachinesPanel shows pairing code → machine row appears. The install progress is only visible in the VPS terminal itself. Either film the terminal scroll (recommended — it's honest and on-brand) or build a progress surface.
2. **Claude → Codex handoff has no UI.** `handoffAvailability` explicitly blocks cross-harness handoff. Script this beat as a CLI/superagent action (agent spawns a Codex successor carrying the task context), not a menu click.
3. **Machine handoff is real but flag-gated** (`session-handoff` feature flag) and lives in the right-click session context menu. Enable the flag in the demo build and pre-register the VPS so the submenu shows a live candidate.
4. **Handoff has no motion** — the money shot is currently a label swap + toast. A one-shot departure/arrival morph (sanctioned by the motion grammar) would sell the beat. `/impeccable animate`.

## Demo-critical fixes (what the camera will catch), priority order

- **P1 — "Starting…" spawn overlay**: generic Tailwind spin-ring in zinc greys at the exact hero moment of Beat 2 (`AgentPanel.tsx:927–939`). Restyle to braille spinner + ink ramp. Single highest-value fix.
- **P1 — Sidebar's retired grey palette under Superade navy**: ~30 hard-coded hexes (`sidebar-common.tsx`, `SidebarUnified.tsx`, `SidebarRail.tsx:33`) render grey chips/tints on the navy chassis in every shell shot.
- **P1 — Signal Rule dilution in the tray**: section glyphs, every card's "ago" stamp, and feed pointers are all amber (`SectionBar.tsx:50`, `TrayCard.tsx:224`, `EventFeed.tsx:100`). The narration says "yellow marks the one thing that needs you" — the screen currently contradicts it. De-amber everything but decision cards.
- **P1 — Superagent composer off-chassis**: hard-coded charcoal hexes + ~2.4:1 placeholder contrast (`SuperagentView.tsx:620,656,664,724`); it's the most-filmed element of Beat 3.
- **P1 — Clipboard copy silently no-ops off secure contexts** (`MachinesPanel.tsx:284`, `SetupView.tsx:466`) — the exact demo gesture if presenting over a tunnel/LAN HTTP. Fine in the Tauri app.
- **P2 — Unfinished copy on camera**: "files: coming later" in the @-menu (`SuperagentView.tsx:651`); unverified shortcut footer promises (`:725–727`).
- **P2 — Two mismatched yellows**: Tailwind amber-500 vs Superade `#f5c518` (`SuperagentView.tsx:363`, `EventFeed.tsx:82`, `SetupView.tsx:369,582`).
- **P2 — `animate-pulse` violations** (banned by the motion grammar): superagent "Starting the conversation…" + mic (`SuperagentView.tsx:613,706`), down-connection wifi icon (`ConnectionIndicator.tsx:161`).
- **P2 — Yellow as data-viz** in the RAM close-up: the "Agents" memory segment uses Signal Yellow (`HostMemoryView.tsx:343`) — reads as "needs you" during the pressure beat.
- **P2 — Red "dirty" counts on tray cards** (`TrayCard.tsx:60`) sprinkle alarm-red across the board shot.
- **P2 — Off-palette strays**: sky-blue coordinator badge (`Workspace.tsx:558`), violet epic badge (`IssueListView.tsx:170`), sky/emerald/amber status chips (`sidebar-common.tsx:512+`).
- **Mobile**: include the triage inbox / question-card beat (strong, on-brand); do NOT show `LoginScreen.tsx` (stale pre-Superade palette incl. banned green); re-capture footage post design-language commit.

## Not demo-blocking but real (batch after filming)

- Keyboard access: hover-only tab close/pin + sidebar row actions, no tablist semantics on Workspace tabs, no arrow-key model in context menus, disabled handoff reasons unreachable to SR (`/impeccable harden` across clusters).
- Micro-text contrast: `text-dim`/`faint` and `muted/70` at 10–11px sit below 4.5:1 in several chrome labels.
- Perf niggles: dep-array-less effects (AppShell, SettingsView), per-pointermove column resize, broad store selectors in warm AgentPanel deck.
- Vocabulary: `#seq` vs `POD-nn` issue refs shown side-by-side in one column; sans-serif machine-voice labels in settings.

## What's genuinely strong (narrate it)

- Issue-color channel with registered `@property` crossfade — signature, demo-worthy.
- Motion discipline: braille spinner + mono timer as the only perpetual motion; grid-rows unfolds; connection hysteresis that never strobes.
- Honest states everywhere: instant memory headline before the /proc walk, blocker copy that says *why* handoff is unavailable, pairing dialog that anticipates the throwaway-tunnel failure.
- Board keyboard model (j/k, anchored menus) is Linear-grade.

## Suggested fix order before filming

1. `/impeccable polish` — token sweep: spawn overlay, sidebar greys, composer, yellows, off-palette badges.
2. `/impeccable quieter` — Signal Rule restoration (tray ambers, dirty-red, wifi pulse).
3. `/impeccable clarify` — remove "coming later"/unverified-shortcut copy.
4. `/impeccable animate` — handoff departure/arrival morph (hero moment).
5. `/impeccable harden` — clipboard guards (live-demo insurance); keyboard work can follow filming.
