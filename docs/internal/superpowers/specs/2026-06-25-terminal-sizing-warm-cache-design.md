# Visibility-driven terminal sizing + warm session cache

**Date:** 2026-06-25
**Branch:** `feat/terminal-sizing`
**Status:** Design approved, pending spec review

## Problem

Two related defects, both rooted in conflating *DOM mount/visibility* with *PTY size*:

1. **The quarter-size terminal bug.** A terminal frequently renders at the
   default 80×24 grid (≈600×408px at the app font) inside a much larger
   container. Root cause: panels for inactive tabs mount under `display:none`
   (`Workspace.tsx:244`, Tailwind `hidden`). A zero-size container makes the
   initial `view.fit()` (`session-mount.ts:63`, no retry loop) return
   `undefined`, so no resize is sent and the grid keeps its constructor default.
   The hidden panel is also frequently the *first* client to attach, so it
   auto-becomes controller (`session.ts:190`) and pins the shared PTY to 80×24.
   A second corruption vector: `requestControl` snaps `geometry` to the
   requester's last-known `client.viewport` (`session.ts:345`) — a stale hidden
   viewport shrinks the PTY the moment that client grabs control.

2. **Slow reload on view/tab switch.** Toggling chat↔native for one session
   disposes and recreates the terminal (the mount effect is keyed on
   `effectiveMode` and the term div is conditionally rendered —
   `AgentPanel.tsx:244,513`), forcing xterm re-init + DOM layout + a bounded
   (≤256 KB) replay repaint each time.

## First principles

A PTY has exactly one kernel winsize; every attached process sees that one size.
So the **session has a single authoritative grid** (`Session.geometry`,
server-owned, broadcast via the `attached`/state message). Three concepts are
currently tangled and must be separated:

| Concept | Owner | Truth |
| --- | --- | --- |
| **A. Authoritative grid** (PTY winsize) | server (`geometry`) | the one size the agent sees |
| **B. Who drives + their desired size** | the **visible, eligible** client | only this client may set A |
| **C. DOM mount lifecycle** (warm/cold) | client | must NOT influence A or B |

**The rule that makes it correct forever:** the PTY size changes *only* in
response to a real viewport event of a *visible, eligible* client. Mount,
unmount, hide, and attach never touch it. The server's `geometry` is the
generalized "display at this size" signal; agents already react to it via
SIGWINCH, so no per-agent code is required.

## Policy decisions (locked)

- **Arbitration: last-foregrounded-wins.** When a session is foregrounded on
  more than one device, the most-recently-foregrounded *visible* client takes
  control and sets the size; others reflow read-only. The **Take Control button**
  is the explicit manual override. Auto-grab on foreground *does* steal from a
  remote controller (acceptable for the single-user-multi-device case).
- **Visibility signal: `active` prop + tab visibility.** Eligibility =
  `active` (the prop `Workspace` already passes for the shown tab) AND
  `document.visibilityState === 'visible'`. No IntersectionObserver. The actual
  resize still waits until the container is *measurable* (retry-until-measurable).
- **Warm-cache mechanism: LRU, drop WebGL when hidden.** Keep the N
  most-recently-viewed panels attached but hidden; evict least-recent beyond N;
  drop the WebGL addon (scarce: browsers cap ~16 contexts) when hidden, recreate
  on show. **N and the WebGL-drop policy are determined by measurement, not
  guessed** (see Component 4).
- **Scope: one spec, independently shippable parts.** Components 1–2 (the bug
  fix) ship without waiting on Component 4's GPU benchmark.

## Components

### Component 1 — Server: visibility-gated arbitration (`apps/server/src/session.ts`)

`client.visible` already arrives via the `presence` message
(`relay.ts:1147` → `ClientConn.visible`). Wire it into arbitration:

- **attachClient (line 190):** a *not-visible* client never auto-becomes
  controller. If no visible client exists, `controllerId` stays `null` and
  `geometry` is frozen (no driver ⇒ no resize).
- **handleResize (line 336):** keep the controller gate; additionally ignore a
  resize from a client currently flagged not-visible (defense in depth).
- **Control handoff on detach/hide:** when the controller detaches or goes
  hidden, pass control only to another *visible* client. If none, set
  `controllerId = null` and leave `geometry` unchanged (never snap the PTY back
  to the 80×24 default).
- **requestControl:** foregrounding auto-issues it (last-foregrounded-wins) and
  resizes the PTY to that client's viewport; the Take Control button issues the
  same message as an explicit override. One server path, two callers. A
  not-visible requester is rejected (only the explicit-override path from a
  visible client succeeds).

### Component 2 — Client: one `SessionViewport` owner (`packages/terminal-client/src/session-mount.ts`)

Replace the scattered fit logic (bare mount-fit at :63, controller-gated
`viewport.onChange` at :193, one-shot controller-enter at :170) with a single
owner:

- `eligible = active && document.visibilityState === 'visible'`.
- On **becoming eligible:** always send `requestControl` (claim the driver role
  — last-foregrounded-wins), then retry-until-measurable (fixes the original
  no-retry bug), fit, and send a **resize only if** the fitted grid differs from
  server `geometry`; otherwise send `redraw()` (a redundant resize raises
  SIGWINCH and repaints/flashes TUIs — avoid it). Control acquisition and resize
  are independent: foregrounding takes control even when the size is unchanged.
- On **real viewport change while eligible** (`ResizeObserver` / `visualViewport`):
  re-fit, resize on change. This is what makes desktop-window-resolution changes
  and mobile↔desktop handoff Just Work — they are genuine viewport events of a
  visible client.
- On **becoming ineligible** (hidden): send `presence(visible:false)`; never
  resize.
- **Dedup** the sent grid against both the last-sent value and server `geometry`
  from `onState`, so a hidden panel cannot shrink anything and `onState` no
  longer fights the client.

The `active` prop must be threaded from `AgentPanel`/`Workspace` into
`mountSession` so the owner can read eligibility (today `mountSession` does not
receive it).

### Component 3 — Keep terminal warm across chat↔native (`apps/web/src/AgentPanel.tsx`)

- Drop `effectiveMode` from the mount-effect dependency list so the terminal is
  not disposed/recreated on a mode toggle.
- Render `ChatView` as an overlay over the still-attached terminal; in chat mode
  the terminal is hidden (`display:none`) but kept mounted. Safe now because a
  hidden terminal no longer proposes a size (Component 2).
- Mode toggle only switches which surface is shown and where focus lands.

### Component 4 — Warm-set LRU + eviction (`apps/web/src/Workspace.tsx` + store)

Mechanism: keep the N most-recently-viewed panels mounted + attached but
`display:none` (now safe); evict LRU beyond N (dispose + detach); drop the WebGL
addon when a panel is hidden, recreate on show.

**Measurement experiment gates the parameters.** Run on the isolated-Podium +
Playwright rig (see memory: *isolated-podium-for-live-testing*,
*podium-headless-browser-testing*). Measure, for a backgrounded session:

- (a) memory + live WebGL context count **with** WebGL retained while hidden;
- (b) the same **without** WebGL (addon disposed on hide);
- (c) latency to fully-visible-and-typeable when returning to the session, for
  each of (a) and (b).

Decide N (separate desktop/mobile caps) and the WebGL-drop policy from the data.
Until measured, behavior stays as today's keep-mounted (no eviction); only the
measured numbers get baked in. Component 4 must `log()`/document any cap so a
silently-dropped warm session is never mistaken for "kept everything".

## Testing strategy (TDD throughout)

**Component 1 (server, `session.ts`):**
- a not-visible client attaching does not become controller; `geometry` frozen.
- a hidden controller's resize is ignored (PTY size unchanged).
- control handoff skips hidden clients; with no visible client, `controllerId`
  becomes `null` and `geometry` is unchanged.
- a visible client foregrounding becomes controller and resizes the PTY to its
  viewport.

**Component 2 (client, `SessionViewport`):**
- ineligible (not active, or tab hidden) never sends a resize.
- becoming eligible while the container is unmeasurable retries, then sends a
  single resize once measurable.
- a fit equal to server `geometry` sends `redraw()`, not `resize`.
- a real viewport change sends `resize` with the new grid.

**Component 3:** toggling mode keeps the *same* `TerminalView`/`MountedSession`
instance (no dispose); the hub connection survives.

**Component 4:** the measurement harness produces the numbers; eviction unit
tests cover LRU ordering and dispose-on-evict once params are chosen.

## Sequencing

1. **Component 1 + 2 (the bug fix), test-first.** Ships independently.
2. **Component 3.** Removes chat↔native lag.
3. **Measurement → Component 4.** Caps memory with measured params.

## Out of scope

- Opt-in min-size co-viewing (server already tracks every `client.viewport`, so
  it remains a clean future addition).
- Any per-agent (Claude/codex/shell) resize handling — agents react to SIGWINCH
  unchanged.
