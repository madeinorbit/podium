# Handover & Input Prototype — Design

- **Date:** 2026-06-01
- **Status:** Approved (design) → ready for implementation plan
- **Scope:** A working prototype that *proves* two hard behaviors end-to-end: **handover**
  (resize + sync of a live agent session across desktop and mobile clients) and
  **keyboard / shortcut input** into a real `claude` session. Built inside the existing
  Podium monorepo, using the packages it was designed for. **Not** the full product.

---

## 1. Goal — what this prototype proves

Podium's whole premise is driving terminal coding agents from a first-class web + mobile
experience. The two riskiest pieces of that premise — the ones called out in
[`docs/mobile-web-agent-cli-challenges.md`](../../mobile-web-agent-cli-challenges.md) — are:

1. **Handover (resize + sync):** the *same* agent session attached to two clients at once
   (e.g. a desktop and a phone), where taking control from one resizes the server-side PTY
   to that client's geometry, forces a real redraw, and leaves **both clients showing the
   same screen**.
2. **Keyboard / shortcut input:** delivering the keys agent CLIs need (Esc, Tab, Ctrl-C,
   arrows, Enter, paste) from a mobile software keyboard, including the coupling where the
   soft keyboard opening *changes the viewport* and must drive a PTY resize.

The prototype is "done" when both work against a **real `claude` binary**, and the
mechanics are covered by automated tests that **I (the agent) can run and iterate on
autonomously** (see §7).

This is a vertical slice through the real architecture, not a throwaway: it exercises all
three publishable packages (`protocol`, `agent-bridge`, `terminal-client`) and the real
`daemon → server → web` topology.

---

## 2. Decisions (the forks that shaped this design)

| Fork | Decision | Why |
|------|----------|-----|
| What runs behind the PTY | **Real `claude` CLI** over a real PTY | The headline target; its true alt-screen/redraw behavior is the thing worth proving. A deterministic fixture TUI stands in for *automated tests* (claude is nondeterministic + needs auth). |
| Topology | **Faithful 3-process** — `apps/daemon` → `apps/server` → `apps/web` | Proves the real relay + the daemon↔server boundary, not just the packages in isolation. |
| Mobile | **Emulation *and* real phone**, both first-class | Emulation is the fast inner loop; a real phone is ground truth for the soft keyboard, which emulation structurally cannot fake. |
| Test strategy | **Structured-state + browser e2e + bridge integration tests** | The client is made observable (`window.__podium`, `data-*`, `screenHash`) and scriptable so assertions are on state, not pixels. |

---

## 3. Architecture & process topology

```
 apps/daemon (Node, tsx)            apps/server (Node, Hono)             apps/web (Vite + React)
 ┌──────────────────────┐   WS     ┌───────────────────────┐   WS      ┌────────────────────────┐
 │ @podium/agent-bridge  │◄────────►│  relay + controller   │◄─────────►│ @podium/terminal-client │  ← desktop client
 │  node-pty → `claude`  │ protocol │  tracking (1 session) │ protocol  │  xterm.js + key toolbar │
 │  resize / redraw /     │         │  tRPC: session info,  │◄─────────►│  + ViewportSource seam  │  ← mobile client
 │  input / output frames │         │  who-is-controller    │           └────────────────────────┘
 └──────────────────────┘          └───────────────────────┘            (both attach to the SAME session)
```

**The substance lives in the three publishable packages; the two apps are thin.**

- `@podium/protocol` — wire message union + zod schemas + frame sequence/epoch numbering.
  (Currently an empty `export {}`.)
- `@podium/agent-bridge` (Node) — `spawnAgent({cmd,cols,rows})` over `node-pty`; `onFrame`,
  `write(input)`, `resize(cols,rows)`, `redraw()`, `dispose()`. The redraw-on-takeover
  logic lives here. (Currently empty.)
- `@podium/terminal-client` (browser) — `mount(el, transport)` → xterm; the injectable
  `ViewportSource`; mobile key toolbar; controller/spectator rendering; emits `resize` from
  the measured grid; the observability contract. (Currently empty.)
- `apps/daemon` — hosts one bridge (spawns the fixture, then `claude`) and connects out to
  the server.
- `apps/server` — relays frames daemon↔clients, tracks the controller, exposes a minimal
  tRPC surface (session info / who-is-controller). Serves nothing on the hot path but WS.
- `apps/web` — a single client UI; in tests it is opened as **two independent pages**
  (desktop-sized + Pixel-emulated) attached to the same session.

`@podium/core` is **not modified** by the prototype; wire and geometry types live in
`@podium/protocol`. (`web`/`server` keep their existing empty `@podium/core` import.)

---

## 4. Protocol (`@podium/protocol`)

A single zod-validated discriminated union on `type`, carried as **inspectable JSON** (not
binary) so every message can be logged and asserted in tests. Binary frames + backpressure
are a known production optimization, explicitly out of scope here.

**Browser client → server**

| `type` | fields | notes |
|--------|--------|-------|
| `hello` | `clientId`, `viewport:{cols,rows,dpr}` | sent on connect |
| `input` | `data` (base64 PTY bytes) | keystrokes / toolbar / paste — **honored only from the controller** |
| `resize` | `cols`, `rows` | from the measured grid; controller authoritative, spectator resize is stored-but-advisory |
| `requestControl` | — | take over as controller (fieldless; server uses the client's last-reported viewport) |
| `redrawRequest` | — | ask for a fresh repaint (on attach / reconnect) |

**Server → browser client**

| `type` | fields | notes |
|--------|--------|-------|
| `welcome` | `clientId`, `sessionId`, `controllerId`, `geometry:{cols,rows}` | initial state snapshot |
| `outputFrame` | `seq`, `epoch`, `data` (base64) | PTY bytes; **`seq` monotonic, `epoch` bumps on takeover** — the sync-assertion handles |
| `controllerChanged` | `controllerId`, `geometry` | broadcast on every takeover |
| `geometry` | `cols`, `rows` | current authoritative PTY size (lets spectators letterbox) |
| `agentExit` | `code` | `claude` exited |

**Daemon ↔ server** (shares the verbs): daemon→server `bind {sessionId,cmd,geometry}`,
`outputFrame`, `agentExit`; server→daemon `input`, `resize`, `redraw`.

Two load-bearing ideas: (1) **`epoch` + `seq`** make "are both clients in sync after a
takeover?" a deterministic assertion; (2) **input/resize gated to the controller**
server-side *is* the entire multi-client control model, in one rule.

Prototype constraints: one session, one daemon, one controller.

---

## 5. Controller / spectator, the handover, and redraw

**Model.** Exactly one client is *controller*; everyone else is a *spectator*. The
controller's geometry is authoritative for the PTY. Input and resize are honored only from
the controller. First client in is controller by default; `requestControl` is
last-taker-wins. Prototype UI = a *Take control* button + a "spectator" badge (no
contention dialog).

**Spectators still send `resize`** (the server stores it but does not apply it to the PTY)
so that when a spectator takes control, the server already knows its grid — which is why
`requestControl` is fieldless.

**Handover sequence** (this *is* "resize + sync"):

1. Mobile spectator taps *Take control* → `requestControl`.
2. Server promotes it, looks up its last-reported `{cols,rows}`, then:
   `resize(cols,rows)` to daemon → `redraw` to daemon → bump `epoch` →
   broadcast `controllerChanged` + `geometry` to all clients.
3. Daemon: `agent-bridge.resize()` then `agent-bridge.redraw()`.
4. Fresh `outputFrame`s (new `epoch`) fan out → all clients converge on the controller's
   geometry, same `epoch`/`seq`.

**`redraw()` — the mechanism that makes it actually repaint.** A PTY resized to the size it
already has may emit *no* repaint signal. So `agent-bridge.redraw()` performs a
**resize-nudge**: `rows → rows−1 → (next tick) rows`. That forces a genuine `SIGWINCH`
geometry change a full-screen TUI like `claude` cannot ignore, guaranteeing a real repaint
even when the target size equals the current size. (It may additionally emit `Ctrl-L`, but
the nudge is the reliable path.)

**Sync = identical bytes, not approximation.** Every client receives the *same* frame
stream at the controller's geometry. The controller renders 1:1; **spectators render the
controller's exact grid and CSS-scale/letterbox it** to fit their viewport. A desktop
watching a mobile controller sees the mobile-sized screen, scaled — identical content. We
deliberately reject the "each client at its own size" path the challenges doc flags as
approximate; identical-bytes-scaled is what makes sync assertable via `screenHash`.

**Reconnect: redraw, don't replay.** On (re)connect a client sends `hello` +
`redrawRequest`; the server replies `welcome` and asks the daemon to `redraw`, so the
client gets a clean *current* screen rather than a replay of incompatible raw history.

**Non-goals for the proto:** persistent transcript, scrollback replay, backpressure/flow
control, WS auth, multiple sessions.

---

## 6. New dependencies (the "what's missing" list)

Every package is currently an empty stub with no runtime deps. The prototype adds:

| Package / app | Adds |
|---------------|------|
| `@podium/protocol` | `zod` |
| `@podium/agent-bridge` | `node-pty`; dev: `vitest`, `tsx` |
| `@podium/terminal-client` | `@xterm/xterm`, `@xterm/addon-fit` (browser uses native `WebSocket`, so no `ws`); dev: `vitest` + `jsdom` |
| `apps/server` | `hono`, `@hono/node-server`, `ws`, `@trpc/server`, `zod` |
| `apps/daemon` | `ws` (Node client → server); dev: `tsx` |
| `apps/web` | `react`, `react-dom`, `vite`, `@vitejs/plugin-react` |
| root (dev) | `@playwright/test` (e2e, Chromium + WebKit) |

`node-pty` is a native addon (prebuilt binaries generally available for Node 22); the
daemon therefore runs under Node, as the monorepo design already anticipated.

---

## 7. Testability — how the agent drives and verifies this

Everything rests on making the client **observable** and **scriptable**, so assertions are
on state, not pixels.

**Observability contract.** `@podium/terminal-client` publishes live state on
`window.__podium` (mirroring key fields to `data-*` on the mount node):

- `role` (controller/spectator), `cols`, `rows`, `epoch`, `lastSeq`, `connected`,
  `clientId`, `controllerId`
- **`screenHash`** — a hash of the rendered xterm text buffer. *Two clients in sync ⇒
  identical `screenHash` at the same `epoch`.* This is how sync is asserted without
  pixel-diffing.
- a structured `events[]` log + stable console lines (`[podium] frame epoch=2 seq=57`).
- test-only controls (gated by `?podiumTest=1`): `simulateKeyboard(insetPx)`,
  `forceGeometry({cols,rows})`, `takeControl()`.

**The `ViewportSource` seam (the linchpin for mobile).** Interface
`{ current(): {width,height,dpr}; onChange(cb) }`.

- Production impl wraps `visualViewport` + `ResizeObserver` (container) + `orientationchange`,
  computing cols×rows from measured cell size.
- Test impl is injectable; `simulateKeyboard(inset)` shrinks height and fires `onChange`.
- **Same downstream path in both** (onChange → recompute cols×rows → emit `resize` →
  controller PTY resize + redraw). Only the *trigger* differs. This makes the
  hardest-to-emulate behavior (soft keyboard) the *easiest* to drive deterministically.

**Tiers** (emulation *and* real phone are both first-class):

| Tier | What runs | Real soft kbd? | Proves | Cadence |
|------|-----------|----------------|--------|---------|
| **0 — Bridge tests** (vitest, Node) | `@podium/agent-bridge` vs a ~50-line deterministic alt-screen **fixture TUI** (paints its grid + a frame counter, repaints on `SIGWINCH`) | n/a | spawn→frames; resize→new geometry; **redraw-nudge forces repaint when size unchanged**; input round-trips. Auth-free, exact | every change |
| **1 — Emulation** (CfT `--no-sandbox` + WebKit) | Chromium **Pixel profile** (real touch/DPR/mobile-UA; orientation = dim swap) *and* **WebKit** (closest to iOS Safari w/o a Mac); two pages → one session | no | touch policy, toolbar, layout, **two-client takeover/sync** (assert equal `epoch` + identical `screenHash`), controller `cols/rows` == PTY | every change |
| **2 — Synthetic keyboard** | `simulateKeyboard(300)` in the Tier-1 browsers | synthetic | the full keyboard→recompute→`resize`→PTY resize+redraw→converge chain, both engines. The **only** way to hit iOS-shaped insets on this box | every change |
| **3 — Real Android, agent-driven** | `platform-tools` zip → `adb` (no sudo); phone in USB/wireless debug; `adb forward tcp:9222 localabstract:chrome_devtools_remote`; attach Playwright/CDP to **real mobile Chrome on the real phone**; serve on `0.0.0.0`; `adb exec-out screencap` for visuals | **yes, real** | genuine `visualViewport` insets, real touch, real font metrics — confirms the synthetic inset matches reality | when an Android phone is tethered (acceptance gate) |
| **4 — Real iPhone** | iOS Safari (worst case for terminal + keyboard); no clean Linux drive path | **yes, real** | iOS ground truth | human pass (you) / Mac / cloud device later |

**What runs when.** Tiers 0–2 on every edit — fast, fully local, no device: the autonomous
inner loop. Tier 3 is the agent-driven real-Android acceptance gate the moment a phone is
plugged in. Tier 4 is the human iOS sign-off.

---

## 8. Acceptance criteria — what counts as "proven"

1. **Real `claude` end-to-end** — daemon spawns it over `node-pty`, output renders live in a
   browser xterm, a typed+Entered prompt reaches it and produces visible response frames.
2. **Mobile keyboard / shortcuts** — the toolbar delivers Esc, Tab, Ctrl-C, arrows, Enter
   (e.g. Esc dismisses, Ctrl-C interrupts), and typed text + paste round-trip.
3. **Handover both ways** — desktop + mobile on one session; taking control from mobile
   resizes the PTY to the mobile grid, forces a redraw, and **both clients converge**
   (equal `epoch` + identical `screenHash`) within ≤ ~1.5 s; desktop can take it back.
4. **Soft-keyboard coupling** — keyboard open (synthetic in Tier 2, real in Tier 3) shrinks
   the viewport → controller recomputes cols×rows → PTY resize + redraw → clients stay in
   sync.
5. **Automated tiers green** — Tier 0 vitest; Tier 1–2 Playwright (Chromium + WebKit)
   asserting convergence + the keyboard chain; Tier 3 passes with an Android phone attached.

Latency is *not* a benchmarked SLA; convergence is asserted by polling `screenHash`
equality up to the ~1.5 s bound.

---

## 9. Build phases

- **Phase 0 — Unblock the browser (gating).** Proceed with `--no-sandbox` for the agent's
  loop now; provide the user one `! sudo …` line for the clean AppArmor fix (load/repair the
  existing `harness-chrome-for-testing` profile, or set
  `kernel.apparmor_restrict_unprivileged_userns=0`). Confirm Playwright launches Chromium
  **and** WebKit against a localhost page. Drop in `adb` via the platform-tools zip (no
  sudo) for Tier 3 readiness. **Exit:** a green "browser launches + loads a page" smoke
  check.
- **Phase 1 — protocol + bridge + fixture (Tier 0 green).** Implement `@podium/protocol`
  (§4 zod union); `@podium/agent-bridge` (spawn / resize / **redraw-nudge** / input /
  frames); the deterministic fixture TUI. No browser yet.
- **Phase 2 — daemon + server relay.** `apps/daemon` hosts the bridge; `apps/server`
  (Hono + `ws` relay + controller tracking + minimal tRPC). Assert bytes flow
  daemon→server→raw ws client in a Node test.
- **Phase 3 — terminal-client + web (Tier 1–2 green).** `@podium/terminal-client` (xterm
  mount, `ViewportSource` seam, key toolbar, controller/spectator render + letterbox,
  observability contract); `apps/web` mounts it twice; Playwright e2e for takeover/sync +
  synthetic keyboard on both engines — still on the fixture TUI for determinism.
- **Phase 4 — real `claude` + real-phone pass.** Swap the daemon's spawn target to
  `claude`; loose live confirmation (render + input + takeover); Tier 3 real-Android pass
  when tethered; Tier 4 (iOS) handed to the user.

---

## 10. Environment notes (verified 2026-06-01)

- **OS:** Ubuntu 24.04.4, kernel 6.8.0-117. 8 CPUs, ~23 GiB RAM, ~99 GB free disk.
- **No KVM / hardware virtualization** (`/dev/kvm` absent, 0 `vmx`/`svm` flags) → **an
  Android *emulator* cannot run on this box.** Real-Android testing therefore uses a
  *tethered real phone* over `adb` (Tier 3), not an AVD.
- **Chrome for Testing present:** `~/.cache/puppeteer/chrome/linux-127.0.6533.72/…`;
  Playwright Chromium already downloaded (`~/.cache/ms-playwright/chromium-1208` & `-1217`).
- **AppArmor blocker:** `kernel.apparmor_restrict_unprivileged_userns = 1`. A
  `harness-chrome-for-testing` profile already exists in `/etc/apparmor.d/`. **`sudo` is not
  available non-interactively**, so the clean fix is a user-run `!` command; the agent's
  own loop is unblocked with `--no-sandbox` on localhost.
- **`adb` is not installed** but can be added without sudo via the standalone platform-tools
  zip.

---

## 11. Non-goals

Auth, persistence / transcript, scrollback replay, backpressure / binary frames, multiple
sessions or agents, Codex support, conversation index, native apps. All are named in
`ARCHITECTURE.md` as future work.

---

## 12. Open questions / risks

- **`node-pty` on Node 22** — relies on a prebuilt binary; if none resolves, a source build
  (`node-gyp` + toolchain) is needed. Verified during Phase 1.
- **WebKit ≈ iOS Safari, not identical** — Tier 1/2 reduce iOS risk but do not eliminate it;
  Tier 4 (real iPhone) remains the only true iOS signal.
- **`screenHash` stability** — must hash the *text* buffer (not styling/cursor) to avoid
  false mismatches between controller (1:1) and spectator (scaled) renders; the hash is
  computed from xterm's buffer text, independent of CSS scale.
- **Real-phone availability** — Tier 3 only runs when an Android device is tethered; CI
  without a device runs Tiers 0–2 only.
