# Update operations: one durable update process

- **Date:** 2026-08-14 (facts verified against `cf9ec8c2b`)
- **Issue:** POD-2087 (Updater architecture redesign)
- **Status:** Approved 2026-08-14; the recommended answers in §9 are adopted as decisions
- **Relation to prior art:** Builds on `2026-08-04-coherent-update-story-design.md` (POD-1670).
  That design's *plumbing* — authority vs delivery, signed artifacts, converge-to-target,
  crash-safe daemon swap, the wire window — is sound and is kept. This spec replaces its
  *orchestration and UI* layer, which is where today's instability and UX mess live.

## 0. Summary

Today an update is an **emergent phenomenon**: the client derives "what is happening" from four
independently polled facts, the server holds all orchestration state in memory while the flow
deliberately restarts the server, and three different pieces of code compute three different
progress numbers for the same panel. Nothing has a beginning, an end, or an identity, so
nothing can be resumed, deduplicated, or honestly reported.

The fix is one concept: the **operation** — a durable, server-persisted state machine with an
id, a plan of named steps, per-step liveness, and a terminal outcome. The framework is
general (server moves and other long-running lifecycle work will reuse it, §3.0); the
**update operation** is its first kind. At most one exclusive operation can be active per
server. Every client, on every surface, is a *renderer* of the operation; the only thing a
client ever computes locally is "does my surface still need its local action (reload /
restart)?" Everything else — progress, liveness, errors, completion — comes from the
operation object.

## 1. Diagnosis: why the updater is unstable today

Grounded in the current code, most user-visible symptoms trace to five structural causes:

1. **No durable update entity.** `UpdatesService` keeps targets, rollouts, machine states and
   pending grants in in-memory maps (`apps/server/src/modules/updates/service.ts:85-89`) —
   and the dev flow *deliberately restarts this very process* mid-update
   (`modules/updates/trpc.ts:172-230`). Cross-restart correctness rests entirely on the
   daemon's `pending-update.json` and re-derivation. The client's picture is likewise
   ephemeral: `dismissed` is component state (`UpdateDialog.tsx:33`), so hiding the dialog
   loses the update until something else changes; the only persisted client state anywhere is
   a reload counter in sessionStorage.

2. **Progress has three competing sources.** The action path computes `done`/`total` from
   client-side flags fixed at button-press time (`use-update-state.ts:337-357,437`), the
   fleet-derived path computes different numbers (`update-view.ts:349-353`), and the server
   returns a third total that overwrites the client's mid-flight
   (`modules/updates/trpc.ts:333-341`). Counts jump and stall; "1 of 3 places are ready" has
   no single owner.

3. **No liveness model.** The daemon reports only three phases (`downloading` once,
   `restarting` once); a nine-minute download emits no intermediate progress. The 10-minute
   grant deadline only ages **when someone reads `fleet()`** (`service.ts:379`) — poll-driven,
   not timer-driven. The client can hold a button spinner for up to five silent minutes
   (`waitForWebIdentity`, 300×1s). The user cannot distinguish "working" from "stuck",
   because the system itself cannot.

4. **Edge-driven UI over instantaneous facts.** The dialog is a pure function of the latest
   polls. Any transient — the server restarting (by design!), a failed poll, a mid-update
   target change — changes the story mid-flight. This is why a full dev update is experienced
   as *multiple rounds*: dialog → reload → up to two silent guard hard-reloads
   (`version-guard.ts:85-155`) → possibly a second dialog for whatever place moved last.

5. **No single-flight, no queueing.** Nothing represents "an update is running, don't offer
   another". Re-publishing a target mid-wave mutates the wave (`service.ts:161-169`); two tabs
   or two users can both press Update; a new version arriving mid-update changes what the
   panel describes.

On top of these, the survey found real defects that any redesign must not carry forward — see
§10.3 (they are tracked as sub-issues of this epic).

## 2. First principles

A good updater for a multi-place product must satisfy:

- **P1 — An update is a noun.** It has identity, a start, an end, a plan, and an outcome. It
  can be observed, resumed, and audited. It is never inferred.
- **P2 — One writer of truth.** The server computes all shared state (progress, liveness,
  outcome). Clients render; they do not re-derive.
- **P3 — Survives its own medicine.** The process being updated includes the orchestrator.
  The operation must be persisted and *adopted* by the successor process, reconciled against
  observable reality, not remembered state.
- **P4 — Liveness is part of the contract.** Every running step carries "last progress at".
  Deadlines fire on timers. A stalled step is a visible state, not an indistinguishable hang.
- **P5 — Local actions are local.** The only thing a surface owns is its own reload/restart.
  A browser never restarts someone's native app; a fleet wave never rewrites a signed app
  bundle.
- **P6 — Single-flight with a queue.** One active exclusive operation per server. Newer
  versions wait their turn and are offered only after the operation terminates.
- **P7 — Errors speak user, carry engineer.** Every failure has: what happened (places, plain
  language), the one next action, and collapsed technical detail.
- **P8 — The operation contract is frozen,** exactly like `/version`: additive fields only,
  every consumer tolerates absence and unknowns. An old web bundle must be able to render a
  new server's operation, because a bundle swap happens *during* the update.

## 3. The operation

### 3.0 A general operations framework

The persistence, engine, liveness, and rendering contract are deliberately **not
update-specific**. An operation is `{ id, kind, state, steps, awaiting, deferred, error,
timestamps, details }` where `kind` selects a registered definition providing three hooks:

- `plan(context)` — compute the step list at creation time;
- `reconcile(operation, reality)` — called on server boot to re-derive step states from
  observable facts (P3);
- per-step `ensure()` runners — idempotent, check-reality-first executors.

Kind-specific data lives under `details` and follows the same frozen-contract law. Kinds
declare an **exclusion group**; at most one operation per group can be active. `update`
belongs to group `lifecycle` — a future `server-move` operation will join the same group, so
an update and a server move can never interleave. The generic layer owns: the `operations`
table, single-flight per group, timer-driven deadlines and heartbeat staleness, adoption on
boot, history/retention, and the `operations.active` / `operations.history` exposure.

Everything below specifies the `update` kind; where it says "the engine", that is the
generic layer.

### 3.1 The object

Persisted server-side (SQLite, additive migration; one row per operation, JSON payload plus a
few indexed columns). Exposed verbatim to clients.

```jsonc
{
  "id": "op_01j…",
  "kind": "update",
  "details": { "target": { "version": "0.4.3", "channel": "dev", "notes": { "summary": "…", "url": "…" } } },
  "state": "running",            // pending | running | waiting | done | failed | canceled
  "createdBy": "user",            // user | policy (future)
  "startedAt": 1765700000000,
  "updatedAt": 1765700041000,     // heartbeat: bumped on every accepted progress event
  "finishedAt": null,
  "steps": [
    { "id": "prepare",  "title": "Preparing the update",   "state": "done" },
    { "id": "machines", "title": "Updating your machines", "state": "running",
      "progress": { "done": 1, "total": 3 },
      "lastProgressAt": 1765700041000,
      "places": [
        { "id": "m_a", "name": "vmi3407763", "state": "downloading", "percent": 62 },
        { "id": "m_b", "name": "ludovico",   "state": "done" },
        { "id": "m_c", "name": "macbook",    "state": "pending" }
      ] },
    { "id": "server",   "title": "Updating your server",   "state": "pending" },
    { "id": "web",      "title": "Serving the new app",    "state": "pending" }
  ],
  "awaiting": [],                 // surface-scoped asks, see §3.5
  "deferred": [],                 // eventual places, see §3.6
  "error": null                    // typed, see §7 — only when state = failed
}
```

Rules:

- The **step list is the plan**, computed once at operation creation from the target's
  per-artifact digests and the fleet snapshot. Steps that don't apply are omitted, never
  shown as skipped noise. Step ids are stable API; titles are presentation.
- `updatedAt` is the operation's heartbeat. Any UI can render "last progress 40 s ago" from
  it without knowing what the step does (P4).
- The operation object is **plain JSON with `/version`'s frozen-contract law** (P8): fields
  are added, never removed or retyped; absent is never an error; unknown is ignored. A
  conformance test enforces it, like the `/version` one.

### 3.2 Lifecycle

```
            offer                    start                steps complete
  target ─────────► offered ──────────► running ─┬──────────► done
  published         (no operation)      │        │
                                        │        ├─► waiting  (only surface-local asks left)
                                        │        │        └──► done (asks satisfied / expired)
                                        │        ├─► failed   (typed error, retryable)
                                        │        └─► canceled (only from safe steps)
```

- **Offered is not an operation.** An available target is just the offer surface (§6.1). An
  operation is created only by an explicit start (the one human click, or a future policy).
- **Single-flight (P6):** `updates.start` refuses while an exclusive operation is active
  (`ALREADY_RUNNING` with the active operation id — the second tab simply renders the same
  operation). A target published mid-update is stored as `nextTarget` and surfaces only
  after the operation terminates. Mid-update target mutation of the wave (today's
  `setTarget` re-publish behavior) is removed.
- **Cancel** is allowed while every started step is still reversible (preparing, machine wave
  not yet granted / individual machines finish their in-flight grant). From the server swap
  onward the operation cannot be canceled, only fail forward — the panel says so.
- **Retry** on a failed operation creates a *new* operation whose plan is the remainder
  (places not yet at target), linked via `retryOf`. History stays honest.

### 3.3 The engine

The generic engine owns transitions:

- **Timer-driven, not poll-driven.** Step deadlines and heartbeat staleness fire from a
  timer, independent of anyone polling (fixes the fleet()-ages-grants design). Deadlines are
  per step kind (download vs restart vs build), configured in one table.
- **Idempotent steps.** Each step has an `ensure()` semantics: it checks observable reality
  first (is the served web dist already at the target digest? is machine X already reporting
  the target?) and only acts on the delta. This is what makes adoption (§3.4) and retry safe.
- **Existing machinery is the muscle.** The wave planner (`wave.ts`), grant protocol,
  delivery/verification (`update-delivery*.ts`), dev publisher, and daemon swap/rollback all
  stay. The engine replaces only the choreography currently spread across
  `startUpdate`/`continueDevelopmentUpdate`/`restartCoordinatorAfterDevelopmentFleet` and the
  client-side wait loops.
- **Progress heartbeats.** The `updateStatus` frame gains an optional `percent` and daemons
  report download progress every few seconds (additive protocol change). The engine stamps
  `lastProgressAt` on every accepted report. A step whose heartbeat goes stale shows
  "no progress for N s" (UI) and, past its deadline, transitions to a visible `stalled`
  sub-state → one automatic retry → `failed` (P4). Stalled-then-recovered is logged into the
  operation, not lost.

### 3.4 Surviving the coordinator restart (P3)

The server updating itself is a *step of the operation*, not the end of the world:

1. Before requesting its own restart, the engine marks step `server` as
   `running / restarting` and persists.
2. The successor server, on boot, loads the active operation and **reconciles against
   reality**: its own `appVersion` equals the target → step `server` is `done`; the served
   web dist stamp matches → `web` is `done`; the machine directory says who is where. Memory
   is never trusted over facts.
3. The engine resumes remaining steps (typically: finish the machine wave for late
   reconnecters, then `waiting` on surface reloads).
4. If the successor boots at the *wrong* version (failed swap, rollback), reconciliation
   marks the operation `failed` with `server-did-not-reach-target` — today this case
   silently produces a fresh dialog.

Clients experience one continuous process: the page reloads (its own local step), re-fetches
the active operation, finds the same operation id at a later step, and keeps rendering the
same panel. No second dialog, no second decision.

### 3.5 Surface-local actions (`awaiting`)

The operation's shared steps end at "the new build is being served". What remains is
per-surface:

- Each client computes exactly one local fact: *my running build vs the operation's target*
  (via the existing build stamp). If behind, the panel shows its own ask: **Reload**
  (browser / webview) or **Restart Podium** (desktop shell, §5).
- `awaiting` lists surface-scoped asks the *server* knows about (e.g. all-in-one: "waiting
  for Podium Desktop on `macbook` to install and restart"). Other clients render these
  honestly but cannot act on them (P5) — a browser sees "waiting for the desktop app", never
  a button that restarts someone else's app.
- An operation in `waiting` with only voluntary asks left (e.g. other idle tabs that haven't
  reloaded) **completes** after a short grace; stragglers self-serve via the version guard on
  their next load. `waiting` only holds the operation open for asks that gate correctness
  (the all-in-one install).

### 3.6 Core vs eventual places

An update must be finishable even when part of the fleet is asleep (laptop closed, VPS down):

- **Core places** gate the outcome: the server, the served web/mobile bundles, and machines
  currently connected.
- **Eventual places** — machines offline at start time — go to `deferred`, and the operation
  can reach `done` with an honest note: "2 machines will update when they reconnect."
- A **standing reconciliation** (small, always-on) converges any daemon that reconnects
  behind the current target — the same grant path, one machine at a time, no operation
  needed. This replaces today's behavior where an offline machine either hangs the wave into
  the poll-aged 10-minute timeout or needs a manual per-row Apply later.

### 3.7 Operation history

Operations are retained (last 20) and listed in Settings → Updates: target, when, outcome,
error, duration. This is the audit trail that today does not exist — "did the update finish
last night?" becomes answerable. It also feeds support: "share the last failed update"
replaces screenshots of toasts.

## 4. Surfaces: who sees what, who may do what

The same operation renders everywhere; only the *local action* and some copy differ.

| Surface | What the offer means | Local action | Never |
|---|---|---|---|
| **Browser → normal server** | Update the server + its fleet + served bundles | Reload when asked | Touch any native desktop app |
| **Browser → all-in-one server** | The server lives inside Podium Desktop on that machine | None — panel says "finish this in Podium Desktop on `<machine>`" | Remote-restart the app |
| **Desktop shell, all-in-one** | One update: the shell (which carries server + daemon + web atomically) | Restart the app (Tauri install) | Bundle-swap inside the signed app |
| **Desktop shell, remote mode** | Two independently updatable things, sequenced in one panel: (1) the remote server's update, (2) this app's shell update | Reload (for the server update); Restart the app (for the shell) | Conflate the two versions |
| **Mobile web** (deferred) | Same as browser | Reload | — |
| **CLI** (deferred) | `podium update` stays the unattached escape hatch | — | Race an attached server's operations |

Decisions this table encodes:

- **"Update this app" inside the Tauri shell updates the shell** when the shell has an
  update. In all-in-one that *is* the update — one click, one restart, atomically carrying
  server + daemon + web. In remote mode the shell update is its own clearly-labeled item in
  the same panel ("This app has its own update"), offered after (or independent of) the
  server update; a server update never silently forces a shell update unless the wire window
  requires it, in which case the panel sequences them and says why.
- **A browser prompt never updates a native desktop app** — not its shell, not its embedded
  daemon. A *desktop-supervised* daemon is part of the signed app bundle and is updated only
  by the shell update; it must be excluded from convergence waves (today it is not — tracked
  as a sub-issue, §10.3). A *standalone-installed* local daemon on the same machine as the
  native app is just a fleet machine: server authority, updated by the wave, regardless of
  which surface clicked.
- **All-in-one viewed from a browser** cannot be driven remotely in v1; the operation is
  created in `waiting` with the desktop ask, and the browser renders honest state.

## 5. The desktop shell's role

- The shell update becomes an **operation step / companion item** driven from the page over
  the existing bridge (`checkUpdate` / `installUpdate`), with two fixes: `installUpdate`
  reports progress (the Tauri callbacks currently discarded at `updater.rs:196`) via a
  bridge event the panel renders, and its errors surface in the panel (today they vanish
  into an unhandled rejection).
- **All-in-one flow:** the embedded server creates the operation (state `waiting`, awaiting
  `desktop-install`), the page invokes `installUpdate`, the shell installs and restarts, the
  *new* embedded server adopts the operation (§3.4), marks the shell/server/web steps done
  from observed reality, then converges fleet machines as eventual places. One model, no
  special case.
- **The native fallback gets a decision** instead of dead code: the ownership-claim
  machinery stays, but the unclaimed path shows a real minimal native dialog (check →
  install → restart) rather than today's log line behind `PODIUM_UPDATE_AUTOCONFIRM`. A
  shell whose webview cannot load must still be updatable.
- **Channel is resolved in exactly one place** (the server the shell is attached to; the
  shell's own config only for a shell with no server), fixing the current disagreement
  between `check_update` (page-supplied) and `install_update`'s re-check (shell config).

## 6. UX specification

### 6.1 One panel, one indicator, no dead ends

- **Status-bar indicator (new).** A persistent affordance in the bottom toolbar whenever an
  offer is pending or an operation is active/failed: idle dot ("update available"), animated
  while running, warning on failed/stalled. Clicking toggles the panel. **Hiding the panel
  only collapses it to the indicator** — nothing about an update is ever unreachable (fixes
  dismiss-forever, and the in-progress panel that never comes back).
- **One non-modal panel** (the existing bottom-right `aside` position is right). All states
  render into it; it never turns into a toast, a banner, or a second dialog.
- **One dismiss verb.** "Hide" everywhere (today: Later / Hide / Dismiss / OK for the same
  action). Hide never discards state; it collapses to the indicator.
- **One primary action per state.** Today up to three same-weight primaries can render at
  once. The panel computes the single recommended action for this surface and renders it as
  the primary; anything else (e.g. the shell's independent update in remote mode) is a listed
  secondary item with its own row, not a competing primary.
- The wire-skew banner remains as the last-resort backstop but its remedy is unified: it
  opens the panel (the operation/offer view), instead of prescribing a different button than
  the panel does.

### 6.2 The linear flow the user sees

One update, one panel, states in order — never a second round:

1. **Offer.** "Podium 0.4.3 is available", places listed with what they'll notice (the
   existing place-language copy is good and stays), "What's new" when notes exist. Primary:
   **Update Podium**. Secondary: Hide.
2. **Running.** The step checklist, live: done steps checked, current step with substatus
   ("Updating your machines — 1 of 3 · vmi3407763 downloading 62%"), pending steps dimmed.
   Elapsed time on the current step; "no progress for Ns" appears when the heartbeat goes
   stale — progress is visibly alive or visibly stuck, never ambiguous (P4).
3. **Your turn.** When the shared steps are done and this surface is behind: primary
   **Reload** (or **Restart Podium** in the shell). The panel says exactly what will happen
   ("reloads this page, about 2 seconds; your sessions keep running"). Reloads are steps the
   user takes, not things that happen to them; the silent version-guard hard-reload budget
   remains only as the corruption backstop, and when it fires the post-reload panel explains
   what happened.
4. **Done.** "Podium is on 0.4.3 everywhere" (or "…2 machines will follow when they
   reconnect"). Auto-collapses after a few seconds; the indicator clears; the operation
   lands in history.
5. **Failed.** §7. Primary: **Try again** (a remainder operation); the failure is never a
   dead end and never a toast that evaporates.

The step counter is honest because steps are the plan's named steps, not synthesized counts:
the user sees *what* step 2 of 4 is, and each step names its substatus.

### 6.3 Copy rules

Kept from POD-1670 §12.3 (places not components; say what the user will notice; "no restart
needed" said explicitly; never promise more than session-survival guarantees) plus:

- Every in-progress line names its liveness ("downloading 62%", "restarting…", "no progress
  for 40 s") — a bar that cannot say whether it is moving is banned.
- Every terminal state names the version it ended at, per place, on request (expandable).
- Never show an internal precondition as an error. "No update target is configured" becomes
  unreachable from the panel: the offer only renders when a startable target exists; the
  Settings page explains channel state in prose ("Nothing published on `stable` yet").

## 7. Error taxonomy (P7)

Typed codes on the operation, each mapped to three layers — what happened / the one next
action / collapsed technical detail (copyable, includes the operation id):

| Code | User sees (example) |
|---|---|
| `machine-dirty-checkout` | "`vmi` has local edits that prevent a safe update. Commit or stash them there, then try again." |
| `machine-unsupported` | "`macbook` can't use this update's package. Check the release includes its platform." |
| `machine-unreachable` | "`vmi` stopped responding while updating. Check it's running; it will resume when it reconnects." |
| `download-failed` | "The update couldn't be downloaded. Check the server's connection, then try again." |
| `server-did-not-reach-target` | "The server restarted but came back on 0.4.2. Nothing else was changed. Try again or check the server log." |
| `web-build-failed` | "The app rebuild failed on the server. Machines that already updated stay updated. Try again." |
| `stalled` | "No progress for 5 minutes while <step>. Podium retried once. Try again, or cancel." |
| `preparation-failed` | "The server couldn't prepare this update: <public reason from the dev publisher>." |

The existing `describeUpdateFailure` copy is close in spirit and is largely reusable; the
change is that errors attach to a durable operation (retryable, inspectable in history)
instead of to a transient panel state.

## 8. Hard cases, walked through

| Case | How the design handles it |
|---|---|
| Server restarts mid-update (by design) | Operation persisted; successor adopts and reconciles from observed reality (§3.4). |
| Client reloads mid-update | Re-fetch the active operation by id; same panel, later step. Reloading is itself a planned step. |
| The web bundle rendering the UI is replaced mid-update | Frozen operation contract (P8): the old bundle renders the new server's operation; the guard reload is one planned step, not a loop. |
| A new version lands mid-update | Stored as `nextTarget`; offered only after the operation terminates. The running wave is never mutated. |
| Two tabs / two users click Update | Single-flight; the second start returns the active operation; both tabs render it. |
| A machine is offline during the wave | Becomes `deferred`; the operation completes honestly; standing reconciliation converges it on reconnect (§3.6). |
| Update fails half-applied (server new, machines old) | Operation `failed` records exactly which places moved; wire window keeps the mixed fleet functional; Retry runs the remainder. |
| Server comes back on the wrong version | Reconciliation detects it (`server-did-not-reach-target`) instead of silently re-offering. |
| Download hangs with no error | Heartbeat staleness visible in UI; step deadline on a timer → stalled → one retry → typed failure. Never an indefinite spinner. |
| Browser user vs someone's native app | Surfaces only act locally (P5); desktop-supervised daemons are shell-owned and excluded from waves. |
| All-in-one: who updates the server inside the app? | The shell does, as the operation's awaited step; the new embedded server adopts and finishes the operation (§5). |
| Hidden dialog | Collapse-to-indicator; state is server-side; nothing is lost (§6.1). |
| Update offered while viewing through an old bundle | Offer and operation are served state, not build state — an old bundle can still start and render an operation. |
| Cancel mid-update | Allowed until the first irreversible step; afterwards the panel says "can't be canceled now, will finish or fail". |
| Fleet on mixed channels | The plan is computed per channel authority (unchanged); the panel scopes places to the operation's channel and never counts other-channel machines against it. |

## 9. Decisions (formerly open questions)

Adopted 2026-08-14 with the epic's approval:

1. **Straggler auto-convergence: yes.** §3.6 converges reconnecting machines to the current
   target without a click — the human decision was made when the operation started.
2. **Background target refresh:** daily timer + on-panel-open + manual check, with the
   checked-at time shown in Settings ("checked 2 h ago"). The cadence is part of the
   contract and shown, not implied.
3. **Remote-triggering an all-in-one update from a browser:** not in v1; the panel says
   "finish this in Podium Desktop on `<machine>`".
4. **Native fallback:** keep, minimal — a real native check/install dialog when the page
   never claims ownership; delete the autoconfirm-gated stub.
5. **Required updates:** blocking only for wire-window violations and explicitly-flagged
   critical releases. Desktop `critical` is currently never produced by any release script —
   wire it in the desktop manifest or keep the field dormant; do not invent new blocking.
6. **History retention: 20 operations**, server-side query (no client sync).
7. **Windows desktop** stays future; the surface table treats it as such.

## 10. Today vs this design

### 10.1 What is kept (and why)

Authority vs delivery split; signed feed/bundle/git deliveries with fail-closed verification;
converge-to-target equality (downgrades work); the wave planner (canary/soak/widen); the
daemon's pending-marker + boot reconciliation + `.old` rollback; the dev publisher (identity
gate, debounced lock-guarded builds, retention); per-server signing key pinned at pairing;
the wire window and `/version`'s frozen contract; place-language copy. All of this is good
engineering and none of it is the problem.

### 10.2 What changes

| Aspect | Today | Update operations |
|---|---|---|
| Update identity | Emergent from 4 polled facts | One durable operation object (P1) |
| Orchestration state | In-memory, lost on the restart the flow itself triggers | Persisted, adopted, reconciled from reality (P3) |
| Progress | 3 competing computations; counts jump | Server-computed, one source (P2) |
| Liveness | Indistinguishable from a hang; deadlines age on poll | Heartbeats + timer deadlines + visible `stalled` (P4) |
| Dismissing | Loses the update (forever, for a PWA) | Collapses to a persistent toolbar indicator |
| Flow | Multiple rounds: dialog → reloads → guard reloads → second dialog | One linear checklist; reloads are named steps; adoption bridges the restart |
| Concurrency | Unguarded; mid-update target mutates the wave | Single-flight; `nextTarget` queued (P6) |
| Errors | Internals leak ("No update target is configured"); shell errors vanish | Typed taxonomy, 3 layers, attached to a retryable operation (P7) |
| Completion | None — the panel just stops appearing | Terminal state + history ("did last night's update finish?") |
| Offline machines | Hang the wave into a poll-aged timeout, or manual per-row Apply | `deferred` + standing reconciliation |
| Desktop-supervised daemon | Included in waves (would rewrite the signed .app) | Shell-owned, excluded — structural, not a patch |
| Buttons | Up to 3 co-equal primaries; 4 labels for "hide" | One primary per state; one Hide |

Why this is better in one sentence: every symptom in the brief — unclear copy, unknowable
progress, dismiss-forever, multi-round dialogs, no start/finish, no single-flight, hostile
errors — is a downstream consequence of the update having no durable identity, and the
operation gives it one; the UX fixes then stop being patches and become renderings of true
state.

### 10.3 Defects found during the survey

These ship regardless of this spec and are tracked as sub-issues of the epic:
desktop-supervised daemons not excluded from convergence waves; `writePendingGrant`'s
non-atomic write immediately before a deliberate exit; `isNewer`'s NaN comparison on
prerelease versions in unattached self-update; shell `installUpdate` rejections disappearing
(no catch); the `'dev'` vs `'stable'` default-channel disagreement between
`UpdatesService.channelOf` and the fleet handlers; edge/stable targets never refreshing
after boot.

## 11. Getting there

The epic decomposition (sub-issues of POD-2087, each with its own committed implementation
plan under `docs/internal/superpowers/plans/`):

- **Durable operations framework** — the generic layer of §3.0. No update logic.
- **Update operation choreography** — the `update` kind: plan, steps, adoption, queueing,
  typed errors.
- **Daemon update hardening** — supervised-daemon exclusion, atomic pending marker,
  prerelease-safe version compare. Independent; can land first.
- **Channel defaults and target refresh** — one default channel, scheduled + on-demand
  release-target refresh. Independent; can land first.
- **Update progress heartbeats** — `percent` reporting, timer deadlines, `stalled`.
- **Update operation panel** — the renderer, indicator, collapse-not-dismiss, one primary.
- **Settings updates surface** — history, channel state prose, checked-at.
- **Desktop shell update integration** — bridge progress/errors, all-in-one adoption,
  channel authority, native fallback.
- **Deferred places reconciliation** — core vs eventual, standing reconciliation.
- **Updater dead-path cleanup** — autoconfirm stub, `feed_endpoint`, duplicated
  `verifyTarball`, skew-banner remedy unification.

Sequencing rationale: the framework before the choreography before the renderer, so the UI
never renders a contract that can still change; liveness after the choreography; desktop
after the panel; cleanup last. The two hardening issues are independent and land first.

Verification rides the existing regimen (`docs/agents/updater-acceptance.md`), extended with:
operation adoption across a coordinator restart (kill mid-wave, verify resume), the
frozen-contract conformance test for the active operation, single-flight under two concurrent
starts, and a stalled-download drill (throttled feed) proving the timer fires without a poll.
