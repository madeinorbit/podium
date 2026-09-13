# PDM-389 delivery receipt — lease exit codes and repo scope

**Issue** podium-cloud#389 (PDM-389), retitled from "Lock acquire exits 0 on failure".
**Date** 2026-09-13.

## Refs I resolved myself

| What | Value | How |
| --- | --- | --- |
| OSS epic tip `issue/pdm-107-multi-user` | `9b4986eaaddef38594c5742f9335d58c35245cc9` | `git ls-remote origin` |
| Cloud epic tip `issue/107-multi-user-architecture` | `2644d712d26f1b204d775c8445bf3eab1962525e` | `git ls-remote origin` |
| My OSS branch | `issue/pdm-389-lease-exit-codes`, cut from `9b4986eaa` | `git worktree add -b` |
| My commit | `bbd17c350` | `git commit` |
| Installed CLI under test | `podium 0.1.1-dev.139+5b80acc`, built from `5b80acc3d` today 10:52 | `podium --version` |

Placement, both directions as the addendum asks:
`git merge-base --is-ancestor HEAD origin/issue/pdm-107-multi-user` -> **on the epic line**;
`git rev-list --count HEAD..origin/issue/pdm-107-multi-user` -> **0 behind** at branch time.

`5b80acc3d` is **not** an ancestor of OSS `main`. Worth knowing: the binary every agent is
running is not built from a commit on the main line.

## The brief was wrong about which issue this is

cloud#389's **description field is a byte-for-byte copy of cloud#323** "Uncensused epic store
members", which is `stage=done`. The title, the branch name
(`issue/389-lock-acquire-exits-0-on-failure`) and the CONSOLIDATED section of the brief are all
the lock-acquire defect. I treated the store-census prose as a stale paste and worked the lock
defect. Corroboration arrived by accident: `scripts/store-coverage-census.test.ts` passes 8/8 at
my tree, so cloud#323's work did land.

## Verification first — three of five cases do not reproduce

The brief says to establish the defect still reproduces before repairing it. It does not, mostly.

### Case 1 — timed out, place gone, exit 0. **DOES NOT REPRODUCE.**

Live, against a real foreign holder (the coordinator's own session `ab39fce8` holding the cloud
repo's `test:heavy`):

```
$ podium lock acquire test:heavy --ttl 1m --wait --timeout 40s
podium lock: waiting up to 40s - queued for 'test:heavy' at position 1; held by ab39fce8 ...
timed out after 40s waiting for 'test:heavy'; left the queue - nothing will be granted to you now
EXIT_CODE=4
```

The *sentence* the report quoted is exactly right. The *exit code* is stale: `lock-cli.ts` already
defines `EXIT_QUEUED=3`, `EXIT_WAIT_TIMEOUT=4`, `EXIT_INTERRUPTED=130`, and `cliMain` assigns them.
Fixed before I arrived. **Not touched by this change.**

### Case 2 — waiter died early, place kept, exit 0. **REPRODUCES IN SUBSTANCE, NOT IN EXIT CODE.**

Traced, not measured — I could not induce a relay timeout on demand, and I am labelling this
author-traced rather than reproduced. `apps/daemon/src/agent-relay.ts:61` **resolves**
`{ok:false,error:'agent relay timed out'}`; `packages/issue-client/src/client.ts`'s relay proxy
turns `!body.ok` into a **thrown** Error. So the exit code is **1, not 0**.

But the substance of the report is real and worse than reported: the throw leaves `runLockCli`
from inside the `--wait` poll loop and **bypasses `leaveQueue` entirely**. The waiter dies, the
queue place survives, and the only thing printed is a bare `agent relay timed out` that says
nothing about the place. `lock-cli.ts`'s own header contract reads "both endings, plus
SIGINT/SIGTERM, LEAVE the queue before returning, and say which happened" — a transport failure
is a **third ending the contract never had**. **Fixed here.**

### Case 3 — a guard grepping for "acquired". **DOES NOT REPRODUCE IN SHIPPED TOOLING.**

`scripts/validation-admission.ts` acquires with `--json` and tests `response.data.granted === true`,
not a string match. The queued acquire text contains no "acquired" at all — visible in the case 1
output above. This was an agent-authored guard, not a CLI defect. **Not touched.**

### Case 4 — acquire on a lock you do not hold silently queues. By design, and `EXIT_QUEUED=3`
distinguishes it. **Not touched.**

### Case 5 — lock refuses from an unregistered checkout. **REPRODUCES EXACTLY.** Fixed here.

The proof the brief demanded — create a detached scratch worktree and run a lane in it:

```
$ git worktree add --detach <scratch>/oss-base 89574f1c8
$ cd <scratch>/oss-base && bun scripts/test-heavy.ts -- bash -c 'echo LANE-RAN'
podium lock: invalid args for cancel: repoPath: Required
EXIT_CODE=1          # and LANE-RAN never printed. The lane did not run.
```

Two things the brief did not have, both of which change the fix:

1. **`--repo-path` already exists and works.** `podium lock status test:heavy --repo-path
   /home/mgw/src/other/podium` exits 0 from `/tmp`. The brief proposed adding it.
2. **The error names the wrong verb.** `acquire` runs with `--json`, so its failure leaves on
   *stdout*, and `acquireLease`'s early return reads that and drops it. The only message reaching
   the operator is the follow-up `cancelWaiter`'s stderr — so a missing repo reads as `invalid args
   for CANCEL`. That is most of why this looked like a mystery rather than a missing row.

## NEW FINDING — the `test:heavy` lease is repo-scoped, so OSS and cloud agents never serialise

Measured at the same instant:

```
$ podium lock status test:heavy --repo-path /home/mgw/src/other/podium
'test:heavy' is free
$ podium lock status test:heavy --repo-path /home/mgw/src/other/podium-cloud
'test:heavy' held by ab39fce8 ... expires in 26m50s
```

The help text confirms it — "Without a name, lists all locks **in the repo**" — and the locks table
is keyed `(repo_id, name)`.

The epic addendum tells every agent to serialise heavy lanes on `podium lock acquire test:heavy`.
An agent running that from an OSS checkout and an agent running it from a cloud worktree take **two
different leases** on the same 7-core box, each correctly reporting that it holds `test:heavy`.
This is the same failure class as the rest of this issue — a lease that reports success and
protects nothing — and it degrades exactly the evidence the epic depends on.

I did **not** fix this: the fix is a coordination decision (one canonical repo for the lease, or a
machine-global lease name), not a unilateral one. Raised with the coordinator.

## What I changed

`apps/cli/src/lock-cli.ts`

* `repoInferenceCandidates(cwd, runGit)` — new export. `git worktree list --porcelain`'s first
  entry is always the **main checkout**, which is the path the tracker has a row for. The cwd is
  still tried first, so a registered checkout costs exactly the one call it always did; the main
  checkout is consulted only when that came back empty. Git failing yields no extra candidate
  rather than an error — `--repo-path` stays the explicit answer for a tree git cannot place.
* The `--wait` loop now survives a transport failure **once a place is held**: narrated and retried
  on the ordinary cadence, so `--timeout` keeps meaning what it said. Before the first queued round
  there is nothing to protect, so a transport failure there still fails fast — `--wait` against a
  dead server must not spin to a deadline.

`scripts/validation-admission.ts`

* `reportAcquireFailure(name, stdout, log)` — new export. Prints acquire's own `--json` error
  before the follow-up cancel runs, so the operator sees the verb that actually failed.

## Evidence

| Command | Exit | Result |
| --- | --- | --- |
| `bun run --cwd apps/cli test src/lock-cli.test.ts` | 0 | 57 passed (was 49) |
| `bun run --filter @podium/cli typecheck` | 0 | clean |
| `bun run --filter @podium/scripts typecheck` | 0 | clean |
| `bun run --filter @podium/cli test` (mine) | 1 | 4 failed, 736 passed |
| `bun run --filter @podium/cli test` (base `9b4986eaa`) | 1 | 4 failed, 728 passed |
| `bun run --filter @podium/scripts test` (mine) | 1 | 31 failed, 1478 passed |
| `bun run --filter @podium/scripts test` (base `9b4986eaa`) | 1 | 30 failed, 1476 passed |

**Name diff, which is the artefact — a count is not.**

* `@podium/cli`: **new at my tree: none. Fixed by me: none.** The same 4 inherited reds
  (`podium telemetry (status) > shows the endpoint reports would go to`; `resolveModePlan > carries
  the durable bind host into every server launch plan`; two `server transfer role reconciliation`
  rows). None is in `lock-cli.test.ts`.
* `@podium/scripts`: one name appeared at my tree, `the committed census describes the tree > has a
  row for every public repository member, and none for a member that is gone`. **It is not mine and
  it is not a content failure** — it is `Error: Test timed out in 20000ms` at 20418ms, under lane
  contention. Re-run alone at my tree: `bun run --filter @podium/scripts test
  store-coverage-census.test.ts` -> **8 passed, exit 0**. I touched nothing that census scans
  (`apps/server/src/store/*`); my change is in `apps/cli` and `scripts`. So the honest diff is
  **new: none, fixed: none**, with a load-induced flake named.

**Added test names (8), so a name diff cannot mistake them for anything else. None renamed, none
removed — verified by `comm` on the sorted `it(` names at base and head, empty on the removed side.**

```
offers only the cwd from the main checkout itself - no second round trip
offers only the cwd when git cannot answer at all
offers the main checkout as a second candidate from a linked worktree
resolves repoPath from the main checkout when the cwd is unregistered
retries a relayed error instead of dying, and honours the full --timeout
still fails fast when the very first round cannot reach the server
still fails when neither the cwd nor the main checkout is registered
takes a grant that lands on a round after a transport error
reports acquire's own --json error, not the follow-up cancel's
falls back to the raw stdout when the answer is not JSON
still says the lease was refused when there is no detail at all
```

(Eleven names; eight in `apps/cli`, three in `scripts`.)

## Proved by deliberate break

Each guard reverted in turn, the named tests reddened for the right reason, each restore verified
**byte-identical** with `diff -q`, not by eye.

| Break | Tests that reddened, by name |
| --- | --- |
| `repoInferenceCandidates` returns `[cwd]` | `offers the main checkout as a second candidate from a linked worktree`; `resolves repoPath from the main checkout when the cwd is unregistered` |
| wait loop rethrows every transport error | `retries a relayed error instead of dying, and honours the full --timeout`; `takes a grant that lands on a round after a transport error` |
| `reportAcquireFailure` prints the old wrong-verb line | all three `a refused lease says which verb refused it, and why` rows |

Each fix also carries its **counterfactual**, so the positive test cannot pass for the wrong reason:
`still fails when neither the cwd nor the main checkout is registered` (the fallback must not invent
a repo) and `still fails fast when the very first round cannot reach the server` (the retry must not
swallow a dead server).

## End-to-end, in the shape that actually failed

Same directory, same command, unfixed binary vs fixed source:

```
$ cd <scratch>/oss-base                       # detached, unregistered
$ podium lock status test:heavy               # installed binary
podium lock: invalid args for status: repoPath: Required          exit 1

$ bun --conditions @podium/source <pdm-389>/scripts/cli.ts lock status test:heavy
'test:heavy' is free                                              exit 0
```

And the lane itself, with the fixed CLI first on `PATH`:

```
$ cd <scratch>/oss-base
$ PATH=<shim>:$PATH bun scripts/test-heavy.ts -- bash -c 'echo LANE-RAN'
acquired 'test:heavy' (expires in 30m0s)
LANE-RAN
released 'test:heavy'
EXIT=0
```

Acquired, ran, **released** — verified afterwards with `podium lock status`: free, no stranded
lease. The attribution standard is available again for heavy lanes.

## What I did NOT do

* Did not fix the repo-scoped lease (new finding above) — it is a coordination decision.
* Did not touch cases 1, 3 or 4; they do not reproduce.
* Did not reproduce case 2's relay timeout live — traced through the source and labelled as traced.
* Did not rebuild or reinstall the `podium` binary, so **this fix does not reach agents until the
  binary is rebuilt**. Proven against source; the installed binary is still unfixed.
* Did not push to the integration refs.
* Did not regenerate `apps/server/test-shards.json` — I added no file under `apps/server`.

## Lease discipline

One lease taken, for the typechecks and the four full lanes: `podium lock acquire test:heavy --ttl
15m --note "PDM-389 typecheck" --wait --timeout 10m` -> granted; renewed by hand once to 20m;
`podium lock release test:heavy` -> `released`, and `podium lock status` afterwards reads
`'test:heavy' is free`. I hold no place.
