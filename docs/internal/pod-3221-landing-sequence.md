# POD-3221 — the landing sequence

Authorised by the operator. Runs ONLY when every flip-blocking sub-issue is closed and the
integration branch is ready to soak on the primary instance. Not before.

`ludovico` is reachable over SSH. `flatblock` is this box.

## The PHASE ORDER of the whole epic, which is not the same as the steps below

Written down because I got it wrong three times in a row from memory, each time putting Turso
earlier than it belongs. The operator corrected it three times. READ THIS RATHER THAN RECALLING IT.

1. **Finish the flip work.** Every sub-issue that blocks POD-3649. That is the only thing gating
   the merge.
2. **DO THE MERGE.** The nine steps below. Nothing else is a prerequisite for it.
3. **Review and tests.** The post-flip checkpoint (POD-3287), the gates run properly against the
   merged result.
4. **Fix the issues that review and testing find.** Whatever comes out of step 3.
5. **Later-phase fixes.** The known post-phase work: POD-3572 (pre-existing failures), POD-3654
   (watchdog default invariant), POD-3522 (the four apps/mobile typecheck errors).
6. **ONLY THEN Turso.** POD-3270 (durability port), POD-3271 (database import), POD-3272 (backend
   enablement), POD-3343 (delete the append spike). Then the post-flip-and-Turso review (POD-3296)
   and the epic close checkpoint (POD-3288).

**Turso is LAST.** It does not gate the merge and it never did: POD-3649 has no blocking edge to any
Turso issue, and I have verified that by resolving its edges rather than assuming. Listing the Turso
phase anywhere before step 6 — including in a "what is left" summary where the reader will take the
order as a sequence — is wrong and misleads the operator about when the branch can land.

## The steps, in order

1. **ludovico: refresh main.** `git pull --rebase origin main` into local `main`.
2. **ludovico: reconcile dev/mw onto it.** Rebase `dev/mw` onto the new local `main`.
3. **ludovico: take origin's dev/mw too.** `git pull --rebase origin dev/mw` onto that reconciled
   `dev/mw`. Either order works — origin first then main, or main first then origin — as long as
   both are in before the push.
4. **ludovico: push dev/mw.** Force-push if the rebase rewrote history.
5. **flatblock: pull the new dev/mw.**
6. **flatblock: reconcile the epic branch with it.** Try a rebase first. If the conflict count makes
   a rebase unworkable, MERGE `dev/mw` into the integration branch instead.
7. **flatblock: verify it actually runs**, and is ready for the operator to test.
8. **flatblock: push the reconciled branch to `origin/dev/mw`.** Force-push if needed.
9. **ludovico: pull the new `origin/dev/mw`.**

## The instruction that matters most

**DO NOT MECHANICALLY MERGE.** Look at every conflict and make sure the INTENT of each change is
preserved. This epic has already produced the failure that warning describes, twice:

- POD-3511 × POD-3552 conflicted in twelve files and `offer.test.ts` had 31 awaited call sites on
  one side and 26 un-awaited on the other. **Both were correct on their own base** — one branch had
  the async offer store, the other did not. Taking either side wholesale gave a file that compiled
  and looked right: theirs left 26 floating promises and deleted three regression tests, ours lost
  the async typing and left five staleness cases red over a working fix. The only correct resolution
  was the union of three independent things, none of which subsumed another.
- POD-3569 existed **only in the pair**: POD-3552 fixed an ownership binding, and the call site that
  depended on it lived on POD-3511's branch. Neither side was wrong alone and no gate on either
  branch could have found it.

So at every conflict ask: *what was each side trying to make true?* A conflict where both sides
compile is the dangerous one. Files only ONE side touched merge silently and are not safe either —
that is where a layer of one design lands underneath another.

## What "verify it runs" means here

The gate is a **DELTA** gate. `bun run test` and `lint:boundaries` cannot go green on this base and
never could, so an absolute green is not the bar and never was.

- Criterion: **ZERO NEWLY-RED BY NAME** against a control, plus a clean `bun run typecheck` apart
  from the four known `apps/mobile` errors (POD-3522, post phase, out of the gate).
- Compare **names, not counts**. A count can rise because a fix WORKS — a test that used to time
  out before reaching its assertion now reaches it and fails there.
- Capture BOTH reporters. The JSON reporter DESTROYS timeout messages (rule 63), so a JSON-only
  classifier reports zero timeouts however many there are. And pass the reporters EXPLICITLY on the
  command line (`--reporter default --reporter json`) with a unique report directory: config-only
  JSON reporting was observed keeping only ONE file's results out of four while the console printed
  all 59 tests (POD-3664). A report holding one file of four does not fail — it produces a short,
  plausible roster in which every missing name reads as "not failing".
- VERIFY IN YOUR OWN DETACHED CHECKOUT, at the committed SHA, with a clean working tree you have
  confirmed. Never run a verification arm inside a live worker's worktree: HEAD does not pin the
  tested content, and a worker mid-mutation will hand you its mutant while `git rev-parse HEAD`
  still reads correct. I did exactly this on 2026-09-07 and reported a worker's own mutation back
  to it as a failure of its fix.
- Read the exit code AND the assertion results; they are independent (rule 64).
- Regenerate the shard manifest (`bun scripts/server-test-shards.ts --write`) before believing any
  lane result — a new test file in no shard passes directly and never runs in the lanes (rule 41).

## Before starting

Push the integration branch to origin and confirm the remote SHA matches local. Everything after
step 4 rewrites history somewhere; the backup is what makes that safe.
