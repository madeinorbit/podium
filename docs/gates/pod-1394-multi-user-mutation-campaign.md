# POD-1394 — Multi-user mutation probe campaign: transcript

**Candidate SHA:** `4b5c3a43` (this branch, merging integration `80989567`). The campaign was first
run at `d8fba769` and **re-run in full here** — every mutant below was executed at `4b5c3a43`, so no
condition describes a different tree from any other.
**Date:** 2026-08-02

## Status against POD-425's refusal (`dd017634`)

| Ground | Disposition |
| --- | --- |
| 1 — the two survivors are hard dependencies | **Stated as BLOCKERS below, not as results.** POD-1410 and POD-1412 are open; this campaign cannot close the gate while they are. |
| 2 — five compound clauses unmutated | **Done.** `N1`–`N5` below, one production mutant per named clause. |
| 3 — raw per-mutant JSON in scratch | **Done.** `docs/gates/pod-1394-records/` — 25 records with command, exit, full diagnostic, and original/mutated/restored sha256, plus the edit set and both batch drivers. |
| 4 — re-request review with the SHA | Requested at `4b5c3a43`. |

## BLOCKERS — the gate cannot pass on this campaign alone

Two production violations survive at this candidate. They are **dependencies of the gate**, not
findings of the campaign:

- **POD-1410** — `C3b`. The session-expiry check can be deleted from the transport auth gate and
  29 tests stay green. `requestUserId` / `isRequestAuthed` have **zero test callers anywhere**;
  `auth-route.test.ts:279` asserts the *store predicate*, never the gate that consults it.
  *A guard that no test invokes is indistinguishable from a guard that was deleted, from the suite's
  point of view.*
  This is **more severe than a mis-aimed guardrail**: `C1b` was eventually caught by other suites, so
  a guardrail existed and was pointed slightly wrong. Here no lane can catch it, because nothing
  calls the function.
- **POD-1412** — `C6c`. `STREAM_QUEUE_MAX_FRAMES` can go 64 → 1,000,000 with 88 tests green. The
  constant has exactly two references in the repo — its definition and its one use. The test that
  looks like coverage drives a socket whose `send` **fails** and counts evictions; it never
  exercises queue depth.

## What this transcript is, and what it deliberately is not

POD-425 refused detector-local evidence: a guardrail proven against a fixture string in its own test
file has been proven to reject **a string**. Every mutant below is planted in **production code** —
no fixture directories, no `--probe` mode, no test file — and graded on whether the real guardrail
refuses it *and names the thing that was broken*.

Per the gate's standard (`0c40250b`), each row names the guardrail **half** that actually walked the
property. Where a source-text audit and its running-object test disagree, the test is cited.

## Protocol, enforced mechanically

Every mutant went through one runner (`pod-1394-mutate.py`) that ABORTS rather than reports:

1. `git status --porcelain` empty before the mutation.
2. Each anchor matches **exactly once** in the target file, with its line recorded.
3. A **breadcrumb** (mutant id, target, original sha256, original bytes) is written **before** the
   file is touched — see P2.
4. Apply; assert the sha256 **moved**; grep back. For a replacement: the new text is present and the
   anchor is gone. For a **deletion**: the anchor is ABSENT — see P1.
5. Run the guardrail; record exit code, elapsed, and the diagnostic.
6. Restore; assert sha256 **identical**, every anchor count back to 1, `git status` empty. Only then
   is the breadcrumb cleared.

SIGTERM/SIGINT/atexit handlers restore before exit, and `--restore-orphans` replays any breadcrumb,
so recovery does not require the process that made the mess.

## Verdict — one line per mutant, all at `4b5c3a43`

| Mutant | Cond | What was planted | File:line | Exit | Result | Diagnostic |
| --- | --- | --- | --- | ---: | --- | --- |
| `C1` | 1 | second registry INSIDE PresenceRouting | `apps/server/src/gateway/presence-routing.ts:21` | **1** | CAUGHT | shares one registry with the principal feed and derives all leaves on disconnect — expected 1 to be 2 |
| `C1b` | 1 | second registry AT THE COMPOSITION ROOT | `apps/server/src/relay.ts:536` | **1** | CAUGHT | routes the open/result family only through session-room subscriptions (+3) |
| `C2b` | 2 | personal-not-granted flipped to visible | `packages/sync/src/feed/visibility.ts:316` | **1** | CAUGHT | a principal with no grant received the row — the filter does not filter |
| `C3a2` | 3 | principal minted from hello.clientId before dispatch | `apps/server/src/gateway/client-mux.ts:288` | **1** | CAUGHT | mints it from the connection, never from a frame body — expected 'client:attacker' to be 'client:c0' |
| `C3b` | 3 | session-expiry check DELETED from the auth gate | `apps/server/src/auth-route.ts:48` | **0** | SURVIVED | **no test caller exists** — POD-1410 |
| `C4a` | 4 | throughSeq made optional on the batch arm | `packages/sync/src/authority/scoping.ts:67` | **1** | CAUGHT | `throughSeq` is not a required `number` on the batch arm |
| `C4b2` | 4 | watermark taken from visible data, not the evaluated range | `packages/sync/src/authority/scoping.ts:150` | **1** | CAUGHT | the suppressed range was NOT certified to the principal who could not see it |
| `C4c` | 4 | evict replaced by remove on the anchor path | `packages/sync/src/authority/scoping.ts:230` | **1** | CAUGHT | a visibility change is DERIVED, and it is never a remove (D14) |
| `N1` | 4 | feed epoch RE-MINTED instead of read from the store | `packages/sync/src/feed/identity.ts:141` | **1** | CAUGHT | mints on first use and PERSISTS, so a second registry over the same store agrees (+2) |
| `C5a` | 5 | verb check dropped: anything that can SEE may USE | `apps/server/src/machine-access.ts:305` | **1** | CAUGHT | a `see` grant is not enough for a `manage` command (+6) |
| `C5b` | 5 | fleet fan-out loses its per-machine `use` filter | `apps/server/src/modules/fleet/handlers.ts:205` | **1** | CAUGHT | `scanReposAll()` with no `mayUse` predicate scans every online machine |
| `N2` | 5 | delegation human read off the LEAF, not the chain ROOT | `apps/server/src/command-principal.ts:224` | **1** | CAUGHT | an agent chain carries exactly ONE human, taken from the ROOT and not the leaf |
| `C6a` | 6 | room join no longer visibility-gated | `packages/protocol/src/planes/stream-port.ts:110` | **1** | CAUGHT | joins are visibility-gated and default-closed (D14) (+3) |
| `C6b` | 6 | presence state outlives the connection | `packages/protocol/src/planes/stream-port.ts:197` | **1** | CAUGHT | drops all presence state when the connection goes — nothing outlives it (D12) |
| `C6c` | 6 | outbound stream queue bound 64 -> 1,000,000 | `apps/server/src/gateway/presence-routing.ts:27` | **0** | SURVIVED | **queue depth untested** — POD-1412 |
| `C7a` | 7 | absent refusal leaks the machine NAME | `apps/server/src/machine-access.ts:326` | **1** | CAUGHT | a colleague's invisible machine and an id that never existed refuse IDENTICALLY |
| `N3b` | 7 | refused subscription EMITS a reason code | `packages/protocol/src/planes/control-port.ts:125` | **1** | CAUGHT | admits an entity only when the resolver says so, and never says why |
| `C8a2` | 8 | unclassified entity kind resolves VISIBLE | `packages/sync/src/feed/visibility.ts:291` | **1** | CAUGHT | an UNCLASSIFIED entity kind is invisible — and says so, not 'personal' |
| `C8b` | 8 | real aggregate points at a nonexistent matrix row | `packages/model/src/aggregates/registry.ts:153` | **1** | CAUGHT | every registered row id is really on the matrix — with the backstop shown firing |
| `N4` | 8 | a `personal` row widened to `deployment-substrate` | `packages/model/src/annotations/matrix.ts:2661` | **1** | CAUGHT | keeps the tenant-visible floor small and deliberate |
| `C9a` | 9 | SYSTEM writer attributed as a user | `apps/server/src/command-principal.ts:173` | **1** | CAUGHT | a system write is attributed `system` with no human (D17.5) |
| `C9b` | 9 | agent attribution drops its on-behalf-of half | `apps/server/src/command-principal.ts:171` | **1** | CAUGHT | attribution is a PAIR … never collapses them |
| `N5` | 9 | SYSTEM_WRITER_RULE loses its no-widening clause | `packages/model/src/annotations/ownership.ts:302` | **1** | CAUGHT | states the system-writer rule on EVERY row a system principal may write — expected … to match /never widen/ |
| `C10` | 10 | instance_id column planted on the sessions table | `apps/server/src/migrations/schema.ts:33` | **1** | CAUGHT | instance-partitions baseline 0 -> now 1 … sessions.instance_id (column) |

All 24 rows restored to **byte identity**, every anchor count back to 1, `git status --porcelain`
empty after each — asserted by the runner, which aborts rather than reports.

**No guardrail drift.** All 19 original mutants were re-run at `4b5c3a43` after first being measured
at `d8fba769`, 41 commits earlier. Every verdict is identical and every anchor still matched exactly
once. The two survivors are therefore not artefacts of a stale tree.

## The five compound clauses (POD-425 refusal ground 2)

| Clause named in the refusal | Mutant | Independently mutable? |
| --- | --- | --- |
| global sequence / feed epoch / healing, and mid-session grant/revoke | `N1` (epoch re-minted), plus `C4a` `C4b2` `C4c` | yes |
| live agent delegation, revoke-at-next-apply, machine migration/fact scoping | `N2` (human off the leaf), plus `C5a` `C5b` | yes |
| subscription / join / invisible-target oracle equivalence | `N3b` (refusal emits a reason), plus `C6a` `C7a` | yes |
| the deliberately small tenant-visible floor | `N4` (a `personal` row widened to substrate) | yes |
| SYSTEM scope and no-widening beyond attribution helpers | `N5` (rule loses its no-widening clause) | **partly — see below** |

**`N5` is a declaration mutant, and its limit must be stated.** `SYSTEM_WRITER_RULE` is production
data — the declared rule every row carries verbatim — and the matrix test asserts its content. So
"the declaration lost its no-widening clause" is mutation-provable. What is **not** independently
mutable at this candidate is the *runtime* no-widening behaviour: `FeedPrincipal` has only `user` and
`agent` arms, so a SYSTEM principal never reaches `GrantEdgeVisibilityPolicy.decide` and there is no
runtime path on which a system write could widen a slice. The clause is enforced by construction plus
a declaration check, not by a runtime guard. That is a defensible design, but the gate should record
that `N5` proves the *declaration* is checked and **not** that a runtime widening path is guarded —
because there is no such path to guard today, and there will be one the day `FeedPrincipal` grows a
`system` arm.

## Three mis-aims and one equivalent mutant

A green from a mis-aim reads exactly like a pass. Recorded with the re-aim:

| Mutant | Why the green meant "missed" | Re-aimed as |
| --- | --- | --- |
| `C3a` | Reassigned `conn.principal` **after** `dispatch()` had already handed the port the original — the guardrail never walks that path. | `C3a2` → exit 1 |
| `C4b` | `?? throughSeq` fallback preserved the **fully suppressed** batch, which is exactly the case the check exercises. | `C4b2` → exit 1 |
| `C8a` | Aimed right, run scoped to `packages/sync/src/feed`, which does not hold the assertion. | `C8a2` → exit 1 |

**`N3` was an EQUIVALENT MUTANT, and its survival is not a finding.** Changing
`canSee(...) !== true` to `=== false` in `ControlPlanePort.admitEntity` is observationally identical
for every input the suite supplies: all test resolvers return strict booleans. The two forms differ
only for a non-boolean answer. Reporting that survival as a coverage gap would have been wrong, so it
is recorded as what it is. It does leave a true but narrow observation: the **defensive** half of the
default-closed idiom — `!== true` rather than `=== false`, used identically at `control-port.ts:126`,
`bulk-port.ts:64` and `stream-port.ts:110` — has no test behind it at any of the three ports. That is
worth a test, not a blocker. The real clause was then probed by `N3b`, which fired.

A fourth error was instrumental rather than aim: `C4c`'s first invocation ended in `| tail -25`, so
the recorded exit was `tail`'s `0`. Re-run unpiped → exit 1. **A piped guardrail command reports the
pipe.**

## Process findings — the runner's own blind spots

These are not code defects. They are defects in *how the campaign proves things*, and each was found
by the campaign turning on itself mid-run.

### P1 — a deletion mutant can SELF-CERTIFY

The runner's grep-back originally asserted *"the replacement text is present in the file"*. For a
**deletion** the replacement is the empty string, and `"" in text` is **vacuously true**. A deletion
that never applied would therefore have passed grep-back and gone on to report its guardrail's green
as evidence — the precise failure grep-back exists to prevent, reintroduced by the check itself.

Found when `C3b` (a deletion) crashed the runner on an unrelated `IndexError`. Fixed mid-campaign:
for an empty replacement the runner asserts the **anchor is ABSENT**; for a non-empty one it asserts
the replacement is present **and** the anchor is gone (unless the anchor is a substring of the
replacement). `C3b` was then re-run under the corrected runner, so POD-1410 rests on a deletion that
provably applied.

### P2 — the `finally` block protects a RUN, not a SESSION

The runner guarantees a mutant never outlives its run. It does **not** guarantee a mutant never
outlives the *agent*. During `C1b-full` — an 18-minute full-lane run — the worktree carried a live
mutant in `relay.ts` for the whole duration. Had the session been killed in that window, the mutant
would have survived in the tree with nothing scheduled to remove it, and a branch carrying a live
mutant looks exactly like a branch carrying a bug.

It did not happen here: `C1b-full` completed (exit 1, 1098.8 s) and its `finally` restored
`relay.ts` to sha256 `ce4c4e7b1989...`, anchor count 1, `git status` empty — re-verified afterwards
from a clean session. But the hazard is structural and scales with run length: the longer the
guardrail takes, the wider the window.

**Mitigations for the next campaign of this shape:** keep long full-lane runs to the few questions
that genuinely need them (this campaign used one); prefer scoped runs, which shrink the window from
minutes to seconds; and write the mutant's identity and original hash to disk *before* applying —
the per-mutant JSON record here is written only on success, so a killed run leaves no breadcrumb
naming what is still applied.

### P3 — a piped guardrail command cannot produce evidence

`C4c`'s first invocation ended in `| tail -25`, so the recorded exit code was `tail`'s `0` while the
guardrail underneath had failed. Re-run unpiped as `C4c-runtime` -> exit 1. Any guardrail whose exit
code passes through a pipe is reporting the pipe.

## Reds observed that are NOT this campaign's

- `apps/server/src/modules/sessions/oracle-authz.test.ts` fails on a **clean tree** at this candidate
  (`expected 'no such procedure: sessions.handoff' to be 'sessions.handoff is not permitted via
  relay'`) — POD-1386's known defect, and `handoff` is present at
  `apps/server/src/modules/issues/relay-gate.ts:47` here. Note it did **not** fail in the clean
  full-lane baseline: its verdict is **order-dependent**, green in the full lane and red standalone.
- `scripts/rearch-audit.test.ts` "CLI exit codes" ×2 timed out (40 s / 20 s) inside the full-lane run
  under host load 47. The assertions never ran; this is the host, not the candidate.
- The clean-tree baseline `bun run test:unit` exited 1 on
  `Worker exited unexpectedly with signal SIGILL` killing
  `apps/server/src/modules/sessions/publish-worker-integration.test.ts`. Standalone that file is
  **11/11, exit 0**. This is why mutants are graded against **scoped runs of the same CI command**
  with a clean green established immediately before, and the full lane reserved for
  "does anything at all catch this".

## Closing state

| Fact | Value |
| --- | --- |
| Candidate | `4b5c3a43` (integration `80989567`); campaign first run at `d8fba769`, re-run in full here |
| `git status --porcelain` after every mutant | empty |
| Live config mtime, before and after | `2026-08-02 11:07:07.128162673 +0200` — **unchanged** |
| `~/.podium` | never written; `PODIUM_STATE_DIR` redirected to scratch for every run |
| Port 18787 | never bound by this campaign |

### The ambient-principal census — all three numbers quoted at this gate were wrong or accidental

The gate has carried **84**, then **77**. POD-1385 then found the defect both of the later commands
shared: `grep -v '\.test\.ts'` filters on line **CONTENT**, not on **PATH**, so any production line
whose text happens to contain `.test.ts` is silently dropped. Two generated-SQL lines were.

Re-measured at `4b5c3a43`, confirming POD-1385 independently:

```
# path-correct: exclude *.test.ts by PATH, exclude dist
grep -rln --include=*.ts "FIRST_ADMIN_USER_ID" apps packages | grep -v '/dist/' \
  | grep -v '\.test\.ts$' | xargs grep -c "FIRST_ADMIN_USER_ID" | awk -F: '{s+=$2} END{print s}'
#   -> 79   across 28 files

# the command that produced 77 (content filter — WRONG)
grep -rn 'FIRST_ADMIN_USER_ID' apps packages --include=*.ts \
  | grep -v '\.test\.ts' | grep -v '/dist/' | wc -l
#   -> 77
```

So my earlier note that the 77-vs-77 agreement was "a coincidence of this candidate" was right for
the wrong reason: it was a coincidence of **two commands sharing one exclusion bug**. Three numbers,
one concept, and nothing in the build can check any of them. POD-1408 carries the requirement that
follows — the ratchet must exclude by path, and its own probe must include a production file whose
*content* contains `.test.ts`, or it reproduces exactly this defect and reports a number that looks
like coverage.

## Discovered work

- **POD-1408** — Ambient-principal census ratchet (no instrument produces the gating number).
- **POD-1410** — Bug: session expiry gate untested (F1).
- **POD-1412** — Bug: presence queue bound untested (F3).
