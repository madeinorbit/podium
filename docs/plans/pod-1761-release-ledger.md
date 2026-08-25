# POD-1761 release ledger — every capability, one milestone, one action

*Written 2026-08-25. This is the coordinator's execution sheet. It sorts every
row of `docs/architecture/driver-capability-catalog.md` into exactly one
milestone (from `docs/plans/pod-1761-release-milestones.md`) with exactly one
action, and defines tonight's runbook and its scorecard.*

## The action vocabulary

| action | meaning | tonight's cost |
|---|---|---|
| **confident** | proven live, or pinned by a test that bites (mutation-checked). No work beyond keeping gates green. | zero |
| **check** | code exists; nobody has watched it work on the tip. One live drive step, result written down. | minutes each |
| **land** | a fix exists on a review-stage issue branch. Merge under lock with its verdict, then drive it. | the review queue |
| **implement** | does not exist and its milestone needs it. | not tonight unless listed |
| **defer(Mx)** | scheduled for milestone x; explicitly not v1's problem. | zero |

Status correction feeding this ledger: of the ten v1 blockers named in the
milestones doc, **seven are already fixed on review-stage branches** (POD-2470,
POD-2116, POD-2761, POD-2602, POD-2775, POD-2298, and POD-2604 which is blocked
on a dependency), and only four are open work (POD-2772, POD-2631, POD-2692,
POD-2691) plus POD-2432 (restart-safe inventory).

---

## Tonight's runbook (M0 + M1 candidate)

Ordered. Each step has a measurable exit; do not start a step before the
previous one's exit is true.

**Step 1 — land the review queue.** For each of POD-2470, POD-2116, POD-2761,
POD-2602, POD-2775, POD-2298: confirm its reviewer verdict is a pass (request
the review if none exists), then ff-only merge to `issue/1761-agent-runtime`
under `podium merge-lock`. POD-2604 first needs its blocker cleared or the
dependency waived. *Exit: all six merged; `git log` shows them on the tip.*

**Step 2 — gates green, and meaningful.** Run on the tip, stating whether
`PODIUM_TEST_WORKERS` was set (it changes the outcome):
`bun scripts/typecheck.ts` (25/25), `bun scripts/test.ts` (full suite, under
the `test:heavy` lock, short-disk TMPDIR), `bun run lint:boundaries` (baseline
is 6 known lines — zero NEW). Stale-golden and gate bugs that block this step:
POD-2714, POD-2759, POD-2778, POD-2728, POD-2040, POD-2031. *Exit: all three
commands green, or every red attributed to a filed issue that is provably
pre-existing on main.*

**Step 3 — repin the operator instance** (`/tmp/pod-op`, port 19797) to the
tip and **verify the pin** (a drive proves nothing on an older commit —
check the running commit, not the deploy log). *Exit: instance reports the
tip's commit.*

**Step 4 — the Tier-A drive matrix.** The scorecard below, driven by hand or
script on the instance. Save a screenshot or transcript per cell and attach the
set to this issue. *Exit: zero failing cells.*

**Step 5 — triage the four open blockers.** Fix tonight or waive in writing:
- POD-2772 (login gate silently demotes server drivers to the terminal path)
  — **must fix**: it defeats the point of the release; sessions would quietly
  not be on the new drivers. Verify after: a logged-in opencode/codex/grok
  session reports `driverFamily: server`.
- POD-2691 (dead servers accumulate) — fix or waive with a documented manual
  reap and a cap; the drive matrix row A9 decides.
- POD-2631 (failed install probe cached as "not installed") — waivable
  tonight with the documented recovery (daemon restart) IF the drive matrix
  never hits it; fix is small (don't cache a timeout as absence).
- POD-2692 (login readout reads the operator's home, not the instance's) —
  waivable if tonight's release doesn't target named instances; otherwise fix.
- POD-2432 (sessions listable after daemon restart) — the A7 row of the
  matrix decides: if kill-daemon → restart → session resumes cleanly on all
  three drivers, tonight's bar is met without the full inventory work.

**Step 6 — release.** Merge the epic branch to main under merge-lock, tag,
release notes name: what flipped (three server drivers), the escape hatch
(`PODIUM_RUNTIME_DRIVER=generic-pty`), and the written waivers from step 5.
*Exit: main is the tip; instance repinned to main; matrix re-run spot-check
(A1, A7) passes.*

## The scorecard — Tier A drive matrix

One cell = one live drive on the operator instance. Pass criteria are exact;
a cell without its criterion met is a FAIL, not a shrug. Claude and shell
columns prove the untouched paths stayed untouched.

| # | drive | claude | codex | grok | opencode | shell | pass criterion |
|---|---|---|---|---|---|---|---|
| A1a | send while idle | ☐ | ☐ | ☐ | ☐ | ☐ | reply arrives; bubble goes `sent`, never silent-settles |
| A1b | send while busy | ☐ | ☐ | ☐ | ☐ | n/a | shows `queued` with position; survives page reload; delivered when idle |
| A1c | send to a dead session | ☐ | ☐ | ☐ | ☐ | ☐ | typed refusal or resume-and-send offered; never a lost message |
| A2a | status while working | ☐ | ☐ | ☐ | ☐ | n/a | badge `working` within 2s of turn start, `idle` after end; no flicker-idle mid-turn |
| A2b | status at boot | ☐ | ☐ | ☐ | ☐ | ☐ | a fresh idle session shows idle, not `working` or blank |
| A3 | interrupt mid-turn | ☐ | ☐ | ☐ | ☐ | n/a | turn stops; transcript shows interrupt; refused interrupt says why |
| A4a | permission ask | ☐ | ☐ | ☐ | ☐ | n/a | card appears in chat AND terminal shows the same ask; answering resolves both |
| A4b | answer twice | ☐ | ☐ | ☐ | ☐ | n/a | second answer is a typed error, not a double action |
| A5 | transcript | ☐ | ☐ | ☐ | ☐ | n/a | turns render with tool calls paired to results; reload shows same history |
| A6a | terminal attach + type | ☐ | ☐ | ☐ | ☐ | ☐ | keystrokes echo; resize refits; second viewer sees the same screen |
| A6b | chat↔CLI switch | ☐ | ☐ | ☐ | ☐ | n/a | switch and back: no restart, no scrollback corruption, correct size (POD-2761/2602 fixed) |
| A7a | daemon restart | ☐ | ☐ | ☐ | ☐ | ☐ | session survives or auto-resumes as the SAME conversation (asks it to recall a codeword from before) |
| A7b | hibernate + wake | ☐ | ☐ | ☐ | ☐ | n/a | wakes with context intact; never wedges (POD-2775 fixed) |
| A8 | logged-out spawn | ☐ | ☐ | ☐ | ☐ | n/a | gets a working login path; after login, next session lands on the server driver (POD-2772 fixed) |
| A9 | kill session | ☐ | ☐ | ☐ | ☐ | ☐ | process tree gone (check the process table, not the UI); no orphan servers after 5 min |
| A10 | driver identity | n/a | ☐ | ☐ | ☐ | n/a | session reports server family; `PODIUM_RUNTIME_DRIVER=generic-pty` demotes it (escape hatch works) |

Plus two Tier-B not-worse spot-checks (no pass bar beyond "today's behavior"):
provoke a provider error (should at least match today's wording; grok's names
the quota reason since POD-2604), and confirm an OOM-killed session is not
shown as finished.

**Release rule: zero Tier-A fails. A Tier-A fail either gets fixed tonight or
the release does not happen. There is no waiver row in the matrix.**

---

## The full ledger — every catalogue row

Grouped by catalogue section. "Measured by" is the gate that keeps it true.

### §1 Turn lifecycle → all M1

| row | action | measured by |
|---|---|---|
| send opens turn, reports delivery | confident | conformance suite + A1a |
| queue with durable position | confident | suite + A1b |
| steer into running turn | confident | suite |
| steer downgrade reported | confident | suite |
| never undeclared delivery | confident | suite |
| unverified only where permitted | confident | suite |
| interrupt | **check** | A3, all four columns |
| stop-turn distinct from interrupt | defer(M4) | — |
| send-on-stop | defer(M4) | — |
| turn id carried, never minted | **check** | POD-2497 closes it; A1b reload leg |
| queue abandonment | confident | per-driver tests |
| principal survives the queue | **check** | code-read + one steward-send drive |
| per-turn override stays one turn | defer(M4) | — (model switching is Tier C) |
| origin rides turn/started | check → M2 | attribution pane spot-check |
| verdict from provider | **check** grok/opencode | A2a idle-badge honesty |
| failure typed + disposition | confident | driver tests |
| failure detail verbatim | confident | driver tests + Tier-B error spot-check |
| graceful stop drains queue | **check** | A9 with a queued message pending |

### §2 Streaming → M3, except the correctness substrate

| row | action | measured by |
|---|---|---|
| cursors monotonic across rebind; causal fencing; provenance/generation; cursor material declared | confident (M1) | suite — these underpin the transcript, not streaming |
| fine-watch rows (stream when declared, silent when coarse, join key, epoch stamp, stop on release, live-only) | confident, defer(M3) for live proof | suite now; POD-2773 drives grok/opencode in M3 |
| first turn a viewer joins streams | check (M3) | proven codex; POD-2773 |
| in-progress tool previews (`partial`) | implement grok/opencode if needed (M3) | codex pinned |
| watch filtered per viewer count | check (M3) | codex pinned |

### §3 Interactions → M1 core, M2 tail

| row | action | measured by |
|---|---|---|
| asked→answered, enumerable, in state(), twice=error, unknown refused, any phase, at-least-once bounds, typed payloads, decision-arm honesty | confident (M1) | suite + driver tests + A4 |
| login ask | **check** (M1) | A8 |
| permission ask | **check** (M1) | A4a |
| keystroke-emulated refusal leaves ask open | **check** (M1) | claude column of A4a with an unanswerable menu |
| recovery auto-answers full resume | **check** (M1) | A7a on a driver that prompts at resume |
| plan-approval / elicitation / recovery payload producers | check (M2) | thin today; POD-2414 line |
| expiry + escalation deadline | implement (M2) | no worker exists |
| answeredBy reported | check (M2) | attribution pane |

### §4 Lifecycle → M1 core, M4 portability

| row | action | measured by |
|---|---|---|
| resume/adopt/snapshot/hibernate/export family (9 rows) | confident (M1) | proven + suite; A7a/A7b re-prove live |
| import | implement (M4) | POD-2415 |
| byteFaithful/formatVersion, relative paths, not-yet vs never | confident, matter in M4 | suite |
| durability declared per driver | implement (M2) | the A7a behavior itself is M1 (POD-2432 or clean auto-resume); the *declaration* mechanism is M2 |
| forking, rewind | defer(M4) | — |

### §5 Attachments → all M1

| row | action | measured by |
|---|---|---|
| staging ref/refusal, enforced declaration, foreign ref, undeclared kind | confident | suite |
| promptForm — the image actually reaches the model | **check** | drive: paste an image on each driver, ask the agent what it shows |
| realpath containment | **check** | one adversarial path test |
| TTL/GC, dies with session | confident | legacy, unchanged |
| typed refusal rendered | **check** | grok refusal drive (evidence exists; re-run on tip) |

### §6 Errors and truth → M1 truth, M2 quality

| row | action | measured by |
|---|---|---|
| typed refusals, structural markers, permanent-vs-not-yet, version gates, health/OOM counters, failure vocabulary | confident (M1) | suite + POD-2413 tests |
| provider errors NAMED in chat | land (M2, or tonight if POD-2604 unblocks) | Tier-B spot-check |
| quota vocabulary arm | implement (M2) | — |
| needs-human materializes as interaction | land + check (M2) | POD-2414 is in review with a third pass requested |
| not logged in | **check** (M1) | A8 + POD-2772/2631/2692 triage |
| OOM rendered red | **check** (M1) | Tier-B spot-check |
| credential hygiene | **check** grok/opencode (M1) | verify strip on a live server-driver spawn (codex proven) |
| refused never stays "delivered" | land (M1) | POD-2298 in review; A1c |
| timeout reports failure | **check** grok/opencode (M1) | forced-timeout drive |

### §7 Configuration → M1 spawn facts, M4 mutability

| row | action | measured by |
|---|---|---|
| workdir/env/initialPrompt honoured | confident (M1) | every spawn exercises it |
| model/effort observed with provenance | **check** (M1) | A2 panel readout |
| title/accent | **check** (M1) | sidebar shows a real title per driver |
| sticky configure (model/effort/permission), per-turn overrides, subagent model, MCP forwarding, instruction re-prime | defer — M4 (re-prime M2) | catalogue keeps them |
| usage per turn surfaced | defer(M4) | B5 |

### §8 State readout → M1 what the badge needs, rest deferred

| row | action | measured by |
|---|---|---|
| working/idle, compacting, boot seeding, observation gap, lastActivityAt, open todos, blocked-on-human | **check** (M1, one drive: A2a+A2b) | drive |
| errored as a state | implement (M2) | POD-2693 |
| subagent count via contract | defer(M4) | legacy path keeps the UI chip alive in v1 |
| waiting-on cron/event/subagent | defer(M4) | — |
| context percent displayed | defer(M4) | — |

### §9 Attach and leases → M1

| row | action | measured by |
|---|---|---|
| lease/spectator/refusal/reserve/drain/peek family (9 rows) | confident | suite + A6a |
| cold start no fake continuity | land | POD-2761 in review; A6b |
| endpoint security | confident | opencode pinned; codex 0600 posture pinned |
| park/reconnect, retention policy, parkable declaration | implement (M2) | B8 |
| draft read/write | check (M2) | B6 |

### §10–11 Ownership + runtime primitives → M1 minimum, M4 the rest

| row | action | measured by |
|---|---|---|
| dedicated placement, exit-is-master's-exit, selection pure/total, create-with-id, tier boundary | confident (M1) | suite |
| kill leaves no corpses | land/fix (M1) | POD-2691 + A9 |
| typed stop outcomes, positive-evidence kill, exact identity, attribution, one authority | defer(M4) | process-ownership plan |
| list/inventory/quota/usage/accounts/login/import primitives | defer(M4) | legacy probers carry v1 |

### §12 Legacy loss budget → M1 = "unchanged", six explicit checks

Everything in catalogue §12 ships in v1 **on its existing path, unchanged** —
confident by virtue of not being touched — EXCEPT six rows where the new
drivers bypass the old path and parity must be checked once:

1. server-driver child env: instance HOME + credential strip applied (`serverChildEnv`) — check.
2. mail reaches a session on each driver (grok ACP hooks fire; opencode has no hooks — confirm parity with today's opencode, which also had none) — check.
3. prime injection still primes server-driver sessions — check.
4. browser-shim login capture works when a server-driver session needs login — check (part of A8).
5. uploads GC still covers server-driver staging dirs — check.
6. boot/idle seeding parity on server drivers (A2b) — check.

### §13 Client demands → folded into the matrix

`disposition`, echo reconciliation, `driverFamily`, `outputSeen`, OOM stop
reason, transcript cursor semantics — all exercised by matrix rows A1, A2, A6,
A9, A10. Thinking/todos/plan-body surfaces: defer(M4), recorded decisions.

---

## Tally

- **confident:** ~60 rows — the conformance corpus and driver tests carry them; gates green is the only maintenance.
- **check tonight:** ~25 drive cells, almost all folded into the 16-row matrix plus the six §12 parity checks.
- **land tonight:** 6 review branches + 1 blocked (POD-2604).
- **fix tonight:** POD-2772 (mandatory), POD-2691 (or waive with reap procedure), POD-2631/2692 (waivable with written recovery).
- **implement:** nothing for v1. Everything marked implement is M2+.

That is the whole release: land seven branches, run three gate commands, drive
one matrix, make four written triage calls. Every later milestone consumes its
rows from this ledger the same way.
