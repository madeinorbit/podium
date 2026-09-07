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

## How to split the merge across workers

The operator asked whether the merge can be parallelised across gpt-6-astra MEDIUM workers, split by
code area. Answer: the conflict resolution cannot and does not need to be; the semantic review can
and should be.

**A git merge is ONE operation on ONE index.** N agents cannot each resolve conflicts in their own
worktree and have the results combined — that yields N different merge commits, not one merged tree.
One agent owns the merge and the index. That part is not negotiable and not parallel.

**Measured on 2026-09-07 (snapshot — RE-DERIVE at merge time, `origin/dev/mw` moves in steps 1–4):**

- 930 commits ahead of `origin/dev/mw`; it has 11 we lack. Merge base `f910e2671`.
- `git merge-tree --write-tree HEAD origin/dev/mw` → **exit 0, ZERO textual conflicts.**
- **6 files both sides touched** — and they merge cleanly, which is worse than conflicting:
  `apps/daemon/src/grant-apply.e2e.test.ts`, `apps/server/src/modules/sessions/machine-reconciler.ts`,
  `apps/server/src/relay.test.ts`, `scripts/managed-account-spawn.integration.test.ts`,
  `scripts/multi-instance-runtime.integration.bun.test.ts`, `scripts/rearch-audit.ts`
- **72 files only THEY touched**, merging silently: 33 `apps/daemon`, 19 `packages/pty`, 8 `scripts`,
  2 `tests`, 2 `packages/runtime`, 1 `packages/protocol`, plus configs and docs.

**So the whole risk is semantic, and it is concentrated where git will say nothing.** This epic changed
callee contracts from sync to async. Their 33 daemon files and 19 pty files were written against the
OLD contract and will merge without a murmur. That is the POD-3569 class exactly: a call site on one
branch depending on a binding the other branch changed, which no gate on either branch can find.

**The split, one MEDIUM worker per area, all read-only analysis:**

| Worker | Scope | Looking for |
|---|---|---|
| A | `apps/daemon` (33 + `grant-apply.e2e.test.ts`) | calls into contracts this epic made async |
| B | `packages/pty` (19) | same |
| C | `scripts` (8 + its 3 test files) + `packages/runtime`, `packages/protocol`, configs | same |
| D | the 6 both-touched files, `machine-reconciler.ts` first | what each side was trying to make true |

Each reports findings; **I apply them serially** to the single index, then build and typecheck.

**Then verification, parallel by shard** — the five lanes are disjoint and have an explicit file
manifest: `contracts` (99), `store` (94), `services` (139), `boundary` (123), `normalized-wire` (2).
One worker per lane, each reporting newly-red BY NAME against a control, never a count.

MEDIUM effort is right for A–D: it is judgment, not mechanism. Low has repeatedly produced correct
fixes in this epic with no stated verification.

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
  classifier reports zero timeouts however many there are.
- Use a UNIQUE report directory per run (`PODIUM_SERVER_SHARD_REPORT_DIR`). The shard report path is
  shared, so a concurrent run in the same worktree silently OVERWRITES it and you read someone
  else's roster as your own. This was observed on 2026-09-07 and the cause was exactly that — my own
  arms clobbering a worker's `boundary.json`. There is NO evidence of a vitest reporter defect;
  POD-3664 was closed as my contamination. The hazard is real, the diagnosis was not.
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

## Two hazards found while actually running step 7 (2026-09-08)

**`PODIUM_TEST_WORKERS` may already be exported in your shell.** It was set to `1` in the
session that ran the first verification pass, which pins vitest to one worker and changes what
goes red. It came from the environment, not from any command in this document, and `env | grep
-i podium | head` did not show it because `head` cut it off. Check it with `declare -p
PODIUM_TEST_WORKERS`, not with a piped grep, and `unset` it inside the runner so both arms are
identical. A delta gate only means anything when the two arms differ in the code and in nothing
else. The first pass was discarded for this reason.

**Do not run analysis on the box while a gate arm is running.** Timeouts are load-sensitive, so
CPU you add during one arm and not the other manufactures newly-red names that are really just
contention. Sequence the arms, and hold any type-checking sweep until both have finished.

## The sweep that found what the lanes could not

`bun run typecheck` was green across all 26 packages and the tree still contained a guard that
refused every coordinator update. So a clean typecheck is not evidence here, and the lanes only
see assertions that FAIL — an assertion whose subject is a promise passes vacuously against
`toBeUndefined`, `toBeDefined` and `not.toBe`, because a promise is never undefined, always
defined, and never equal to a scalar.

The check that does work is a type-checker sweep: walk every `expect(...)` and ask the checker
whether the ARGUMENT is promise-typed. Over `apps/server` that found 869 sites, of which 817 are
correct (`.rejects` and `.resolves` are supposed to receive a promise), five are deliberate
(single-flight identity assertions, and one `toBeInstanceOf(Promise)`), and 47 were defects.
Twenty-six of the 47 were green and testing nothing.

Two things about running it. **Pass an ABSOLUTE path** — with a relative one
`ts.findConfigFile` resolves nothing, the program has no source files, and it reports a
confident zero. **Canary it** before believing a zero: run it against a checkout that still
contains a defect you have already confirmed, and check it names it. The first run of this sweep
reported zero because of the relative path, and only the canary caught it.

A name-based scan is not a substitute. One over the same tree produced 602 candidates, nearly
all false, because a name cannot tell a sync method from an async one that shares it.
