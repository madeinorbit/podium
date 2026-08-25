# POD-1761 release milestones

*How the runtime epic gets over the finish line: small releasable chunks, each with
a real user benefit, none waiting for the catalogue to be fully proven.*

Written 2026-08-25. Companion to `docs/architecture/driver-capability-catalog.md`
(the full capability inventory) and `docs/plans/pod-1761-agent-runtime-plan.md`
(the original W-item plan). The catalogue is the map; this document is the route.
The catalogue stays the long-term ledger — milestones consume rows from it, they do
not replace it.

## Principles

1. **Every milestone is a release.** It merges to main, the operator instance is
   repinned, and its checklist is driven live before the milestone closes. No
   milestone depends on a later one to be safe.
2. **The bar is relative, not absolute.** A flipped harness must be *better than
   its headed driver* on a short measurable checklist — not feature-complete
   against the catalogue. Harnesses left on headed drivers must be *provably
   unchanged* (driven, not assumed).
3. **Old paths stay until a milestone explicitly retires them.** Retirement is its
   own milestone with its own ledger, never a rider on a feature.
4. **One harness at a time.** The selection function is a one-line, per-harness,
   instantly revertible knob (`select:` in the manifest; `PODIUM_RUNTIME_DRIVER`
   as the machine-level escape hatch). Flipping three at once triples the blast
   radius for zero extra benefit.
5. **Stability is a user benefit.** A milestone made entirely of bug fixes is a
   legitimate release.

## The key fact this plan exploits

On the current tip, **all three server drivers are already the default** for a
logged-in, version-admitted harness (`manifests/{codex,grok,opencode}.ts
select()`). The epic branch as it stands would release codex + grok + opencode
simultaneously. Milestone 0 therefore *narrows* the tip to one harness rather than
building anything new — the fastest possible route to "something out".

---

## M0 — A releasable tip (stability only, no behaviour change)

**User benefit:** the product on the epic branch works again; "green means green".

**Content**
- Fix the hard release blockers on the tip: web UI dead (POD-2470), stale wire
  goldens (POD-2714, POD-2035), the gates that cannot be trusted (POD-2759
  typecheck blind to tests/e2e, POD-2778 typecheck exhausts the machine, POD-2728
  `test` runs four files), baseline reds beyond the epic (POD-2040).
- **Stage the flip:** pin codex and grok `select()` back to `['generic-pty']`
  (logged-in included), leaving exactly one harness — M1's — on its server
  driver. Two one-line manifest edits, each trivially revertible.
- Document the escape hatch (`PODIUM_RUNTIME_DRIVER=generic-pty`) in the release
  notes so any machine can opt out without a build.

**Exit test:** all gates green; instance repinned to the tip; one turn driven
end-to-end on every family (claude, shell, and the three staged harnesses on
whatever driver M0 leaves them).

**Explicitly not in M0:** any new capability. This is the shortest path to a
mergeable branch.

---

## M1 — First harness flipped: opencode, "better than headed"

**User benefit:** opencode sessions stop lying. Typed receipts instead of
fire-and-hope, provider errors named in chat, sessions that survive both a daemon
restart and their own server's death.

**Why opencode first.** It is the only server driver that is a durable workload —
it survives a daemon restart, which is the one thing the headed (abduco) path
already guaranteed. Codex and grok run as daemon children on the new path, so
flipping them before auto-resume-on-restart exists would *regress* restart
behaviour relative to headed — disqualifying under principle 2. Opencode also has
the no-exemptions conformance run (W5's bar) and the pinned per-session-secret
story. Grok would give a bigger delta; opencode gives zero regression risk. Swap
is cheap if evidence says otherwise.

**The release checklist** (the whole bar — driven live on the operator instance;
this is POD-2777's scope for this milestone):
1. A send gets a truthful receipt: delivered or queued, never silently discarded
   (the POD-2116 class), and a queued row survives reload with its position.
2. Interrupt from chat stops the turn.
3. A permission ask surfaces as an answerable card in chat; answering twice is a
   typed error; the terminal shows the same ask.
4. A provider failure is named in chat (the POD-2604 class), with retry/resume
   offered where retryable.
5. Kill the daemon → the session survives and re-adopts. Kill the opencode server
   process → resume continues the same conversation.
6. An OOM kill renders red as OOM, never as "finished".
7. Input sent during a human take-over queues and drains on release.

**The parity legs** (equal weight with the checklist):
- Claude and shell journeys driven unchanged (they never leave the terminal path
  — the permanent tier, not a deprecation).
- Codex and grok driven on their pinned PTY path: no regression from the staging
  edits.
- Flag-off suites zero-diff.

**Explicitly not in M1:** streaming in chat, native-view polish beyond today's
behaviour, import/handoff, machine-runtime verbs, any legacy retirement.

---

## M2 — Grok flipped (fast follow, same shape)

**User benefit:** the biggest single delta in the fleet. Headed grok today is a
700 ms file tail, mail delivered by sacrificially denying a tool call, and no
per-turn cost. ACP grok has protocol receipts, 10 ms interrupt, structured
permission asks, 300 ms resume, and per-turn cost.

**Content**
- Revert the M0 staging pin for grok; run the same seven-point checklist.
- **The restart gate, honestly:** grok's server child dies with the daemon. The
  milestone ships only when a daemon restart auto-resumes the conversation
  (`session/load`; POD-2432 restart-safe inventory is the vehicle) — because
  headed grok survived restarts under abduco and principle 2 forbids the
  regression.
- Retire the sacrificial-deny mail hack **on the ACP route only** — mail collapses
  into `send()` (the POD-2043 shape). Headed grok keeps the old path untouched.
- Ride-along cheap win, independent of the driver: stop discarding the
  `stopReason`/`sessionId` grok's own JSON output already returns (POD-2030).

**Explicitly not in M2:** the blocking-stop-hook question (POD-2026) beyond what
mail-in-send needs; grok streaming to chat.

---

## M3 — Codex flipped (the bug-debt milestone)

**User benefit:** the most-used harness gets truthful chat, and the machine stops
accumulating corpses.

Codex carries the native-view and lifecycle debt, so its milestone is mostly
existing bugs — that is the point, they become *release-gated* instead of
open-ended:
- POD-2761 — switching views must not cold-start into faked continuity.
- POD-2775 — hibernating a codex session must not wedge it.
- POD-2691 — dead agent servers reaped, not surviving for days.
- POD-2772 — the login gate must not block server drivers wrongly.
- Same seven-point checklist + the native-attach journeys (take-over, queued
  drain on release, spectators).
- Same restart gate as M2 (codex is a daemon child too).

**Explicitly not in M3:** the shared-ACP-substrate idea, pooled placement,
`codex --remote`.

---

## M4 — Streaming (the first strictly-new milestone)

**User benefit:** live text in chat while the agent works — the most visible
feature of the whole epic, deliberately *not* in the first release.

- POD-2293 — stream replies to chat viewers (the wire + UI half).
- POD-2773 — drive streaming on grok and opencode (proven today only on codex).
- First-turn-a-viewer-joins streams, proven ×3 with controls.
- In-progress tool-call previews where the harness needs them (the codex
  `partial` arm), so long tool calls stop looking like a hang.

---

## M5 — Never invisibly stuck (the background-agent trust milestone)

**User benefit:** a background agent cannot silently wedge. This is what makes
"fully reliable background agents" true, and it is worth a milestone of its own.

- POD-2414 — every needs-human failure materializes as a durable
  PendingInteraction (`auth-expired` → login card, `context-overflow` → recovery).
- POD-2603 — claude login/setup dialogs detected and surfaced, not invisible.
- Blocked cards answerable from every shell that renders sessions; expiry
  escalates rather than auto-denies.
- POD-2298 — refused receipts correct optimistic delivered rows.

---

## M6 — One machine truth, then retirement

**User benefit:** fleet-scale operation and one code path to maintain.

- POD-2410 / POD-2412 — the concrete machine runtime and its wire; `podium
  runtime ps`, process-table `list()`.
- Process-ownership phases: typed stop verdicts, positive-evidence kills, the
  15-orphan acceptance fixture.
- POD-2415 — archive import and cross-machine handoff.
- POD-2416 — the retirement ledger: headless-drivers, durable-headless, raw PTY
  injection visibility, the second streaming plane — each marked absorbed /
  deliberately dropped / still load-bearing, and the absorbed ones deleted.
- The spec's fleet acceptance (50 executors, one week, zero stuck, zero
  collateral OOM) closes the epic here, not earlier.

---

## What this buys

- **Something out after M0+M1**, with one harness measurably better and nothing
  else changed — the minimum bar, met early.
- **A repeating shape.** M1→M3 are the same milestone three times; the checklist,
  the drive scripts and the staging knob amortize. Each flip is one manifest line
  to revert.
- **The scary work is quarantined.** Streaming, interaction materialization and
  machine-runtime consolidation each get a milestone where they are the only
  risk, instead of riding a driver flip.
- **The catalogue keeps its job** as the ledger of everything; the milestones are
  the order in which its rows actually turn proven. Rows no milestone consumes
  (forking, rewind, send-on-stop, pooled placement) are visibly post-M6 backlog,
  not silent scope.
