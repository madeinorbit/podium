# Top-bar host pressure — placement and design

**Issue:** POD-554 (brief part B, diagnosis item 5) · **Status:** artifact only, no implementation.
**Mock:** `host-pressure-topbar.html` (static, self-contained)
**Companion:** `lifecycle-policy.md` — the policy this readout makes visible

---

## 1. What is already in the shell

| surface | file | carries today |
|---|---|---|
| **Command bar → instrument well** | `apps/web/src/app/TopBar.tsx:116` → `features/machines/HostIndicators.tsx:180 HeaderHostIndicators` | one chip per machine: health dot · hostname · `MEM ▬▬▬ 62%` · update glyph. Then `.header-strip-seam`, then `QuotaIndicator header` |
| **Quota chip** | `features/machines/QuotaIndicator.tsx` | `QUOTA` group label + one `CC/CX/GR ▬▬ 41%` pool per account, model sub-rails under the meter |
| **Load popover** (hover/pin on a machine chip) | `features/machines/LoadPanel.tsx` | hover: memory composition bar (agents / projects / other) + a hibernation sentence. Pinned: per-session process rows, per-project rows, hibernation state + `Hibernation settings` deep-link, footer → connection |
| **Host info modal** | `features/machines/HostMemoryView.tsx` | tabs `'connection' | 'memory'` |
| **Status strip** (bottom, 24px) | `app/StatusStrip.tsx` + `AgentConcurrencyHistory.tsx` | "N agents **working**" + a 24-bucket / 12-hour skyline + selected issue + degraded link |
| **Settings → Hibernation** | `features/settings/sections/hibernation.tsx` | enabled · memory % · idle minutes · max idle sessions (+ "Cap unmet: N protected/ineligible") |

The readout grammar is already fixed and worth honouring exactly: **mark · meter · value**
(`.header-readout` / `.header-mark` / `.header-meter` / `.header-value`), mono, 36px meter, 3.5px
tall, carved into `--engraved`, value dim at rest and coloured only past a threshold.

### Two facts that constrain the design

1. **The status strip already owns "how many agents are computing"**, and its own doc states the rule
   it was written under: *"one git fact is never restated in two places"* — the general form being
   POD-279's "two counters for one fact read as two problems". So the top bar **must not** show a
   working-agent count. What it can show is a *different* fact: how many agent sessions are
   **resident** on this machine. Working ≠ resident is the entire POD-526 story (5 working, 39
   resident, ~35 processes).
2. **`HostMetricsWire` has no CPU field.** The load meter proposed here does not exist until
   `lifecycle-policy.md` PR 3 ships. This artifact assumes it; the UI PR is sequenced after it.

---

## 2. Recommendation: extend the machine chip, do not add a strip

The brief asks for "a top-bar host-pressure strip". I recommend **not** building a separate strip.
The well's stated rule is *"Host and quota in ONE well divided by hairlines, never loose readouts on
the bar: one object with internal structure reads as an instrument, five evenly-spaced numbers read
as a website's account row."* A third group would be a third hairline-delimited section competing
with two that already exist, and host pressure is not a peer of host memory — it *is* host, more of
it.

So: the per-machine chip grows from one readout to three.

```
  ┌─ machine chip ──────────────────────────────────┐ ┌─ quota ─────────────┐
  ● hostname   MEM ▬▬▬▬ 62%   LOAD ▬▬▬▬ 1.8×   AGT 12 │ QUOTA  CC ▬▬ 41% …
  └─────────────────────────────────────────────────┘ └─────────────────────┘
     ↑ same chip, same popover, no new seam            ↑ existing seam
```

### The three readouts

| readout | mark | meter | value | source |
|---|---|---|---|---|
| memory | `MEM` | used / total | `62%` | existing `HostMetricsWire.memory` |
| load | `LOAD` | **normalised against the hibernation threshold**, not against 100% | `1.8×` | new `HostMetricsWire.load.one / load.cpuCount` (policy PR 3) |
| agents | `AGT` | only when `maxIdleSessions != null`; else none | `12` | derived **client-side** from the existing `sessions` store slice filtered by `machineId` — no wire change |

**The load meter's scale is the design decision.** Filling it against some notional 100% would be
meaningless — load has no ceiling. Fill it against `hibernation.loadPerCore` (default 1.5×) so that
**a full meter means "this machine is at the point where Podium starts parking agents"**. The meter
then answers the only question an operator actually has, and it stays honest when the threshold is
retuned. Past 100% it clamps and the value takes `--destructive` via the existing
`.header-value[data-tone]` contract. Same for `AGT` when a cap is set: full meter = at the
convergence target.

`AGT` counts sessions with `status ∈ {live, starting, reconnecting}` on this machine — residency, not
activity. Its tooltip does the disambiguating: *"12 agent sessions live here — 4 working, 6 idle, 2
waiting on you."*

### Signal discipline

Per **The Signal Rule** (yellow only where something is asked of the operator) and the existing
`data-tone` ramp:

- At rest all three marks and values sit at `--text-dim`; only meters carry tint.
- `LOAD` value goes `warn` at ≥ 0.8× of threshold, `crit` at ≥ 1.0× (i.e. parking is happening).
- The **health dot** is the chip's one escalation channel. Today it is link health only. Add one
  amber state: *reclaimable inventory past a threshold* (default 20 worktrees or 10 GiB). That is
  the only thing in this design that asks the operator for something, so it is the only thing that
  earns a colour change in the chrome. Link health outranks it when both apply.

### Narrow behaviour

DESIGN.md §5 fixes the shed order: *"tool labels at 1180 · QUOTA group label with them · hostname at
1100 · numbers on quiet pools at 1024 · mode labels and the MEM mark at 940 · a number that crossed a
threshold is never shed."* The new readouts slot into that ladder without inventing a rung:

| width | behaviour |
|---|---|
| ≥ 1180 | all three readouts, marks and values |
| 1100 | hostname truncates first (already `flex: 0 1 auto`) |
| 1024 | `AGT` sheds its value → glyph-only, unless a cap is set and exceeded |
| 940 | `MEM` and `LOAD` marks shed (existing `.header-mark` rule); meters and values stay |
| below | `AGT` sheds entirely. `MEM`/`LOAD` never do — they are the pressure readout. |

`html[data-density="balanced"]` already hides `.header-mark` and `.header-value` inside
`.header-host-indicators`; `LOAD` inherits that for free and reads as a bare meter, which is the
right balanced-density answer. `AGT` should be hidden at balanced density (it is an operator number).

---

## 3. Reclaimable inventory: the popover, not the bar

"97 worktrees · 34 GiB reclaimable" is a **slow-moving inventory**, not a 5-second sample. It does
not belong on a 44px bar next to two live meters — it would be a number that never moves sitting
beside two that move constantly, which is how a bar starts reading as an account row.

Put it in the pinned `LoadPanel` as a third section, below the existing process rows and above the
hibernation sentence:

```
  ── Reclaimable ─────────────────────────────────
  Worktrees        97 checkouts · 34.2 GiB   [Review]
  Idle sessions    19 parkable · 2 protected
  Held             4 by uncommitted changes
  ─────────────────────────────────────────────────
  Auto-hibernation on: agents idle 30 min park past
  1.5× load or 80% memory.     Hibernation settings ›
  Worktree GC: proposing after 14 days.  GC settings ›
```

- **"Held: 4 by uncommitted changes"** is the most important line on the panel. It is the one class
  the policy will *never* touch automatically, and the only way an operator learns that some disk is
  theirs to resolve rather than the janitor's.
- **[Review]** opens the candidate list. Cheapest correct home: a third tab on the existing
  `HostInfoView` — `HostInfoTab = 'connection' | 'memory' | 'reclaim'`. It is already a
  machine-scoped tabbed modal; a new top-level fleet view would be a second place to look at the same
  machine.
- The hibernation sentence gains the load clause; a second deep-link points at the new worktree-GC
  settings. Both use the existing `.hp-link` + `setSettingsTab(...)` pattern from
  `LoadPanel.tsx:195`.

### Where the reclaimable numbers come from

| number | source | cost |
|---|---|---|
| reclaimable worktrees (count) | server DB: issues with `worktreePath != null` AND `isClosed` AND no live session on the path | cheap, in-memory |
| reclaimable bytes | new daemon probe: `du -s` over the candidate paths, or `git worktree list` + stat | **expensive** — fetch on panel open only, cache 60 s, same shape as the existing `memoryBreakdown` daemon RPC (`hosts/service.ts:330`) |
| held-by-dirty | the probe's `git status --porcelain` per candidate | expensive; same fetch, same cache |
| parkable / protected idle sessions | server already computes this — `idleCapUnmet` is on the wire today | free |

Nothing here needs a new streaming channel. The bar's three readouts come from the 5-second sample
and the client store; the inventory comes from one on-demand RPC that only runs while a human is
looking at the panel. That is deliberate: an inventory probe that walked 100 worktrees every 5
seconds would be a small copy of the problem this issue exists to fix.

### Server self-health (D-state, FD count) — deliberately excluded

The diagnosis's `~366 timerfds / ~1108 FDs / jbd2_log_wait_commit` is real and alarming, but it is
the separate timerfd-audit issue's, and it is a *developer* diagnostic, not an operator control. Put
it behind the existing connection tab if it lands at all. Nothing about it belongs in the 44px bar.

---

## 4. Interaction ladder

| tier | shows |
|---|---|
| **rest** | three readouts; dot amber only if reclaimable crossed its threshold |
| **hover** | existing `LoadPanel` hover tier + one new line: `Load 1.8× per core — auto-hibernation parks idle agents past 1.5×` (or `standing by at 1.5×`) |
| **click / pin** | full panel: composition bar, per-session and per-project rows, **new Reclaimable section**, two settings deep-links, connection footer |
| **[Review]** | `HostInfoView` `reclaim` tab: candidate worktrees with issue ref, age, size, why-refused; select-and-free. Reads the janitor's proposal set. |
| **settings links** | `Settings → Hibernation` (add a Load-threshold row to the existing section), `Settings → Hibernation → Worktree GC` (new sub-section: mode off/propose/auto + after-days) |

The [Review] tab is the "janitor proposal list" the diagnosis asked for, given a home that already
exists rather than a new view.

---

## 5. Rejected alternatives

| option | why not |
|---|---|
| **A separate host-pressure strip in the bar** | Third group in a well whose stated rule is host + quota divided by hairlines. Host pressure is not a peer of host memory; it is host. |
| **Put it in the status strip** | The strip's rule is *window*-scoped facts. Host pressure is machine-scoped and there may be several machines — the strip has no place to say which. |
| **Reuse the concurrency skyline for load** | The skyline is fleet-wide *working agents* over 12h; load is per-machine, instantaneous. Same shape, different fact — merging them would be the two-counters-one-fact failure in reverse. |
| **Show reclaimable GiB in the bar** | A number that never moves beside two that move constantly. Belongs to the inventory tier. |
| **A new fleet view** | `HostInfoView` is already the machine-scoped tabbed modal. A new top-level view is a second place to look at the same machine. |
| **Show `AGT` as "working"** | Duplicates the status strip. Residency is the fact with no home, and it is the one POD-526 was about. |

---

## 6. Scope of the eventual UI PR

Read-only, no new streaming channel, sequenced **after** the load wire field (policy PR 3) and the
GC job (policy PR 5):

- `HostIndicators.tsx` — two readouts added to the chip; `AGT` derived from the `sessions` slice
- `LoadPanel.tsx` — Reclaimable section, load clause in the hibernation sentence, GC deep-link
- `HostMemoryView.tsx` — `'reclaim'` tab
- `styles.css` — no new primitives; reuses `.header-readout` / `.header-mark` / `.header-meter` /
  `.header-value` / `.hp-*`. Only additions: the balanced-density and narrow rules for `AGT`.
- `settings/sections/hibernation.tsx` — load-threshold row + worktree-GC sub-section

No new component. That is the point of extending the chip rather than adding a strip.
