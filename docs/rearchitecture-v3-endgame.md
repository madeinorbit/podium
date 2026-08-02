# Rewrite v3 — endgame order (Phases 7, 8, 9)

Recorded 2026-08-02 from the human's direction. This document is the canonical order for
everything after Phase 6. Where an individual issue's brief and this document disagree, say so
on the issue rather than silently picking one.

The single rule that shapes all of it: **main keeps moving while the rewrite runs**, so catching
up is not a one-time event. It happens **three times** — once fully (7.4), once as a delta
(7.7), once immediately before the cutover (8.1) — and each time by the same protocol.

---

## Phase 7 — POD-294

| # | Issue | What it is |
|---|-------|-----------|
| 7.1 | POD-333 | Delete named compatibility shims + CLI launch-plan migration debt |
| 7.2 | POD-334 | Single-source systemd units; packaged-install e2e |
| 7.3 | POD-335 | Architecture manifest at error level; legacy rules retired |
| **7.4** | **POD-1439** | **Main reconciliation round — NEW** |
| 7.5 | POD-336 | Docs rewrite (was 7.4) |
| 7.6 | POD-356 | Topology closure: shipped layout vs ADR 8 |
| **7.7** | **POD-1440** | **Main drift delta re-check — NEW** |
| **7.8** | **POD-1281** | **Live upgrade rehearsal — rescoped, now numbered** |
| 7.9 | POD-337 | Release gate — HUMAN GATE. Closes **Phase 7**, not the epic (was 7.5) |

### 7.4 Main reconciliation round (POD-1439)

1. **Local main first.** origin main into local main; get local main green on its own gates;
   record the SHA. Everything downstream cites it.
2. **Merge local main into the rewrite — not mechanically.** The architecture diverged far
   enough that a landed feature may have to be **reimplemented** against the new structure
   rather than merged.
3. **A separate coordinator owns it.** Its first act is to file sub-issues under POD-1439, one
   per landed body of work, then drive them with subagents.
4. **Every landed feature gets a recorded disposition:** landed / reimplemented / **skipped with
   a reason**. If something no longer makes sense after the rewrite, skipping it is the right
   answer — but the skip is written down. A silent drop is the failure this rule exists to stop.
5. Full lane green, UI runtime-verified, disposition table committed and attached.

### Why 7.4 sits before 7.5 and not after 7.6

The alternative — putting the catch-up immediately before the rehearsal, to minimise drift
across 7.5 and 7.6 — was considered and rejected as the *primary* placement.

7.5 (docs describe the shipped system), 7.6 (shipped topology vs ADR 8) and 7.9 (release gate,
audit at zero) all **grade the tree**. Grading a tree that has not absorbed main means grading
the wrong tree and then redoing all three. That is the "run the checks against a complete
rewrite" argument, and it wins.

It sits *after* 7.3 rather than before 7.1 because 7.1 and 7.3 rewrite import sites wholesale;
running a hard merge across that at the same time multiplies the conflict surface for nothing.

The drift concern is real, and it is answered by adding checkpoints rather than by moving this
one: **7.7** is a lightweight delta re-check immediately before the rehearsal, and **8.1** checks
again immediately before the cutover. 7.7 escalates to a full coordinator round if the delta
turns out to be large — a big delta handled as a small one is exactly how POD-310's rehearsal
got invalidated the first time.

### 7.8 Live upgrade rehearsal (POD-1281) — two stages, separate instance

Not an in-place upgrade. That is Phase 8. This proves the migration on a copy, where failure is
free, and it separates *"the new build is broken"* from *"the new build cannot digest the old
data."*

**Stage A — clean room, empty DB.** A fully separate Podium instance on ludovico: separate empty
database, ports, state directory, systemd units. **No interaction with the main instance at
all**, and the isolation is proved before anything is tested on it. An agent clicktests it
extensively; then **the human clicktests it**. Gate — Stage B does not start until that sign-off.

**Stage B — same instance, copy of the live DB.** Copy the live database in. **Work on the main
instance stops** for the duration so the source cannot drift; the stop window is agreed with the
human before copying. This is what actually tests the migrations: real volume, real history,
rows no fixture had. The agent runs and **measures** the migration path, clicktests against live
data, and fixes what the real data surfaces. Then **the human clicktests again**. Second gate.

The runbook (docs/rearchitecture-v3.md, Phase 2 section) currently describes an in-place upgrade
— which is now Phase 8's procedure — and is updated as part of this issue.

---

## Phase 8 — Cutover — POD-1413

| # | Issue | What it is |
|---|-------|-----------|
| 8.1 | POD-1441 | Main catch-up again, same protocol as 7.4 |
| 8.2 | POD-1442 | Cut over in place, test extensively, push as soon as we are sure it runs |

Blockers that must close before 8.2: **POD-1208** (publication worker still emits wire-v1
unconditionally), **POD-1244** (second tab never converges on the kernel replica), **POD-806**
(`podium db restore` — the pre-flight rollback depends on it being a command, not a runbook line
someone skips at 2am).

Catch-up is separated from the cutover deliberately: a cutover that is also absorbing a merge
cannot tell a migration failure from a merge failure.

---

## Phase 9 — Post-cutover cleanup — POD-1415

**9.0 — new worktree.** Phase 9 does not run in `issue/279-integration`. Stop that issue, free
its worktree, and start Phase 9 fresh off the post-cutover branch. The review rounds must read
the shipped tree.

| # | Issue | What it is |
|---|-------|-----------|
| 9.1 | POD-1443 | Proposed-lane re-triage: duplicates marked, real ones refiled here, all implemented |
| 9.2 | POD-1444 | Three adversarial review rounds |
| 9.3 | POD-1445 | Findings container: curate by priority, file, fix one by one, re-review |
| 9.4 | POD-1446 | Integrate into main |
| 9.5 | POD-1447 | Architecture grade report |

### 9.2 — the three reviewers

| Issue | Model | Effort | Stance |
|-------|-------|--------|--------|
| POD-1448 | Fable 5 | medium | adversarial |
| POD-1449 | GPT-5.6 Sol | xhigh | adversarial |
| POD-1450 | GPT-5.6 Sol | high | security |

Different models on purpose, so they do not share a blind spot. They run in parallel and **must
not read each other's findings** — independent agreement is the priority signal, and copied
findings destroy it. Model and effort are set on each issue; **verify after spawn** that the
session actually took them (spawning has been seen to drop the model and store `auto`), and check
codex/Sol sessions are not sitting idle by reading their turns rather than their status.

### 9.3 — the re-review rule

Fixes land **one at a time** in priority order, and each fix goes back to **the same session that
raised the finding** — not a fresh reviewer. That session holds what the finding actually meant
and is the one qualified to say the fix addresses it. The three reviewer sessions therefore stay
alive from 9.2 through 9.3.

### 9.5 — the grade

Fable 5 at medium effort grades the shipped tree, with every claim citing a file: is it too
complex, is it good, is it future-proof and solid to build on, does it carry too much theater or
not enough — plus the next three things worth changing.

---

**The epic closes after 9.5**, not at POD-337. POD-337's acceptance text still says it closes
POD-279; that is now wrong — it closes Phase 7 (POD-294).
