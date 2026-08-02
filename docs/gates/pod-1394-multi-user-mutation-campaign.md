# POD-1394 — Multi-user mutation probe campaign: transcript

**Candidate SHA:** `7ceec3f7` (this branch, merging integration through POD-1410's `bbd05a08` and
POD-1412's fix). Every mutant below was executed at this SHA. Earlier full runs at `d8fba769` and
`4b5c3a43` are superseded, not merely appended — their records are in git history.
**Date:** 2026-08-02

## Status against POD-425's refusals (`dd017634`, `2f17c125`)

| Ground | Disposition |
| --- | --- |
| Durable raw records | **Cleared** by the gate at `2f17c125`. 30 records under `docs/gates/pod-1394-records/`. |
| Candidate-wide rerun | **Cleared.** Now re-run a third time, at `7ceec3f7`. |
| Signal-safe restoration | **Cleared.** See P2 — implemented after the hazard fired for real. |
| POD-1410 absent from candidate → C3b survived | **Fixed.** `bbd05a08` merged; C3b now **exit 1**. |
| POD-1412 open → C6c survived | **Fixed.** Merged; C6c now **exit 1**. |
| Compound coverage partial (5 clauses) | **Done.** `N1`–`N5b`, each clause its own mutant; sub-clauses split out (`N1b` `N1c` `N2b2` `N2c` `N3c`). |
| P2 paragraph stale | **Corrected** — it now records breadcrumbs as implemented, with the incident that forced them. |

## Result

**30 production mutants, 29 caught, 1 survivor.** Every caught row exits non-zero with a diagnostic
naming the property that was broken. The single survivor is filed as **POD-1429** and is a genuine
clause gap, described below.

Both of the campaign's original survivors are now **caught**: the findings this campaign produced
were fixed, and the fixes are themselves mutation-proven.

## BLOCKER — one clause the guardrails cannot fail on

**POD-1429** — `N5b`. Deleting the `writeScope` half of the system-reaction invariant
(`composition/reactions.ts:668`) leaves `bun run audit:composition` at **exit 0** and the composition
suite at **exit 0, 8 passed**. The only fixture pinning it sets *both* violations at once —
`{ class: 'system', actor: 'human', writeScope: 'all' }` — and both throw the same message, so
`actor !== 'system'` still fires alone and the no-widening check is dead weight to the suite.
*A compliance fixture that violates two clauses at once cannot isolate either.*

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

## Verdict — one line per mutant, all at `7ceec3f7`

| Mutant | Cond | What was planted | File:line | Exit | Diagnostic |
| --- | --- | --- | --- | ---: | --- |
| `C1` | 1 | second registry INSIDE PresenceRouting | `apps/server/src/gateway/presence-routing.ts:21` | **1** | shares one registry with the principal feed … expected 1 to be 2 |
| `C1b` | 1 | second registry AT THE COMPOSITION ROOT | `apps/server/src/relay.ts:536` | **1** | routes the open/result family only through session-room subscriptions (+3) |
| `C2b` | 2 | personal-not-granted flipped to visible | `packages/sync/src/feed/visibility.ts:316` | **1** | a principal with no grant received the row — the filter does not filter |
| `C3a2` | 3 | principal minted from hello.clientId before dispatch | `apps/server/src/gateway/client-mux.ts:288` | **1** | mints it from the connection, never from a frame body |
| `C3b` | 3 | session-expiry check DELETED from the auth gate | `apps/server/src/auth-route.ts:48` | **1** | rejects an expired session cookie (present row, past expiresAt) |
| `C4a` | 4 | throughSeq made optional on the batch arm | `packages/sync/src/authority/scoping.ts:67` | **1** | `throughSeq` is not a required `number` on the batch arm |
| `C4b2` | 4 | watermark taken from visible data | `packages/sync/src/authority/scoping.ts:150` | **1** | the suppressed range was NOT certified to the principal who could not see it |
| `C4c` | 4 | evict replaced by remove on the anchor path | `packages/sync/src/authority/scoping.ts:230` | **1** | a visibility change is DERIVED, and it is never a remove (D14) |
| `N1` | 4 | feed epoch RE-MINTED instead of read from the store | `packages/sync/src/feed/identity.ts:141` | **1** | mints on first use and PERSISTS … (+2) |
| `N1b` | 4 | per-principal frames renumber seq densely | `packages/sync/src/authority/scoping.ts:149` | **1** | returns the appended changes with contiguous seqs matching the durable log (+3) |
| `N1c` | 4 | no visibility edge ever derived (mid-session rescope) | `packages/sync/src/authority/scoping.ts:128` | **1** | rescope is derived from the SIZE of the derived set (D14.4) (+1) |
| `C5a` | 5 | verb check dropped: anything that can SEE may USE | `apps/server/src/machine-access.ts:305` | **1** | a `see` grant is not enough for a `manage` command (+6) |
| `C5b` | 5 | fleet fan-out loses its per-machine `use` filter | `apps/server/src/modules/fleet/handlers.ts:205` | **1** | `scanReposAll()` with no `mayUse` predicate scans every online machine |
| `N2` | 5 | delegation human read off the LEAF, not the chain ROOT | `apps/server/src/command-principal.ts:224` | **1** | an agent chain carries exactly ONE human, taken from the ROOT and not the leaf |
| `N2b2` | 5 | machine verbs MEMOISED across applies | `apps/server/src/machine-access.ts:219` | **1** | a `manage` grant does not carry `use`: discovery on the same machine is still refused |
| `N2c` | 5 | migrated ownerless machine silently re-owned | `apps/server/src/machine-access.ts:179` | **1** | an unowned machine refuses EVERYONE, grant or no grant |
| `C6a` | 6 | room join no longer visibility-gated | `packages/protocol/src/planes/stream-port.ts:110` | **1** | joins are visibility-gated and default-closed (D14) (+3) |
| `C6b` | 6 | presence state outlives the connection | `packages/protocol/src/planes/stream-port.ts:197` | **1** | drops all presence state when the connection goes — nothing outlives it (D12) |
| `C6c` | 6 | outbound stream queue bound 64 → 1,000,000 | `apps/server/src/gateway/presence-routing.ts:27` | **1** | bounds the undrained outbound queue so a busy room drops rather than buffers |
| `C7a` | 7 | absent refusal leaks the machine NAME | `apps/server/src/machine-access.ts:326` | **1** | a colleague's invisible machine and an id that never existed refuse IDENTICALLY |
| `N3b` | 7 | refused subscription EMITS a reason code | `packages/protocol/src/planes/control-port.ts:125` | **1** | admits an entity only when the resolver says so, and never says why |
| `N3c` | 7 | refused join leaves a subscription behind | `packages/protocol/src/planes/stream-port.ts:110` | **1** | does not subscribe a refused connection to anything |
| `C8a2` | 8 | unclassified entity kind resolves VISIBLE | `packages/sync/src/feed/visibility.ts:291` | **1** | an UNCLASSIFIED entity kind is invisible — and says so, not 'personal' |
| `C8b` | 8 | aggregate points at a nonexistent matrix row | `packages/model/src/aggregates/registry.ts:153` | **1** | every registered row id is really on the matrix — with the backstop shown firing |
| `N4` | 8 | a `personal` row widened to `deployment-substrate` | `packages/model/src/annotations/matrix.ts:2661` | **1** | keeps the tenant-visible floor small and deliberate |
| `C9a` | 9 | SYSTEM writer attributed as a user | `apps/server/src/command-principal.ts:173` | **1** | a system write is attributed `system` with no human (D17.5) |
| `C9b` | 9 | agent attribution drops its on-behalf-of half | `apps/server/src/command-principal.ts:171` | **1** | attribution is a PAIR … never collapses them |
| `N5` | 9 | SYSTEM_WRITER_RULE loses its no-widening clause | `packages/model/src/annotations/ownership.ts:302` | **1** | expected … to match /never widen/ |
| `N5b` | 9 | writeScope half of the system-reaction invariant deleted | `apps/server/src/composition/reactions.ts:668` | **0** | **SURVIVED — POD-1429** |
| `C10` | 10 | instance_id column planted on the sessions table | `apps/server/src/migrations/schema.ts:33` | **1** | instance-partitions baseline 0 → now 1 … sessions.instance_id (column) |

All 30 rows restored to **byte identity**, every anchor count back to 1, `git status --porcelain`
empty after each — asserted by the runner, which aborts rather than reports. Exit codes are recorded
per mutant rather than inferred from test counts: a lane whose worker dies still summarises as
all-passed, so the count is not the verdict.

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

**It then happened, for real.** A later batch driver hit the harness's 10-minute cap; SIGTERM killed
it, and Python's default SIGTERM handling **does not run `finally`**. It left
`apps/server/src/machine-access.ts` mutated in the tree with C7a's edit. The tree was restored and
verified byte-identical (`c1695a60cf579f77`) against HEAD. So P2 is not a maxim — it is an observed
failure of this campaign's own instrument.

**Implemented, not proposed.** The runner now:

- writes a **breadcrumb** (mutant id, target path, original sha256, original bytes) to disk **before**
  the file is touched;
- installs **SIGTERM / SIGINT / atexit** handlers that restore from it and exit;
- clears the breadcrumb **only after** a verified restore (hash identical, anchor counts back,
  `git status` empty);
- exposes **`--restore-orphans`**, which replays any breadcrumb left behind — so recovery does not
  require the process that made the mess, which is exactly the position an outside observer was in
  when this fired.

Self-tested by killing a live mutant with SIGTERM: `signal 15: mutant restored before exit`, tree
clean, hash back. The residual advice stands on its own: keep long full-lane runs to the few
questions that need them (this campaign used one), because scoped runs shrink the exposure window
from minutes to seconds.

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
| Candidate | `7ceec3f7` — every mutant in the verdict table executed here |
| Superseded candidates | `d8fba769` (first run), `4b5c3a43` (second) — records in git history |
| `git status --porcelain` after every mutant | empty |
| Live config mtime, before and after | `2026-08-02 11:07:07.128162673 +0200` — **unchanged** |
| `~/.podium` | never written; `PODIUM_STATE_DIR` redirected to scratch for every run |
| Port 18787 | never bound by this campaign |

### The ambient-principal census now has an instrument

This campaign opened by refusing to adopt a number it could not re-derive. The gate had carried
**84**, then **77**; POD-1385 then found that both of the later commands filtered on line **CONTENT**
rather than **PATH** (`grep -v '\.test\.ts'`), silently dropping production lines whose text happened
to contain `.test.ts`. Three numbers, one concept, and nothing in the build that could check any.

POD-1408 shipped the ratchet, and at this candidate it runs clean:

```
bun run audit:ambient-principals        # --probe, then the gate
FIRST_ADMIN_USER_ID: 41 usage sites  (baseline 41)
DEVICE_GRADE_PRINCIPAL: 11 usage sites  (reported only)
DeviceGradeUnscopedPolicy: 4 usage sites  (reported only)
ambient-principal census: no drift
exit 0
```

It took the shape the finding argued for: a **declared union** rather than one spelling, counting
**usage sites** rather than raw grep hits, with a baseline a build can fail on. The number is no
longer a coordinator's shell history, which is the only thing that made the earlier disagreement
possible.

## Discovered work

- **POD-1408** — Ambient-principal census ratchet (no instrument produces the gating number).
- **POD-1410** — Bug: session expiry gate untested (F1).
- **POD-1412** — Bug: presence queue bound untested (F3).
