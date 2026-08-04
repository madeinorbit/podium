# POD-692 — Wake and readiness latency budget (measured)

Method: three rigs, all outside the live checkout.

- **Rig 1 `probe/hookprobe.ts`** — bare node-pty, no Podium. Spawns real `claude`/`codex`, types a unique
  marker at a controlled delay, and detects acceptance two independent ways: an HTTP hook sink
  (Claude Code hooks) and a jsonl watcher (25ms poll) on the harness transcript. Claude points at a
  local always-500 API so trials cost no quota and transcript size stays constant. ~35 trials.
- **Rig 2 `probe/iso-driver.ts`** — real Podium server+daemon in one Bun process, isolated
  (`PODIUM_STATE_DIR=<scratch>/iso-state`, hook port 0, agent-relay port 0, `backend:'none'`,
  `PODIUM_NO_SCOPE=1`, env-scrubbed). Monkey-patches `toMachine`/`onDaemonMessageFrom`/`typeText`/
  `resurrectSession`/`enqueueMessage` to stamp every hop. Drives the real
  `resumeAndSend → queueText → resurrect → spawn → bind → drain → typeText` path plus a real
  one-off automation.
- **Rig 3 `probe/ui-check.ts` + `probe/browser-check.ts`** — two in-process clients (one legacy, one
  `metadataDelta`-cap, exactly what the web app negotiates) and a real Playwright chromium against
  the built web UI.

Every number below is tagged **measured** / **derived** / **unknown**.

---

## 1. PATH A — automation due → agent accepts a turn

| # | Hop | Number | How obtained |
|---|-----|--------|--------------|
| 1 | due time → scheduler tick notices | **24.3s** (this run); bounded 0–30s, mean ~15s | **measured** (rig 2: due 56232ms, tick 80530ms). Matches POD-691's observed 21s. `AUTOMATIONS_INTERVAL_MS=30_000`, boot one-shot at 20s. |
| 2 | tick → `AutomationsService.spawn` → `deps.resumeAndSend` | **8ms** (tick→enqueue) | **measured** (rig 2) |
| 3 | `resumeAndSend` → `queueText` → `enqueueMessage` | **6–21ms**, `inserted=true` | **measured** (rig 2). **The row DOES insert.** |
| 4 | `queueText` → `resurrectSession` → `toMachine({type:'spawn'})` | **26–33ms**; `resumeAndSend` returns `{ok:true,queued:true}` in **27–34ms** | **measured** (rig 2) |
| 5 | server → daemon `controlDispatch(spawn)` | **24–36ms** in-process (rig 2); **226–553ms on the live daemon**, median ~350ms (10 samples today) | **measured** (rig 2 + `journalctl` grep of `controlDispatch(spawn)`). ⚠️ POD-691's "549ms" is *plausible* (a 553ms sample exists at 13:38:15) but I could **not** find a `controlDispatch(spawn)` line at 15:43:31 — `timeTask` only logs ≥50ms, and the 15:40–15:50 window has none. Treat 549ms as unverified at that timestamp. |
| 6 | daemon → abduco + PTY exec → process running | **unknown — refused to guess** | My `/proc` start-time method is invalid: `btime` in `/proc/stat` is **second-granular**, so absolute child start times carry ±1s error (it returned exec times *before* the wake began). **Proxy, measured:** spawn call → first PTY byte = **0.8–1.5s (claude)**, **0.3–0.7s (codex)**. To measure properly: stamp a monotonic clock inside the daemon's `spawn()` around `spawnAbducoAgent`. |
| 7 | process running → `status='live'` | **24–36ms after `toMachine(spawn)`** | **measured** (rig 2). **What 'live' proves: almost nothing.** The daemon sends `bind` synchronously right after the `spawnAbducoAgent()` call returns (`control/session.ts:205`). `live` = "the spawn call returned" — not that the process is up, and *emphatically* not that the TUI accepts input. |
| 8 | **'live' → agent actually ready** | **claude: ~2.5–3.5s (80KB) / ~3.5–6s (636KB). codex: ~5–8.8s.** See §2. | **measured** (rig 1, ~35 trials) |
| 9 | typed → turn accepted (user entry in jsonl) | **claude 147–499ms; codex 668–5731ms** (codex incl. its input buffering) | **measured** (rig 1) |

**Total, automation → accepted turn:** ~24.3s (tick lateness) + ~0.4s (server+dispatch, live) + ~2.5–6s
(claude boot) ≈ **27–31s**, of which **~80% is the scheduler tick** and ~20% is harness boot. Everything
Podium itself does — enqueue, resurrect, dispatch, bind — totals **under 100ms in-process / ~400ms live**.
The server is *not* the problem.

### The drain types too early — reproduced 3/3 through the real path

Rig 2, real Podium drain vs. real `claude`:

| Wake | bind → `typeText` | Accepted? | Queue row after |
|---|---|---|---|
| small 80KB resume | **2075ms** | ❌ no `UserPromptSubmit`, no `working` | **deleted (0)** |
| large 636KB resume | **1607ms** | ❌ | **deleted (0)** |
| automation (one-off, resume mode) | **2273ms** | ❌ | **deleted (0)** |

The drain fires at **1.6–2.3s** after bind. Claude accepts at **≥2.5s**. So the drain lands in the dead
zone **every time**, and `drainQueuedMessages` deletes the durable row anyway. This is a **100%
reproduction of POD-691**, not a rare race. (Verified the inference: `prompt_submitted → phase:'working'`
in `agent-state/reducer.ts:53`, and rig 1 shows `UserPromptSubmit` fires on 100% of accepted trials and
0% of swallowed ones. No `working` = genuinely not accepted.)

**Why the heuristic fails, precisely.** `READY_QUIET_MS=600` keys on PTY output quiescence. Measured
first-moment-output-has-been-quiet-600ms (`quietAt600`):

| | quiet600 fires | agent actually accepts | gap |
|---|---|---|---|
| claude 80KB | ~1.5–2.6s (mean 1.9s) | ~2.5–3.5s | **~0.6–1.5s too early** |
| claude 636KB | ~2.0–3.6s | ~3.5–6s | **~1.5–2.4s too early** |
| codex | ~1.0–1.2s | ~5–8.8s | **~4–7s too early** |

Claude Code prints a small banner (~13 bytes), **goes quiet while parsing the transcript**, then paints
its real UI. Quiescence detects the *parsing pause* and calls it "settled". The constants aren't
mistuned — **the signal is measuring the wrong thing.**

---

## 2. The 'live' → 'actually ready' gap, and transcript size

`bytesBeforeType` is the real discriminator, not elapsed time:

| Harness / transcript | 0ms | 500ms | 1s | 2s | 2.5s | 3s | 3.5s | 4s | 4.5s | 6s | 8s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **claude 80KB** | ✗ | ✗ | ✗ | ✗✗✗ | ✗ ✓ | ✗ ✓✓✓ | ✓✓ | ✓✓✓ | – | – | ✓ |
| **claude 636KB** | – | – | – | ✗ | ✗ | ✗ | ✓ | – | ✗ | ✓ | ✓ |
| **codex small** | ✗ | ✗ | ✓(6.5s) | ✓(7.5s) | – | – | – | ✓(8.2s) | – | – | ✓(8.8s) |
| **codex 407KB** | – | ✓(6.2s) | – | – | – | ✓(5.8s) | – | – | – | – | – |

- **Claude, 80KB → ~2.5–3s. Claude, 636KB → ~3.5–6s.** Transcript size shifts the threshold by
  **~1–2.5s** for an 8× size increase. Real, but **smaller than expected** — and much smaller than
  the ~24s scheduler lateness. Boundary is noisy (one 636KB non-accept at 4.5s despite a painted UI).
- **The clean predictor:** every accepted claude trial had **≥2799 bytes** of PTY output before typing;
  every swallowed one had **≤135 bytes**. "The TUI has painted its full UI" — not "output went quiet".
- **Codex does NOT swallow — it buffers.** Input typed ≥~1s is queued and replayed when ready
  (accepted 4.2–5.7s *after* typing). Only <~0.5s is lost outright. **This contradicts the code
  comment** at `service.ts:67` ("the message is dropped (codex especially)") — as of codex-cli 0.144.5
  codex is the *safer* harness here; claude is the one that silently eats input.
- **Codex is much slower to first-accept: ~5–8.8s** regardless of transcript size — `READY_MAX_MS=6000`
  can force-deliver *before* codex has ever accepted anything.

---

## 3. PATH B — human moves back to a session

| Hop | Number | How obtained |
|---|---|---|
| Server status flip → client message (legacy `sessionsChanged`) | **25–34ms** | **measured** (rig 3) |
| Server status flip → client message (delta `metadataDelta`) | **16–33ms** | **measured** (rig 3) |
| `readTranscript` (636KB transcript, limit 2000) | **232ms cold / 60ms warm** (142 items) | **measured** (rig 2) |
| Real browser DOM reflects the wake | **300ms–1.03s** (250ms poll granularity — upper bound) | **measured** (rig 3, Playwright) |
| View-switch to an **already-live** session | dominated by `readTranscript` (~60–232ms) + frame replay | **derived** from the above |
| Reattach to a **hibernated** session | **= PATH A** (~2.5–6s claude, ~5–9s codex) | **derived** |
| Daemon durable reattach (`abduco` attach + redraw) after a restart | **unknown** | Not measured — rig 2 ran `backend:'none'` deliberately, to avoid touching live abduco sockets. To measure: run an isolated instance with `backend:'abduco'` + `PODIUM_NO_SCOPE=1` and stamp `handleReattach`. |

**PATH B verdict:** when the session is already live, moving back is **fast (~0.1–0.3s)** and nothing
needs fixing. When the session is parked, "moving back" *is* a wake, and it inherits PATH A's
**2.5–9s** — with the same swallow bug if anything is typed into it.

---

## 4. Recommendation: a real agent-ready signal

**Do not fix the readiness guess. Replace the delete-on-type invariant with an ack.** Readiness is
a moving target (it varies by harness, transcript size, MCP startup, and machine load, and codex
doesn't even need it); acceptance is a fact that both harnesses already emit.

**The obvious candidate is dead: Claude Code's `SessionStart` hook NEVER fires at interactive boot.**
Measured: `sessionStartHookMs: null` in **every** claude trial (~20), on 2.1.211, with the hook wired
exactly as `claudeHookSettings` writes it. (Confirms the `podium-agent-state-instrumentation` memory
note — still true 38 versions later.) `hooksBeforeType` was empty in every trial: **no hook of any kind
fires before the first prompt.** So no hook can tell you a resumed claude is ready.

**What fires reliably (measured):**

| Signal | Claude | Codex |
|---|---|---|
| `UserPromptSubmit` hook | **100% of accepted trials, 0 false positives**, 147–499ms after the CR | n/a (not wired in probe) |
| User record in transcript jsonl | ✓ | **✓ — the only signal codex gives** (`response_item/user`) |

**Proposed design (at-least-once + idempotency, per POD-691's "needs a design call"):**

1. **Type, then wait for the ack** — `UserPromptSubmit` for claude, the rollout's user record for codex.
   The transcript watch is the **harness-agnostic** one and Podium already tails both files
   (claude adapter `observer()`, codex rollout observer). Budget the ack at **~1s for claude, ~7s for
   codex** (measured p100: 499ms / 5731ms).
2. **Delete the queued row only on ack.** Today `deleteQueuedMessage` fires on `typeText.ok`, which
   only means "bytes went toward the daemon" — the exact at-most-once hole.
3. **No ack → retype** (bounded, spaced ~2s). Claude swallows silently, so a retry is the only cure;
   idempotency comes from the mutationId + "did a user record with this text appear".
4. **Keep quiescence only as a first-attempt hint**, and raise the floor: with `READY_FLOOR_MS=800 +
   READY_QUIET_MS=600` the drain types at ~1.6–2.3s, below claude's ~2.5s floor. A ~3.5s floor would
   make the *first* attempt usually land — but **do not ship that as the fix**, it's a tuning band-aid
   over a correctness bug (and the 636KB 4.5s non-accept shows no constant is safe).
5. **A 'once' automation must not disarm on an unacked delivery** — `apply()` currently sets
   `enabled=0` with `outcome='spawned'` before delivery is confirmed.

---

## 5. UI-staleness verdict: **NOT a bug. The transport is healthy.**

**Evidence (rig 3, both client types the web app can be):**

```
{"ev":"WAKE"}                                                    t=4730
{"client":"delta","type":"metadataDelta","status":"starting"}    +16ms
{"client":"legacy","type":"sessionsChanged","status":"starting"} +25ms
{"client":"delta","type":"metadataDelta","status":"live"}        +33ms
{"client":"legacy","type":"sessionsChanged","status":"live"}     +34ms
```

`hibernated → starting → live` reaches **both** a legacy client and a `metadataDelta`-cap client within
**16–34ms**. A real Playwright chromium against the built UI stopped rendering "hibernated" within
**300ms–1.03s** of a server-side wake, with **zero user interaction**. `broadcastSessions()` reaches the
client and the UI re-renders. The status does **not** go stale. I also checked the two plausible
drop mechanisms and neither can lose a transition: the coalescing trailing run re-runs the full
pipeline, and the byte-identical skip compares against the last *broadcast* payload, so the final
state always lands.

**So what did the operator see?** The most probable explanation is **POD-691 itself, not a UI bug**:
the session woke in ~30ms (too fast to *see* a "starting" flicker), went `live`, sat at `idle` — and
then **swallowed the turn**. The agent never produced a new user turn or any visible output. To a human
watching for the agent to *do something*, "it never woke" and "it woke and silently ate the message"
look identical. My rig 2 reproduced exactly that shape 3/3: status flips to live, `agentState:idle`
arrives, the drain types, and then **nothing ever happens again**.

**Caveat, stated honestly:** I could not reconstruct the operator's exact client state (which pane, chat
vs. native, whether the tab was attached). What I *can* say with evidence is that the status-transition
transport is not the culprit. If the operator specifically means "the native terminal pane stayed
frozen", that is a *different*, unmeasured hop (client re-`attach` + PTY redraw after a wake) — worth a
follow-up, but it is not `broadcastSessions` going stale.

---

## 6. What surprised me

1. **`SessionStart` never fires at interactive boot** — the one hook that would obviously solve this is
   absent, on the current 2.1.211. Kills the "just use hooks for readiness" answer outright.
2. **Codex buffers early input; claude eats it.** The code comment says the opposite ("codex
   especially"). Codex only loses input typed <~0.5s; claude silently eats anything before ~2.5s.
   The comment is stale and is steering the design at the wrong harness.
3. **Transcript size matters far less than the code assumes** — ~1–2.5s for an 8× size increase (80KB→636KB),
   versus a **24s** scheduler tick. POD-691 framed the 516KB replay as the villain; it's a bit player.
   **The scheduler tick is ~80% of the wake budget** and nobody is looking at it.
4. **The swallow is deterministic, not a race** — 3/3 through the real drain. The drain's ~1.6–2.3s
   type time sits below claude's ~2.5s floor essentially always, so *every* resume-and-send to a
   hibernated claude is exposed. Cross-agent mail with lifecycle `wake` rides this same path.
5. **`live` is a lie by ~2.5–9s.** The daemon sends `bind` right after the spawn *call returns* — before
   the process has emitted a byte.
6. **Resuming a codex thread in a different cwd shows a blocking "Choose working directory" menu** that
   eats typed input (my 15s trial failed on this; all trials passed once cwd matched the rollout's).
   Podium's `resurrectSession` passes `session.cwd` — a session that moved worktrees would hit this.
   Plausibly a live bug worth its own issue; not chased here.
7. **`/proc` start times are unusable at this resolution** — `btime` is second-granular (±1s). I dropped
   hop 6 rather than report a number I couldn't stand behind.

---

## Artifacts

- Report: `/tmp/claude-1000/-home-mgw-src-other-podium/3d9fd01e-81bd-45e8-b61c-b464da32a0f1/scratchpad/POD-692-wake-latency-report.md`
- Rigs: `probe/hookprobe.ts`, `probe/iso-driver.ts`, `probe/ui-check.ts`, `probe/browser-check.ts`
- Raw: `probe/results.jsonl` (35 trials), `probe/iso-timeline.json`, `probe/ui-check-seen.json`,
  `probe/ui-*.png` (browser screenshots)

**Live untouched:** no repo file written (all rigs in scratchpad); DB read-only (`mode=ro`); operator
session `8b3f82cb` never touched (still `live`, `last_resumed_at` unchanged); `/health` = ok.
Cleaned up: copied donor rollout removed from `~/.codex/sessions`, synthetic 636KB donor removed from
`~/.claude/projects`. Left behind (harmless): one real 80KB probe transcript in an isolated
`-tmp-claude-1000-...-probe-cwd` bucket, and a `trust_level` entry for the probe cwd in
`~/.codex/config.toml`.
