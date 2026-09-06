# POD-3506 verdict: one production deadlock, eight broken fixtures

Reviewer 2 (fable), independent addendum to the B1 review, 2026-09-06.
Method: static analysis only — the review box's disk is 100% full and this
worktree has no node_modules, so no run was possible. Every claim below is
pinned to a line that can be read, and the causal chain has no timing in it,
so the analysis is conclusive without a run.

## The split, per test

**(a) PRODUCTION deadlock, correctly detected — 2 tests, 1 defect, CRITICAL**

- executor.test.ts:1363 "sends a late external effect to the root, not to its
  released lease" — the test is BYTE-IDENTICAL pre- and post-flip (verified
  against aa7f620bc) and passed pre-flip. Its hang is production code.
- executor.test.ts:1708 "keeps a runner exactly until its delayed effect
  settles" — hangs for the same production reason at its `transact` (line
  1715) before ever reaching its own (also-broken, see below) fixture await.

The defect: the flip commit 9f0d5c33e changed executor.ts `transact`'s
finally from `retire(runner)` to `await retire(runner)`
(executor.ts:701). `retire` awaits `runner.effectsSettled()`
(executor.ts:226-232), and the finally runs INSIDE
`scheduler.run('write', ...)` (executor.ts:692-703), so the single write
slot is held until every external effect of the transaction settles.

Two production consequences, both real, neither test-only:

1. HARD DEADLOCK. An external effect that issues a root store write —
   `executor.drizzle.run(...)` from a post-commit effect, the exact shape of
   the test and of real notification/relay effects — routes through
   `ambientRouter` at root scope to `scheduler.run(lane)`
   (executor.ts:265-275) and queues behind the write slot that
   `await retire` is holding. retire waits for the effect; the effect waits
   for the slot; the slot is released only when retire returns. No timeout
   exists in the scheduler. The write lane wedges permanently.
2. CONTRACT VIOLATION even without the cycle. post-commit.ts:21-24 states
   the waiting rule: the promise `transact` returns "does not wait for
   external effects." With the added await it does — every slow socket or
   notification now serialises the entire store's write lane behind it.

Pre-flip, `retire(runner)` was a deliberate floating promise: retirement is
a background bookkeeping task ("Retirement waits for the effects" — as a
background observer, not on the lease). The awaitify pass had no way to know
that and awaited it. This is the DUAL of rule 53: rule 53 predicts a missing
await deadlocking a concurrency test; here an ADDED await at a deliberately
fire-and-forget site deadlocks production. Both directions typecheck clean.
Suggested spec follow-up: deliberate fire-and-forget sites must be spelled
`void expr` (and ledgered), so no await pass can ever pick them up.

Fix shape (coordinator's to choose): make retirement background again —
`void retire(runner)` or track it on a store-level set awaited by `close()`
— and it must run OUTSIDE `scheduler.run`'s body, or at minimum after the
slot is given back. Note executor.test.ts:1708 ALSO needs its fixture fix
(next section) or it will still hang after the production fix.

**(b) Fixture breakage, production fine — 7 tests, HIGH (against the flip's
test edits, not the store)**

The flip's await pass added `await` at the CREATION site of promises these
tests deliberately hold un-awaited while parked on a barrier, releasing the
barrier later. Awaited at creation, the test blocks before ever reaching
`release()`. Verified in `git diff aa7f620bc..HEAD` for both files; every
hunk is below.

- state-models.test.ts:56-57 (`first`/`second` = await registry.update) —
  "refuses the second install…"
- state-models.test.ts:85 (`failing`) — "leaves the installed row untouched…"
- state-models.test.ts:110,116 (`write`/`read`) — "keeps an in-memory read…"
- state-models.test.ts:141,150 (`failing`/`read`) — "…ENCLOSING transaction
  rolls back"
- state-models.test.ts:169,176 — "…write rolls back, in flight or after"
- state-models.test.ts:199,205 (`first`/`second` = await mutex.run) —
  "serialises mutations…"
- service-span.test.ts:331,338 (`span`/`read`) — "concurrent reader…"
- executor.test.ts:1725 (`settled = await effectsSettled()` before
  `parked.release()`) — the fixture half of "keeps a runner…".

These edits pass the mechanical rule's LETTER ("differs only by await") while
changing what is asserted — the held promise IS the interleaving. Notably
commit 10efe45a4 "preserve executor interleavings" fixed exactly this in
executor.test.ts, but state-models.test.ts and service-span.test.ts got the
blanket pass in 9f0d5c33e and were never given the same repair. Fix: revert
the creation-site awaits (the later `await first` / `Promise.all` lines,
still present, do the real awaiting). The mechanical-rule wording should be
amended: an await added at a site whose promise is stored and awaited later
is an assertion change, not a mechanical edit.

## Dynamic confirmation (2026-09-06, after the box was repaired)

The environment was fixed and every claim above was re-verified by running the
tests on this worktree (eed1b7913 + this doc; the POD-3506 fix has not landed).
All nine attributions reproduce, each as a hang to the vitest timeout:

- executor.test.ts "sends a late external effect to the root, not to its
  released lease" — timed out (production deadlock, section a).
- executor.test.ts "keeps a runner exactly until its delayed effect settles" —
  timed out (production deadlock first, fixture second, section a).
- state-models.test.ts: all six cited tests timed out; the other tests in the
  file pass. service-span.test.ts "does not let a concurrent reader see the
  span's uncommitted stage" timed out. 7 failed | 6 passed across the two
  files — exactly the fixture set in section b, nothing more.

No hang outside the attributed set appeared in these three files. The "no
TENTH hang" question below still needs the post-fix run, since a later hang
can be masked by an earlier one within a test.

## Coverage caveat

I attributed the two production-shaped hangs by reading the code; the seven
fixture attributions are certain from the diffs alone. What I could NOT do
without a runnable worktree: confirm no TENTH hang appears once these nine
are fixed, or bisect whether cd71c4953/9c606e4b6 interact. The POD-3506
worker should re-run the lane after each of the two fixes separately —
fixture reverts first (cheap, isolates the production fix's effect on the
remaining two).
