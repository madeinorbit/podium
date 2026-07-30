# POD-279 rewrite fan-out — coordination ledger

Coordinator session: `aa1f8b5d-bb56-4c68-8eb6-809c6f55ec47` ("Coordinator: rewrite fan-out")
Integration branch: `issue/279-integration` at `/home/mgw/src/other/podium/.worktrees/issue-279-integration`
Run started: 2026-07-29 23:48 CEST. Target: 2026-07-31 13:00 CEST.

Implementers: Claude Code / `claude-opus-5` / effort `medium`.
Reviewers: Codex / `gpt-5.6-sol` / effort `high`.
**Quota switch rule:** if Claude Code passes 70% on either the 5-hour or the weekly window,
implementers switch to Codex `gpt-5.6-sol` medium and reviewers to `claude-opus-5` high; switch back
below 70%. Check `podium quota` hourly.

## Run log

- **2026-07-29 23:48** — Session start. `issue/279-integration` was 455 commits behind `main`.
- **2026-07-30 00:05** — Rebased onto `main`: 57 commits replayed, 5 real conflicts resolved
  (`package.json` test scripts; the relay title-nudge test, which `main` had already fixed a different
  way — took `main`'s; `packages/sync/src/ledger.ts`, where POD-758's NUL→`\0` escape and the
  `entityOverlayKey()` extraction had to be re-applied on top of `main`'s newer content;
  `vitest.config.ts`, taking the array-form alias map and re-adding `main`'s `@podium/composer` entry;
  the spawn-harness test). Typecheck green, 20/20 packages. Unit lane 5260 pass / 2 fail — both the
  Phase 0 ratchet assertions gone stale across the rebase, which is POD-861's job.
- **2026-07-30 00:06** — POD-287 (Phase 0) CLOSED: exit gate POD-422 was already done, guardrails are
  on the branch.
- **2026-07-30 00:10–00:30** — Waves 1 and 2 launched: ten implementers, each in its own worktree
  branched off `issue/279-integration` via `podium issue update --parent-branch`.

- **2026-07-30 00:45** — `packages/client-core/src/engine/engine.ts` fixed: two literal NUL bytes made
  78KB of client engine invisible to shell grep (`grep` prints nothing and exits 1 — *no match*, not an
  error), so every grep-based sweep on this branch silently skipped it. Found independently by the
  POD-360 and POD-364 agents. Same class as POD-758 (`ledger.ts`) and POD-296
  (`architecture-manifest.ts`). Node-side `readFileSync` scanners are structurally immune; shell greps
  and agent greps are not.
- **2026-07-30 00:50** — POD-861 merged; ratchet + manifest lanes green on integration (147 tests).
  Session stopped, worktree removed.
- **2026-07-30 01:05** — **DISK HIT 100%** (193G, 8K free). Two `issue start` calls died with ENOSPC and
  left empty branches, which had to be deleted before restarting. Freed by deleting
  `.review-worktrees`, `.claude/worktrees/*/node_modules`, and `node_modules` from 133 worktrees with no
  process cwd inside them → ~8G free. Note the reap doc's warning held: node_modules is largely
  hardlinked, so removal frees far less than `du` suggests. `.worktrees` is 28G deduped; the largest
  single win available is `/tmp/claude-1000` at 8.6G, which the permission classifier blocked me from
  pruning.
- **2026-07-30 01:20** — Three Codex `gpt-5.6-sol` high reviewers spawned (POD-369; POD-360+364 as one
  paired review; POD-414).
- **2026-07-30 01:30** — Quota: Claude 5% of 5h, 19% weekly. Codex 5% weekly. Well below the 70% switch
  threshold; implementers stay on Claude Opus 5.

- **2026-07-30 01:31 — CHECK-IN 1.** All 14 streams verified moving by worktree diff. POD-1105's gate
  independently re-verified by me: exit 0, "58 allowlisted, 0 new" vs 69 violation lines on base; it
  found **18** new violations, not the 7 the brief guessed, and relocated the apps/web harness branching
  into a shared descriptor instead of allowlisting view files. Reviewer spawned rather than merging
  blind, because the diff touches five UI files.
- **2026-07-30 01:35** — **POD-300 started chained off POD-299's branch** (`--parent-branch
  issue/299-…`) instead of waiting for POD-299 to merge. Six streams are queued behind POD-300, and
  POD-299's scaffold already compiles. The delegate is told explicitly not to rebase onto or merge its
  own base, since POD-299 is still live on it.
- **2026-07-30 01:40** — Freed 47 stale build dirs (`.turbo`, `dist`) from dead worktrees: only ~300MB.
  Confirms the reap doc — the 28G in `.worktrees` is mostly hardlinked `node_modules` and source, so the
  only real lever left is removing WHOLE dead worktrees whose branches are landed (patch-id test:
  `git cherry main <branch> | grep -c '^+'` == 0). Deferred to the next cycle; 8.8G free is workable.
- **2026-07-30 01:45** — Coordinator-tooling friction filed: **POD-1113** (top-level, stays a proposal
  for the human) with sub-issues POD-1115 (phase cannot distinguish working from parked), POD-1116
  (agents cannot start proposed issues — cost a duplicate issue and a dangling `discovered-from` edge),
  POD-1117 (no `--prompt` on `issue start`, no mail broadcast, delegates start unnamed), POD-1118
  (`podium status` reports a running server as down), POD-1119 (failed `issue start` leaves an empty
  branch that blocks the retry).

- **2026-07-30 02:00 — OVERLOAD INCIDENT, my fault, and the most important lesson of the run.** I fanned
  out to 17 concurrent implementers plus 5 reviewers on a box with **8 cores and 24GB RAM**. Result: load
  average **230**, 16GB of 24GB swap in use, 771MB free RAM, run queue over 200. The scarce resource was
  **MEMORY, not CPU** — every process sat at 12–20% CPU while `vmstat` showed 73% iowait: classic swap
  thrash. Each Claude session is ~300MB RSS, each `tsgo` worker 300–700MB, and several agents ran full
  lanes at once.
  - **The damage was to VERIFICATION, which is worse than slowness.** `bun run test` went red and
    non-terminating with two Bun 1.3.14 **segfaults** on a branch whose diff was a single Markdown file.
    One agent chased a `SIGILL` in `wsServer.client-auth.test.ts`, got a pass-after-revert (the shape of a
    confirmed regression), and only avoided filing a false finding by re-running *with* the change and
    getting 4/4 passes. Under thrash a single bisect result is a coin flip.
  - **Fix: the `test-lane` advisory lease.** `podium lock acquire test-lane --ttl 25m --wait` around any
    full-suite run *and* any `typecheck --force`; targeted vitest + scoped typecheck + the cheap gates
    (`check-boundaries`, `rearch-audit`, `check-no-nul-bytes`) stay unrestricted. Broadcast as an
    interrupt to all active implementers, twice (the second time once I understood it was memory).
  - **Result within 15 minutes:** load 230 → 94, free RAM 771MB → 4.1GB.
  - **Rules I should have started with:** (1) size the fan-out by RAM, not by how much independent work
    exists — on this box that is roughly 8–10 concurrent heavy sessions, not 17; (2) serialize the
    memory-heavy lanes from the beginning; (3) *never* let an agent debug a test failure observed while
    the machine is thrashing — tell it to re-run first. What I could NOT safely do: `session stop` frees
    the worktree a reviewer is reading, and mass-killing the 70-day-old stale sessions holding 1.6GB is
    the exact mistake this repo has suffered before.
- **2026-07-30 02:10** — **POD-359 merged and closed.** Its real contribution was not the doc: the
  reconciliation sweep found that **POD-1077** (watermarked scoped feed) waited only on POD-1075/POD-1072,
  so nothing tied it to the kernel it must land inside and the scheduler could have floated it ready
  before the Authority or the conformance suite existed. Now waits on POD-305 and POD-373, still blocks
  POD-308, no cycle. A prose constraint became a scheduler-enforced one.
- **2026-07-30 02:15 — three CHANGES REQUESTED verdicts, all substantive.** The Codex reviewers earned
  their cost; each used an independent method and found real defects.
  - **POD-414** (SessionBinding taxonomy): 6 blockers. Called `(agentIdentity, onBehalfOf, scope)` "the
    principal" against ADR 9 D1's `(user, device, capability)`; asserted states its schema cannot
    represent (`H6` claims claim-then-commit with no pending-claim field; `NativeObservation.supersedes`
    points at an observation id that does not exist); missing the migration table its parent requires.
  - **POD-360 / POD-364** (paired): 3 blockers each, and **three cross-document disagreements** — which is
    exactly why they were reviewed together. Adjudicated: `deletion_source` is a typed `issue|standalone`
    label (POD-364 right), `causedBySessionId` *is* emitted for ready/unblock/stage_changed/reopened/closed
    (POD-360 right), and both must carry `spawnedBy`'s `automation:<id>` arm. POD-364's headline "28
    session representations" versus a 24-row matrix is a real reconciliation gap — but the *correction to
    the epic's assumed 8* stands; I told it not to walk the number back for tidiness.
  - Standing instruction added when routing back: **fix the DETECTOR, not the named sites.** Patching the
    seven missed composite-key lines leaves the eighth.

- **2026-07-30 02:30 — CHECK-IN 2.** Load recovering: 230 → 50. Claude 22% of 5h / 23% weekly, Codex
  low — no model switch. Disk 11G free.
  - **A MISTAKE I MADE AND AN AGENT CAUGHT:** all five Codex reviewers were dispatched with briefs saying
    "re-run the lanes yourself: bun install, bun run typecheck, bun run test" — written *before* the lease
    rule existed. POD-1105's implementer found a reviewer process on its own branch about to do exactly
    that and told me rather than killing it. Five reviewers each starting an unleased full suite would have
    re-broken the thing the lease protects. Corrected brief forwarded to every live reviewer, including the
    explicit instruction not to mark an implementer down for declining a full lane under these conditions,
    but to mark them down for citing a FULL TURBO cached typecheck or reporting a load artifact as a
    finding. **Lesson: a broadcast fixes the agents you remember; the ones already dispatched carry the old
    rule inside their brief.**
  - **Four more CHANGES REQUESTED**, all catching things I had specifically asked for:
    - **POD-1105** (2 blockers): it relocated harness branching out of the views — right direction — but
      into a *closed* dispatch whose helpers **THROW** for an unknown harness, and `SidebarUnified` lost
      its navy fallback (undefined). So a branch that silently mishandled an unknown harness became one
      that crashes on it: a behavior regression riding inside a boundary fix. Move 5 requires an OPEN
      HarnessId with **incremental-completeness** degradation, so this is the substantive half of the
      issue. Told it to coordinate the descriptor shape with POD-397's `Declared<T>` rather than invent a
      second vocabulary.
    - **POD-733** (4 blockers): equal `InstanceId` strings do not prove the same deployment; `local` /
      `__local__` sentinels not separated from POD-318's daemon-minted UUID; **the lost-machines-row
      recovery contract left undecided** — which was the empirical test I set for this record, since
      diagnostics cannot distinguish deliberate revocation from database loss; `repo_id` origin-hash
      equality not split from the machine-and-path fallback.
  - **POD-379 done and it is the best-evidenced deliverable so far**: 122 characterizations, zero product
    files touched, and **ten mutants applied to the product and all ten caught**. Its three findings matter
    beyond its own scope: offline queueing covers **eight** session writes (not issue-writes-only as its
    brief claimed — changes POD-316's scope); **three writes succeed against a nonexistent session id**
    (`snoozes.set`, `pins.set`, `tabs.setOrder`) and the not-found shape has **four** different forms, so
    3.1.5's consistent-error rule has an existence oracle to close; and presence writes have **no agent
    path at all** — operator-only by *absence* from `RELAY_ALLOWED` rather than by a check, which POD-380/382
    must reproduce deliberately.
  - **Standing evidence policy, now settled** (three agents proposed it independently and I confirmed it):
    targeted lane + genuinely-uncached scoped typecheck (`bunx tsgo --noEmit` in the package) + the three
    cheap gates is the *preferred* evidence, not a fallback. It is sharper than a full suite because it is
    attributable to the diff. The full lane runs once, at integration, and I own it.
  - Filed **POD-1122**: `scripts/` has no typecheck gate at all, so every guardrail this epic leans on is
    itself unchecked — same fail-open shape as the NUL-byte class. Discovered by POD-369's implementer.

- **2026-07-30 02:45 — POD-370 done, and it sets the bar.** Outbox lifecycle + dead-letter, 2575
  insertions, zero deletions. Three things make it the best deliverable of the run:
  - **Invariants made STRUCTURAL, not checked.** Apply-time re-auth isn't a check someone remembered:
    there is no capability, allow-bit or identity field anywhere on the record *or* the envelope, so a
    replay has nothing stale to present — with a test asserting envelope keys are exactly
    `command/input/mutationId/version`. D9 invariant 5 is upheld by **absence**, with a test walking
    `Outbox.prototype` asserting no method matches `rebootstrap|rescope|epoch|cache|clear|reset|wipe|drop`.
  - **It reported its SURVIVING mutant.** Seven mutants turned tests red; one survived (a parked head not
    blocking its partition on a later pass), it said so, and added two partition tests. Agents almost
    always report only the mutants they caught; the survivor is the valuable half.
  - **It proved `test:web` was MORE red without its diff** rather than pleading load — a scripted probe
    parking its directory, confirming `git diff` empty against the branch point, running the lane
    (35 failed base-equivalent vs 20 with the diff), restoring via a trap.
- **THE SIBLING-NEGOTIATION PATTERN, worth reusing.** POD-369 and POD-370 resolved their port boundary
  *directly from the ADR text*, with no deference to seniority and no escalation to me. POD-369 argued that
  a contractual no-op whose SUBJECT is the queue is one edit from data loss on the **normal** path (a
  rescope fires whenever anyone clicks share); POD-370 accepted and removed it. POD-370 then **declined**
  POD-369's offered port for D9 invariant 5, on ADR 2 D7's own words: re-evaluating a stale
  `expectedRevision` against new truth is the replica deciding the command is moot, which *is* arbitration.
  Both calls are right. This is precisely what the ADR pack was written to make possible, and it is the
  argument for keeping greenfield-from-ADR work parallel.
- **Ruling given (POD-370's one open question):** `confirmed?: true` STAYS on the record and envelope
  (ADR 2 D8 outcome 3). An opaque token would make the confirmation-required recovery path untestable, and
  an untestable state in a lifecycle is exactly how the previous two attempts left mechanisms half-landed.
  Conditions: declared once via a single exported type alias so POD-311's rename is one edit, and the
  design doc must record the NAME as provisional while the SEMANTICS are decided. Carry into POD-311's brief.
- **POD-414 revision 2** (649 → 1079 lines) addresses all six blockers and went back to the *same* live
  reviewer. Notable additions beyond the findings: the daemon must not start a process before the server
  accepts a reattach, and where a duplicate exists it terminates **by attempt id** — never by session id,
  never by scanning process names — and terminates **nothing** if it cannot prove which attempt is which
  (a bare abduco sweep once killed 93 unrelated masters on this box). It also pushes back on provenance:
  `(agentIdentity, onBehalfOf, scope)` is quoted verbatim from ADR 9 D1, so revision 1 was under-specified
  rather than contradicting the ADR — reviewer asked to confirm, so nobody hunts a nonexistent defect.

- **2026-07-30 03:15 — CHECK-IN 3. THE PACE PROBLEM, stated plainly.** 3h30m in, **2 issues merged**
  (POD-861, POD-359) against 98 remaining. Five review loops are 2–3 rounds deep and every round is
  finding *real* defects — this is not review theatre. A sample of what rounds 2 and 3 caught:
  - POD-370: the reviewer invented its own mutants (as instructed) and **two survived** — the unreachable
    arm returning true let a transport-failed FIFO head permit its successor, and `isAgedOut` measured from
    `lastAttemptAt` instead of immutable `queuedAt`, so **repeated attempts extend the D10 expiry horizon
    indefinitely**. Plus an executable probe reaching memory `[m1,m2]` with durable `[m1]`.
  - POD-379: `sessions.continue` and `sessions.stop` have **no oracle coverage at all** (both
    `RELAY_ALLOWED`), and the handoff preflight-order test **would pass with kill-before-probe** because it
    records source and target in separate arrays and never compares them.
  - POD-369: validation bypassable on two real ingress routes; public events not preserving the feed order
    the cache now does; a normative transition table that **contradicts the implementation**.
  - **THE CROSS-CUTTING ONE:** both kernel reviewers independently found that ADR 2 D10's crash window
    cannot be closed through the current sibling ports — POD-369 commits entity+cursor then retires the
    overlay post-commit, POD-370 then does a separate outbox write. Neither module is wrong alone; the gap
    exists only in the JOIN. That is precisely the failure class this epic exists to end. Ruled: they define
    a shared unit-of-work port together (one exchange each, then I decide), POD-305/POD-373 wire it, and I
    carry the clause into those briefs so it cannot be reinvented.
- **MERGE POLICY set, because the loops were unbounded and that is my failure, not theirs.** Class A
  (docs/inventories/decision records — POD-360, POD-364, POD-414, POD-733): blocking = a statement FALSE
  about the code, a document CONTRADICTING ITSELF, a classification that sends an implementer to the wrong
  work, or a safety property lost if unstated. Everything else becomes a follow-up. *A decision record is
  finished when the next implementer cannot make an incompatible choice — not when every consequence has
  been designed.* Class B (greenfield kernel with downstream port consumers — POD-369, POD-370): bar stays
  high, because the port shapes get copied. POD-733 explicitly bounded to one more round.
- **POD-299's finding is a SIBLING to the phantom-zero rule and is worse in kind.** Boundary rule 7
  (domain single-home) read only the **top level** of the home package's `src/`. Once `packages/model`
  organises sources into subdirectories: **4 names scanned instead of 48 — 92% lost**, including every
  entity predicate the rule exists to protect (`authorize`, `OPERATOR`, `isIssueDeferred`,
  `normalizeOriginUrl`, `handoffTargets`, `dedupeSessionsByResume`) — and it would still **exit 0 with no
  violations printed**. The phantom-zero case was a counter drifting; this was a whole rule reduced to 8% of
  its subject while reading green. New clause: **any lint or audit that enumerates a directory must be
  checked for whether it RECURSES**, because "reorganise a package into subdirectories" is a legal,
  invisible way to defeat it. Applies to POD-397/398/399 and the whole Phase 6 client split.
- Also worth keeping: POD-299 had a real infinite loop of its own — a poll loop
  `while pgrep -f "vitest.unit.config"` whose **own argv contains the pattern**, so pgrep matched itself and
  the condition was never false. It presented as "the machine is busy". A self-matching pgrep never
  terminates.

- **2026-07-30 03:30 — CHECK-IN 4. SEVEN MERGED**, and the boundary gate is green on integration.
  Merged: POD-861, POD-359, POD-360, POD-364, POD-1105, **POD-396 (packages/pty)**, **POD-397
  (packages/harness)**. Quota fine (Claude 33% of 5h / 25% weekly; Codex 9%). Load 230 → 30, swap
  23GB → 12.8GB. All remaining streams verified moving.
- **The agent-bridge split landed from both ends at once**, and the merge was the interesting part:
  12 conflicted files, because POD-396 and POD-397 each carved a different half out of the same
  package. The resolution is the **union of both removals** — `packages/agent-bridge` now owns
  `features: []` and its barrel exports nothing, an empty shell for POD-399 to delete. Notable
  resolutions: kept POD-396's `AGENT_HOST_CONSUMERS` table (it had already anticipated harness) and
  added the harness row, but took POD-397's `ref.specifier` message since it generalises past a
  two-package ternary; rule id stays `agent-bridge-consumers` so the ratchet's (rule,file) keys
  survive the split. Daemon imports resolved by the rule *"POD-397 left the pty half on agent-bridge,
  which POD-396 moved to pty"* — theirs, rewritten — then whole import **declarations** deduped
  (my first pass only deduped single-line imports and left the multi-line blocks doubled).
  - **Corrected a comment POD-396 wrote that POD-397 falsified:** `HARNESS_ADAPTER_HOME` is now
    `packages/harness`, so the axiom APPLIES to pty. Left as-is it would have told the next reader
    the opposite.
  - **`tests/e2e` had three live imports of the now-empty package.** Typecheck could not catch them
    because `tests/e2e` has NO typecheck lane — the exact gap POD-1122 records. Found by grep.
    That is the second time tonight the missing `scripts/`+`tests/` typecheck lane hid real breakage.
  - Verified on the merged tree: typecheck **22/22**, boundaries exit 0 (58 allowlisted, 0 new),
    deletion audit baseline exact, no NUL bytes.
- **DEFERRED VERIFICATION, recorded honestly:** POD-396 and POD-397 merged **without an individual
  reviewer**. Justification: both are mechanical relocations with full-lane evidence (POD-397 ran the
  full suite under the lease: 5278 passed, its 1 failure was its own bug, caught by the gate and
  fixed), they cross-reviewed each other's territory and each caught a phantom zero in its *own*
  diff, and the merged tree passes typecheck plus all three gates. Memory was the binding constraint
  on spawning another reviewer. If time allows, a post-merge audit of the two extractions is the
  first thing to buy.

- **2026-07-30 03:20 — I DELETED A LIVE AGENT'S WORKTREE. My third self-inflicted incident, and the
  most instructive.** After merging POD-360/364/1105/396/397 I ran `podium session stop` on each
  implementer then `rm -rf` on their worktrees. **The stop calls for 360/364/1105 FAILED** — the server
  was OOM-restarting and returned "agent relay timed out" / "Unable to connect". I read those failures
  and removed the directories anyway, reasoning that merged work meant finished sessions. POD-360 was
  still live and mid-turn; its working directory vanished under it.
  - **Nothing was lost, purely because of the commit-incrementally rule I had already given them.** All
    four commits and the branch ref survived in the shared object store. It lost ~30 minutes of
    uncommitted edits. That instruction earned its keep.
  - **The agent's report was better than my action.** It bounded the window tightly, verified its own
    commits before raising the alarm, correlated the disk-usage change, and — the valuable part — asked
    me to broadcast the SYMPTOM rather than just a warning, so nobody would debug a phantom. It inferred
    a rogue reaper, which was wrong but entirely reasonable. I broadcast the correction fleet-wide
    naming myself as the cause within minutes.
  - **Two general errors, both worth keeping:** (1) I treated *"its work is merged"* as *"it is
    finished"* — a session can be live doing useful follow-up, and this one was working a review round
    I had asked for. (2) **I proceeded past a failed stop.** A failed stop is precisely the case where
    the destructive next step must not run, because you no longer know the state you are acting on. The
    failure WAS the signal and I overrode it.
  - **New rule, now applied:** never remove a worktree unless `session stop` returned SUCCESS; check
    `session status` immediately before removal and treat `live/working` as an absolute veto regardless
    of issue state. Also told the fleet: after a worktree is recreated, RE-VERIFY files rather than
    trusting the checkout — a partial delete is as likely as a complete one.
- **2026-07-30 03:30 — NINE MERGED.** Added POD-733 (instance identity record, APPROVED after four
  rounds / eight blockers) and POD-388 (peer framing + seven auth-strategy modules, built on POD-387's
  plane ports).
  - **The D10 seam settled in ONE exchange, as ruled.** POD-370 proposed an ambient
    `uow.transact(body)`; POD-369 accepted the direction and rejected the types with three amendments,
    all correct — its decisive argument being that wrapping unchanged kernel methods in `transact` does
    NOT enrol their inner store calls, and no portable ambient transaction exists in a browser runtime,
    so an ambient seam is hidden coupling that silently fails to enrol. Resolved against my
    no-contract-change constraint by making both span parameters OPTIONAL. The clause (two neutral port
    types, six rules, and the crash case POD-373 owes) is recorded in
    `docs/design/outbox-lifecycle-state-machine.md` and must be carried into POD-305/POD-373 briefs.
  - **POD-370 also sharpened my own praised pattern.** I had commended asserting an invariant by
    *absence* over method names; its reviewer showed a `destroy()`/`flush()` would pass that regex. The
    guard is now structural — a staged draft diffs starting ids against ending ids and every vanished
    id must carry one of D9 invariant 1's two licences, or it throws before the write. *"Assert the
    absence" is only as strong as the thing you assert it over: over method NAMES it is a spelling
    check; over the mutation path it is an invariant.*
  - **A merge bug of my own, caught by the tests:** resolving POD-388's additive test-file conflict I
    de-duplicated identical LINES across both sides, which ate a legitimately repeated closing `})` and
    left a `describe` unclosed. The file then reported **"no tests"** instead of failing — the same
    fail-open shape this epic keeps meeting. Line-dedupe is safe for import declarations and unsafe for
    code. Redone as a true union, brace balance checked (151/151), suite verified 48/48 so BOTH rules'
    tests actually run.

- **2026-07-30 03:30 — TWO MORE OF MY OWN DEFECTS, both caught by an agent, both now fixed.**
  1. **My POD-360 merge took `fdb48c4e` and MISSED `01c6ed4e`** — the commit correcting `spawnedBy`
     from six documented arms to the eight production writes. POD-364's correction *was* merged on the
     same branch. So integration carried **two merged maps of the same field contradicting each
     other** for about an hour, and POD-365 reading it would have built a union member for a `steward`
     arm no producer writes. Caught by the POD-360 agent with `merge-base --is-ancestor` rather than
     by inferring from merge output. **Lesson: verify the merge landed the tip you intended; the merge
     commit succeeding tells you nothing about which commit it took.** Fixed by merging `01c6ed4e`
     specifically (not the tip — round 3 is still in flight).
  2. **I closed POD-360 while it was still in review.** Its round-3 verdict arrived after the commits
     I merged, with two fix-side findings. Reopened to `review`. I also took the reviewer's nit myself
     (`4a9276bb`) because the 3.6.2 heading still read "has SIX arms" above its own corrected
     eight-arm table — a false heading on the very section whose job is correcting that count, and the
     first thing a POD-361/362/363 implementer reads.
- **Adopted from the fleet, all three sharper than my own wording:**
  - *"A FAILED stop and a HUNG stop are indistinguishable from the caller, so `session status` is the
    better veto — it asks the thing that DECIDES rather than the thing that reports."* Generalises:
    prefer the deciding authority over the reporting one.
  - *"After ANY interrupted write — reaped directory, ENOSPC, segfault — the cheap proof is typecheck
    plus the targeted suite, not `ls`, because a truncated TS file fails to parse."* (POD-727)
  - *"A wait that cannot fail is not a wait."* (POD-299, whose poll loop's `pgrep` pattern matched its
    own argv, so it could never terminate — and presented as "the machine is busy".) Same family as
    the failed-stop rule: **the signal that something is wrong arrives disguised as ordinary slowness
    or ordinary failure, and gets stepped over.**
- **POD-370's self-application of the same lesson is the best thing in this cycle.** Told to commit
  immediately, it committed **mid-refactor** as a labelled broken intermediate saying plainly that the
  tree does not typecheck at that commit and why, then completed it. And it connected my mistake to
  its own reviewer finding: *"'The failure was the signal and I overrode it' is the same shape as the
  bug my reviewer just found — I treated a write as having succeeded and adopted its result in memory,
  so a failed write left memory holding a record durable storage never got. Both are
  proceeding-past-a-negative-result. The fix in both cases is to make the failure structurally block
  the next step rather than remembering to check it."* Its round-2 blockers were two real data-loss
  bugs (two principal-bound instances over one physical store clobbering each other; two retirements
  in one span resurrecting the first), both reproduced before being touched, fixed at the root by
  making the store port record-level. It also reported that a test it wrote was WRONG first and that
  the wrongness revealed an undocumented boundary — which it then documented rather than widening the
  API to make its test pass.
- **`git fsck` noise, investigated and dismissed as data, not chased.** 141 "invalid reflog entry"
  errors on `issue/279-integration` plus phantom "missing tree" lines that vanish on re-run. Two
  agents independently established: the refs resolve, the objects are valid, and consecutive runs
  disagree — consistent with many sessions writing one object store while fsck reads it, plus a
  truncated reflog append from the earlier ENOSPC (**ENOSPC does not fail a write loudly, it
  truncates it**). Reflogs are recovery convenience, not the work. Recorded so nobody hunts it.

- **2026-07-30 03:45 — POD-299 MERGED (critical path), and then I FAILED the POD-300 merge and
  delegated it.** This is the most useful failure of the run so far.
  - **POD-299 landed clean**: `packages/model` at L0 with zero workspace deps, `@podium/domain`
    and the `runtime/git.ts` shim deleted, `packages/domain` fully untracked. Ratchet win locked in
    (`reexport-shims` 24→23) after verifying **per-site** that the named shim is genuinely gone.
    At merge I ported POD-388's ADR 3 D17 attribution pair (`actorUser`/`onBehalfOf`/
    `capabilityAttribution`) out of the deleted `packages/domain` into `packages/model/src/authz`
    — a `UD` conflict where one branch modified a file the other deleted.
  - **THE FAILURE.** POD-300's merge has 29 conflicted files that *look* like one mechanical pattern
    (POD-396/397 renamed agent-bridge→pty/harness; POD-300 renamed protocol→model). I resolved all
    29 with a blunt rule — take ours, then repoint imports until the compiler stops complaining —
    and reached a **green 22/22 typecheck**. It was still wrong:
    - `agent-kind-enums` **GREW 0 → 2**: `protocol/messages/harness.ts` still declared the
      `HarnessAgent` enum, so I had **reintroduced the exact duplicate vocabulary POD-300 deleted**
      and POD-303 exists to remove.
    - **9 golden wire fixtures FAILED** — POD-300's central claim is that the wire stayed
      byte-identical, and my resolution broke it.
    - `check-boundaries` red at 55 allowlisted against 58 expected.
  - **THE LESSON: a green typecheck proves the tree COMPILES, not that a merge preserved either
    branch's intent.** For this merge the deciding instruments are the golden fixtures and the
    deletion-audit ratchet. Compiler-driven resolution is exactly the wrong tool when the thing at
    stake is *where a definition lives* rather than whether it resolves.
  - **What I did about it:** aborted, restored a verified-green base (01bdf1f9: typecheck 22/22,
    both gates exit 0, audit exact), and **delegated the merge to a dedicated integrator (POD-1129)**
    with the failure written into its brief as the primary warning, plus the resolution principle
    (POD-300 wins on *where a definition lives*; POD-396/397 win on *which package a consumer
    imports from*) and an instruction to run the goldens and ratchet after every few conflicts
    rather than at the end. Third merge mistake of the run, and the first where I stopped and handed
    it to someone with more context instead of continuing to patch.
  - Its first session **exited immediately with an empty transcript** (quota 44%, load 7.5, so not
    resources). Respawned via `agent spawn --issue` with the brief as the FIRST PROMPT, which also
    sidesteps the instruction-race that POD-1117 records.

- **2026-07-30 04:05 — MY FOURTH ERROR: I put two agents in one worktree, because the STATUS FIELD
  LIED.** `podium issue show --id 1129` reported session A as `status=exited` while its process was
  demonstrably running (pid 578040, 765s uptime, cwd inside the worktree). I respawned onto it. B then
  ran `git reset --hard HEAD` — entirely reasonably, believing it was alone — and erased A's 29-file
  resolution. **This is the same failure already in this ledger**: I trusted the *reporting* authority
  over the *deciding* one, having written that lesson down myself two cycles earlier. The
  check-before-spawn rule needs **live evidence — pid, cwd, worktree mtimes — never the status field.**
  - **A DANGEROUS SIDE-FINDING from A:** `git rerere` is enabled and its cache is **repo-wide across
    worktrees**, and my *wrong* resolution of this exact merge was in it. Any later attempt in any
    worktree could have silently inherited it and presented as a clean merge with no markers at all.
    Cleared all 156 entries (every legitimate resolution is already committed). **A rerere check belongs
    in the merge protocol.**
  - Resolved by assigning single ownership to A (firsthand analysis, including the finding nobody else
    got: git did NOT rename-detect `agent-bridge/src/harness/registry.{ts,test.ts}`, so keeping the
    deletion is only half the job — theirs' repointing must then be hand-applied to the UNCONFLICTED
    copies in `packages/harness/src/`). B stood down without cleaning up, leaving the tree intact.
- **2026-07-30 04:10 — I MISREAD MY OWN EVIDENCE, and corrected it fleet-wide.** I told the integrator
  "if a golden fails, the MERGE is wrong — never the fixture". **That was wrong.** There are TWO golden
  suites: POD-300's own (85 fixtures, captured pre-move, and it PASSES) and POD-360's (87 tests, which
  builds its corpus by REFLECTING over protocol's module export surface). POD-300 removes 67 schemas
  from protocol, so POD-360's committed corpus necessarily changes in **any correct merge** — and the
  tenth failing family fails precisely *because* the merge is right.
  - **The mechanical proof the wire did not move:** 67 schemas removed, exactly 1 added (HarnessId),
    and **zero schemas on both the minus and plus sides**. A shape change would put the same schema on
    both sides.
  - So the **ratchet** was the deciding instrument all along (`agent-kind-enums` 0→2 was the real
    finding); the goldens were collateral I misattributed. My merge *was* wrong — but not for the
    reason I gave.
  - **THE SHAPE, and it is the mirror of everything else tonight:** I have spent the night warning
    about tests that PASS for the wrong reason, and then took a test that **FAILED for the wrong
    reason** as proof. *A red can mislead exactly as much as a green.* Same discipline both ways: ask
    what this would look like if it were real, and check whether the instrument is even measuring your
    change.
  - **Ruling given:** do NOT bare-regenerate POD-360's suite — 27 of the 67 relocated schemas aren't
    covered by POD-300's suite, so regenerating would silently drop their byte pin (the
    "relocation read as a deletion" shape again). Instead extend the fixture registry with model's
    entity modules so coverage FOLLOWS the schemas, regenerate, and assert each relocated case's
    `encoded` string is byte-identical to its old protocol-family entry.

### THE NAME-TRAP SWEEP PAID FOR ITSELF — five agents, five real findings, four new rules

One broadcast (a test named for a behaviour it does not check) produced this, all self-found and fixed:

1. **POD-370** — "is FIFO within a partition and **concurrent across partitions**" checked only that
   the second partition's entry was submitted *at all*; replacing `Promise.all` with a sequential loop
   passed all 92 tests. **New rule: ASSERTS THE RIGHT PROPERTY THROUGH THE WRONG OBSERVABLE.** Its first
   fix asserted an interleaved marker order and **failed on correct code** (the order is decided by
   microtask counts, not partition independence) — which tempts you to weaken the assertion until it
   goes green. Name the property, then find the observable only that property can produce.
2. **POD-360** — "covers every flag across the whole resolver input matrix" asserted only
   `cases.length === ids.size * 36`. **New rule: A BYTE-PIN PLUS A REGENERATION WORKFLOW CAN LAUNDER A
   MUTATION.** The mutant *was* killed — by the adjacent byte-pin — but only while the snapshot predated
   it. Run it the way a real change lands (mutate, **regenerate**, test) and all 87 passed with half the
   matrix gone. Any suite with a regenerate step needs, for every claim meant to survive regeneration,
   an assertion that does not read the snapshot.
3. **POD-730** — **New rule: AN "X IS PRESERVED" TEST IS VACUOUS WHEN X EQUALS THE ACTOR.** `checkpoint`
   computes `step.assignedSessionId ?? caller.actor.id`, so with the assignee doing the checkpointing
   both operands are the same value and the assertion cannot tell "kept" from "overwritten". Its
   *pre-existing* test written specifically to pin non-overwriting was **also** vacuous (`null ?? 's2'`
   is still `'s2'`). Two tests, one blind spot. Also: **verify the instrument before you believe an
   absence** — a counter returning 0 because it is broken is indistinguishable from a real zero.
4. **POD-414** — **New rule: THE ASSERTION CARRYING THE CLAIM IS USUALLY ABOUT WHAT WAS SUPPOSED TO BE
   LEFT ALONE.** A test named "terminates the losing attempt" passes if the daemon killed *everything* —
   which is the 93-masters incident. The claim lives in the word "narrow", so it must assert the
   **survivors**: winner still serving, and an unrelated third session's host untouched.
5. **POD-387** — found five, four renamed to what they verify, and one converted into a real tripwire:
   "asks the resolver rather than reading the capability" only checked that the resolver was called, so
   a port doing both would pass. `capability` is now a getter counting reads, asserted **zero**.

- **2026-07-30 04:45 — CHECK-IN 9. PHASE 1'S MODEL FOUNDATION IS COMPLETE. 15 branches merged.**
  POD-299 + POD-300 both landed and closed, plus POD-360, POD-379, POD-387, POD-730. Integration
  green: typecheck 22/22, audit exact at 261 sites, boundaries 58/0 new, 829 protocol tests.
  - **POD-300's merge, done by me after delegation failed.** The proof is the deliverable: 67 schemas
    relocated, **0 encoded bytes changed, 0 byte pins lost**, 1 newly pinned. I extended POD-360's
    golden registry with model's barrel so **coverage FOLLOWS the schemas** — that suite reflects over
    export surfaces, so without it the move would have left it *green on reduced coverage*, and 27 of
    the 67 weren't covered by POD-300's own suite. Also fixed `fixtures:wire:update`, which could not
    resolve a workspace source dependency at all.
  - **POD-1129 closed as superseded.** Its two sessions produced the map that made the merge possible
    — the union-not-a-choice principle, the two hard protocol files, the DU pair git does not
    rename-detect, the third file using `AgentKind.options` as a value, and the correction that a
    failing fixture in POD-360's suite is *not* evidence of a bad resolution. That last one fixed a
    wrong instruction in my own brief.
  - **THE D10 CONTRACT IS BANKED**, carried verbatim into POD-305 and POD-373 briefs: five clauses
    anchored on ADR 6 D4.1, the crash case, the batched-retirement requirement, the record-level-merge
    rule, and an explicit note that any draft mentioning an ambient "current span" is WITHDRAWN, with
    the probe that killed it (an enqueue FULFILLED at durable length 0, then vanished when an
    unrelated transaction aborted). POD-370 bounded at one more round — its eight rounds were
    converging 7→2→1→1→1 and three findings were data loss caught by a SURVIVING mutant.
  - **POD-369 had EXITED without reporting** with round 3 committed and 3 files dirty. Respawned on its
    branch, told to commit the dirty work first. Its remaining half is multi-retirement batching —
    the last open blocker on the Phase 2 kernel pair.
  - **New wave started on the freshly unblocked Phase 1 chain**: POD-361 (brand the model schemas),
    POD-303 (harness identity), POD-304 (provenance envelope). Each brief carries the five rules this
    run has paid for, plus the findings that land specifically on it — POD-361 gets the
    do-not-brand-MachineId constraint and the spawnedBy-gates-five-authz-checks finding; POD-303 gets
    told most of its vocabulary already landed and warned off the closed-dispatch failure POD-1105
    made; POD-304 gets the actor-is-conditional-at-every-site finding and the flat-aggregate property
    it must preserve.

### STANDING RULES THE FLEET IS WORKING TO (earned, not invented)

Each of these came from an agent finding it in its own work tonight:

1. **A green gate can mean the gate stopped looking.** NUL byte → grep says "no match"; path-scoped
   detector reads a `git mv` as a deletion *and offers to bank the win*; a lint that doesn't recurse
   checks 4 names instead of 48; a merge compiles 22/22 while reintroducing deleted debt.
2. **A test name is a claim.** A name saying "routed to X" needs a fixture containing a **Y that could
   have received it** — the missing thing is the *counterfactual*, not the assertion. Exclusive word in
   a name (OWNING, ONLY, before, distinct, never) → check the FIXTURE first.
3. **An "X is preserved" test is vacuous when X equals the actor** performing the operation.
4. **Fixing a misleading name by ADDING a test leaves the old test wearing the old name.** Renaming or
   deleting the original is a separate act, and it's the one that gets skipped.
5. **After deleting a mechanism, re-read the names of every test that used it.** The sweep is not a
   one-time pass.
6. **A byte-pin plus a regeneration workflow can launder a mutation.** Run it the way a real change
   lands: mutate, *regenerate*, test.
7. **Verify the instrument before you believe an absence.** A counter returning 0 because it is broken
   is indistinguishable from a real zero.
8. **Asserts the right property through the wrong observable** — shows up as a red on *correct* code
   and tempts you to weaken the assertion until it goes green.
9. **A red misleads as much as a green** (mine): I took a test that failed for the wrong reason as proof.
10. **Prefer the deciding authority over the reporting one** (mine, twice): a failed stop and a hung
    stop are indistinguishable from the caller; a status field said "exited" of a running process.

### MERGE-TIME TASKS (do not lose these)

1. **POD-359's reconciliation record is off by one.** It says the sweep covered "nine ADRs plus four
   amendments" and "not multi-tenancy is stated in all six documents". POD-733's **ADR 1 Amendment 2**
   landed *after* that sweep and is the one document that argues at length about an explicit `instance_id`
   column — deciding *against* it and fencing the decision, so it strengthens what was swept for. Add a
   line to the reconciliation record noting Amd 2 landed after it. POD-733's own branch already declines to
   edit that section (correctly — it is POD-359's evidence), so this is mine.
2. **POD-733's README hunk** sits at ~L26–L35 (amendments table); POD-359's merged changes are at L1–6 and
   L84+. Should merge clean; verify rather than assume.
3. A **coordinator quoting bug** truncated one reviewer brief mid-sentence (an apostrophe in `3's` closed a
   single-quoted shell string). All long briefs now go via a file and `--body "$(cat …)"`.

## Live streams

| Issue | What | Session |
|---|---|---|
| ~~POD-861~~ | **DONE, merged, closed, session stopped, worktree removed** | — |
| POD-1105 | Boundaries gate green on integration (tracked twin of the Proposed POD-1103) | `f331ac3c-a6f6-4d2d-93cc-956879b4ae7b` |
| POD-387 | 4.1a Plane-port interfaces from the ADR 7 inventory | `8e1a5b91-8e4e-4c1e-b178-177d65e7e1ab` |
| POD-414 | 5.1a Identity taxonomy + SessionBinding design doc — **in review** | `47716e2a-42b6-45fa-93ff-a3b72dd07a4f` |
| POD-733 | 4.9a Instance identity decision record | `c36697a7-1b20-4f70-95cc-9431761415c8` |
| POD-396 | 5.3a Extract `packages/pty` (harness-agnostic) | `8581e048-f50a-4ae9-9f0a-a182df411991` |
| *reviewer* | POD-369 replica state machine | `32e6f75b-9a94-4459-bb69-5e98c603789e` |
| *reviewer* | POD-360 + POD-364 representation inventories (paired) | `e2d8a6d3-87da-46dd-badd-b078c787d55e` |
| *reviewer* | POD-414 SessionBinding taxonomy | `6dc6a76f-4d4f-422a-802d-c9924c37bdf6` |
| POD-299 | 1.1 Scaffold `packages/model` at L0, absorb `@podium/domain` (**critical path**) | `0e251d7d-0f6b-4d58-850a-fb8a45a0cc20` |
| POD-360 | 1.3a Golden wire fixtures + entity-id usage inventory | `c3131e40-60f9-4976-8d86-8c7ea86fdf6a` |
| POD-364 | 1.4a Session/issue field-schema inventory | `b7fb7180-60d7-4239-8ec7-b6b68e5cd7a3` |
| POD-359 | 1.5a ADR pack — tracker-reconciliation sweep + ordering constraint wiring | `baf32138-57df-4a84-ad47-2d7ac26b82f7` |
| POD-379 | 3.2a Session mutation characterization | `2f3a1add-58f7-4c97-b2fc-dfd6b39651d7` |
| POD-727 | 3.9a Mail mutation characterization | `b07e2604-ea37-45e6-886d-c6fe5bca3b65` |
| POD-730 | 3.10a Workflow mutation characterization | `642d639c-5cd0-4c6b-b704-2e208e925e1a` |
| POD-369 | 2.2a Replica state machine (in-memory, per ADR 2) | `0eb2ee30-dedc-49ea-a677-aad7bcad6328` |
| POD-370 | 2.2b Outbox lifecycle + dead-letter semantics | `1f57c237-45da-4f60-87f4-3f5537e75a38` |

## Standing decisions (so they are not re-litigated)

1. **Human gates are suspended** for this run, by explicit user instruction. Agents record the evidence
   each gate asked for as an issue artifact and continue; nobody sets `needs-human`. Gates affected:
   POD-359 ADR sign-off, POD-351 skeleton sign-off, POD-310 upgrade rehearsal, POD-377/POD-332 device
   verification, POD-327 remote-daemon soak, POD-337 fleet soak.
2. **Children branch off `issue/279-integration`, never `main`.** Set with
   `podium issue update --id N --parent-branch issue/279-integration` *before* `podium issue start N`.
   Verified: `git merge-base --is-ancestor issue/279-integration <child HEAD>`.
3. **Characterization work runs early, in parallel, ahead of its stated dependency.** A characterization
   suite pins *current* behavior by definition, so it does not need the refactor it protects to exist
   first. Applied to POD-360, POD-364, POD-379, POD-727, POD-730.
4. **Greenfield kernel components run early against the ADR pack.** POD-369 and POD-370 are pure
   in-memory state machines specified by ADR 2/3 as amended, so they do not need POD-305's Authority to
   exist. This is what the ADR pack is *for*. They must not touch the existing funnel/Ledger.
5. **Scope discipline is the top rule** for every implementer: ten worktrees off one branch means an
   out-of-scope edit is a merge conflict the coordinator pays for. Discovered work is filed with a
   `discovered-from` edge and mailed, never absorbed into the diff.

## Coordinator mechanics that work

- `podium session status <id>` reports `live/idle` even while an agent is mid-tool-call — the phase
  field lags. Judge movement by the worktree instead: commit count and file mtimes.
- `podium mail send --urgency interrupt` is the only way to reach a child mid-turn; an ordinary message
  waits for its stop hook. Briefs therefore go out as interrupts right after `issue start`.
- `podium issue start` takes model/effort from the issue, so set them with `issue update` first.
- Each new worktree needs its own `bun install`, or `@podium/*` silently resolves from another checkout.

---

## Wave 4 landed: the whole Phase 1 vocabulary chain, plus both kernel state machines

Six streams merged into `issue/279-integration` in one sitting (POD-365, POD-643, POD-366, POD-367,
POD-369, POD-370), all six sessions stopped and their worktrees freed. Integration evidence after the
last merge: typecheck **22/22 uncached**; model+protocol+sync+issue-client **1321 passed**;
server issues/sessions/maintenance + cli **684 passed**; boundaries OK 58 allowlisted / 0 new;
deletion audit baseline exact; no NUL bytes.

Phase 1's exit gate (POD-423) now waits on only POD-368 and POD-363 — POD-303 and POD-304 are done.

### What the merges actually cost, and the rule each one earned

Three of the six conflicted, and every conflict was the same shape: **an ancient merge-base**, so the
three-way diff spanned a file's whole evolution rather than the branch's actual change.

- **POD-369 / `scripts/check-boundaries.ts`** — merge-base was `0e583f44`, the `packages/domain` era.
  Resolved by *verifying the patch was additive* (`git diff --numstat` against the base showed 80 added
  / 2 removed, and both removed lines were already superseded on integration) and then taking
  integration's file plus POD-369's rule. This is the exact merge shape that went wrong on POD-300,
  where "take ours and repoint until the compiler is happy" silently dropped the other branch's
  deletions. **Check what the other side REMOVED before choosing a side; a green typecheck cannot see a
  dropped deletion.**
- **Conflict-hunk stitching broke a file twice.** Concatenating the two sides of a hunk produced an
  unparseable file, because each side's region ended MID-BLOCK with the closing braces sitting in shared
  trailing context — both sides read as brace-balance `+2`. **Reconstruct from the branch versions
  (base file whole + the other side's complete block) rather than stitching markers**, and check brace
  balance before running anything. A related trap: a side's added lines may include an *import member*,
  which belongs in the import list, not appended with the block.
- **POD-370 / `packages/sync/src/index.ts`** — two independent `export *` lines, take both. Then the
  real finding surfaced one layer down (below).

### The collision worth knowing about: two `SyncSpan`s (POD-1146)

POD-369 and POD-370 each declared an interface named `SyncSpan` for the **same ADR 2 D10 unit-of-work
seam**, independently, in `ports.ts` files whose comments cite each other's findings. They are not the
same type — `join(participant)` with an owning `commit()/abort()` versus `onCommit(adopt)`. This is the
parallel-definition drift POD-302 exists to end, arriving *inside the sync kernel*, produced by two
agents who were communicating well. **Two siblings implementing two halves of one contract will design
two whole ports unless the contract is given one owner.**

The barrel now binds the bare name explicitly to the replica's (it *opens* the span; the outbox
*participates*) and exports the outbox's as `OutboxSyncSpan`. The point is that it fails **loudly**:
two `export *`s were TS2308, but binding it the other way would have COMPILED and handed POD-305/373 a
name whose shape does not describe the object they receive.

### Rules the fleet earned this wave

These are in the wave-5 preamble; the short forms:

1. **A mutant that fails to apply is indistinguishable from one that survives** — and prints green. The
   bias runs the worst way: fragile patterns aim at intricate code. Assert matched-exactly-once, hash
   changed, mutant grepped back out, **and name the test you expect to die** — one mutant passed all
   three checks and still changed nothing, having inserted dead code beside its target predicate.
   Re-verification under this protocol found further real survivors in POD-369 (two), POD-370, POD-367
   and POD-365, after each had reported none.
2. **A comment asserting an invariant is evidence someone worried about it, not that it holds.** Pointing
   mutants at long-standing "these must agree" comments found two uncovered invariants, one a visibility
   leak after a rights change.
3. **`toEqual` cannot see the key-presence class** (it treats an undefined-valued key as absent), so it
   loses to the assert-the-whole-payload rule. Use `toStrictEqual` or `Object.keys`.
4. **Branding is compile-time, so the golden wire gate is structurally blind to composition drift.** A
   composed field swapped for a fresh `z.string()` is byte-identical and reds exactly one test out of
   185 — the reference-identity one. Golden-green is not evidence of composition.
5. **Type identity is necessary but not sufficient.** Two fields can be type-identical, encode
   identically, and be different facts. A same-type-therefore-substitute pass typechecks, changes no
   bytes, and is wrong, with nothing for a test to see.
6. **What composition buys at a producer** (POD-1138, reproduced independently three times): through a
   conditional spread every known key's TYPE is still checked, brands included; only key-set membership
   escapes. The exposure is a *stale or misspelled optional key*. `Schema.parse({...})` is a worse rung —
   no annotation at all.
7. **A claim true where you measured it is not yet a rule.** Three corrections this wave were true
   measurements generalised one scope too wide, each caught by someone applying the claim to their own
   surface. Two instruments of the same class corroborate; they do not complement.

### A coordinator mistake worth recording

**I broadcast POD-1138 in a form stronger than its evidence supported** ("a producer with conditional
spreads is not constrained by its annotation at all"). POD-366 disproved it by following my own
re-verify instruction — it mutated a spread mapper *expecting* a survivor and got a kill — then built a
five-case probe; POD-367 and POD-362 reproduced it independently rather than trusting either of us. The
cost of the wrong version would have been churn on shared files mid-fan-out plus a triage criterion
pointing away from the real risk. **A broadcast is an instruction to N agents; over-stating one is a
fan-out-sized error, and the fix is to re-broadcast the narrowed rule, not to let a conservative
overstatement stand.**

Also: my own ruling on the POD-365 sequencing contradiction (I told three siblings to compose *from*
POD-365 and *not to merge* it — instructions that do not compose) reached nobody for a stretch, because
a redeploy fires exactly when a merge lands and drops queued mail delivery triggers with
`Cannot use a closed database`. From the sender's side that is indistinguishable from a target that has
not taken a turn. Filed by POD-367 as POD-1139.

### Coordinator mistake, second occurrence: I closed two issues on a stale tip

An agent that reports done and stays **idle-but-alive keeps committing**. POD-365 mailed its done-report,
I merged the tip it had at that moment, and closed the issue — missing **nine** later commits, including
the two findings it most wanted recorded (a genuine survivor in its own registry suite, and the keyed
registry that turns an omitted aggregate into a compile error rather than a test failure). POD-643 had
one similar straggler, its own correction to a claim it had made to me.

This is the second stale-tip merge of the run; the first cost about an hour of integration
self-contradiction. The fix is mechanical and now standing practice:

> Before closing anything, run `git rev-list --count HEAD..<branch>` and require **0**. "The tip when it
> reported" is not "the tip". `git merge-base --is-ancestor <named commit> HEAD` for any SHA the agent
> cited by name in its report.

What made it cheap to recover: the agents mailed **every increment** rather than batching, and the stop
hook kept redelivering their unreplied mail — which is literally what surfaced the gap. Unreplied mail
redelivering is a feature, not noise.

### Two more findings worth keeping from POD-365's late commits

- **The default-closed fallback made the test for declaration unfalsifiable.** Deleting `Session` from
  `CANONICAL_AGGREGATES` left the suite green, because `aggregateVisibilityOf("Session") === "personal"`
  holds whether or not Session is registered — the mechanism whose purpose is "an undeclared class falls
  closed" is what made "this class IS declared" untestable. **The pass value and the failure value were
  the same string.**
- **A parameterised suite whose parameter list is the thing under test cannot notice its own coverage
  shrinking.** The test count fell 27 → 24 in silence: every `it.each(CANONICAL_AGGREGATES)` case quietly
  stopped covering Session, so three separate checks lost a subject with no red. Pin the membership.
  And the instrument pair that generalises: **a type can see an omitted key; only a runtime assertion can
  see the coverage of a loop over that key set shrinking.** Keying the registry so `name` is the KEY makes
  a mismatch unrepresentable rather than merely tested — strictly better than a passing test — but it does
  not subsume the runtime pin.

### POD-1151: the gate rejected a design that read well (inventory §3 #2 closed)

`IssueRow` is bridged to R1 by the one `toStorage`/`fromStorage` pair (ADR 4 §4.1), with
`StoredIssue` composed from `IssueAggregate` and two real callers (`toWire`, `create`). Three
findings the next agent should not have to re-derive:

- **Naming a gap as a schema can grow the debt you are collapsing.** The first design gave the
  storage gap its own z.object (`readAt`/`tuckedAt`/`pinned`/`repoPath`). It read well, it
  typechecked, every test passed — and `rearch-audit` said `per-user-singletons` 8 → 11. That item
  is a RATCHET with no registry escape precisely so POD-302 cannot close by laundering POD-1076's
  debt. Re-spelling it as a `Pick<IssueRow, …>` **type alias** did not help either: the detector
  reads the picked key literals, correctly. The only real fix was accepting that R1 must not carry
  them — the `Pick` moved into ARGUMENT position, so `IssueRow` stays their one declaration. **A
  new named shape is a new declaration even when every key in it is borrowed.**
- **Read the whole summary line.** The audit's failure wording is "Deletion audit: 2 item(s) GREW",
  three lines below a block of per-site output that looks exactly like the passing output. Scanning
  for "OK" finds nothing either way. It also exits **0** on GREW — the count is the signal, not the
  exit code.
- **The composition claim and the mapping claim need different instruments, and both were
  mutation-checked.** `.extend({ title: z.string() })` on `StoredIssue` kills only
  "title is the field group instance, not an equivalent copy" — no golden fixture moves, because
  branding is compile-time. Swapping `origin`/`audience` in `toStorage` kills only the round-trip
  tests, and ONLY because the fixture holds `'agent'` beside `'human'`; with `'human'` in both it
  is a green mutant. Both mutants: pattern matched exactly once, hash changed, text grepped back
  out, reverted against a backup, named test named in advance.

Still open and handed on, with the measurement: `IssueAggregate` cannot become the service's
in-memory type until **POD-1075** (owner/visibility/attribution columns) and **POD-1076** (per-user
rows) land — `Map<string, IssueRow>` reads three field classes R1 excludes by construction. That is
structural, not effort.
