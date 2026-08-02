# POD-1394 — Multi-user mutation probe campaign: transcript

**Candidate SHA:** `d8fba769ee7b107ab655387559b4281c74aef8b9` (branch
`issue/1394-multi-user-mutation-probe-campaign`, branched from integration `d8fba769`; worktree
clean before and after every mutant).
**Date:** 2026-08-02

## What this transcript is, and what it deliberately is not

POD-425 refused detector-local evidence: a guardrail proven against a fixture string in its own test
file has been proven to reject **a string**. Every mutant below is planted in **production code** —
no fixture directories, no `--probe` mode, no test file — and graded on whether the real guardrail
refuses it *and names the thing that was broken*.

## Protocol, enforced mechanically

Every mutant went through one runner (`mutate.py`) that ABORTS rather than reports:

1. `git status --porcelain` empty before the mutation.
2. Each anchor matches **exactly once** in the target file (abort otherwise), with its line recorded.
3. Apply; assert the file's sha256 **moved**; grep back and assert the replacement text is present.
   A mutant that never applied otherwise produces a green that reads exactly like a working guardrail.
4. Run the guardrail; record exit code, elapsed, and the diagnostic text.
5. Restore the original bytes; assert sha256 **identical** to the original, every anchor count back
   to 1, and `git status --porcelain` empty again.

Steps 3 and 5 are inside a `try/finally`, so a guardrail that crashes or times out still restores.

## Environment

| Fact | Value |
| --- | --- |
| Worktree install | had no `node_modules`; `bun install --frozen-lockfile` exit 0 |
| Module identity | `bun test --conditions=@podium/source scripts/runtime-resolution.integration.test.ts` → **3 pass, 0 fail, 65 expect() calls, exit 0**. POD-1343's repair (`af302fee`) is an ancestor of the candidate, so the dual-copy ambiguity POD-425 recorded at `aba864a9` does not apply here. |
| State dir | `PODIUM_STATE_DIR` redirected to a scratch dir for every run; `~/.podium` never written |
| Live config mtime before | `2026-08-02 11:07:07.128162673 +0200` |
| Ports | nothing bound to 18787 by this campaign |
| Host load | 22–37 during the campaign (shared box, three other workers) |

## Ancestry (measured with `git merge-base --is-ancestor`, not inferred from dates)

| Commit | Meaning | Ancestor of `d8fba769`? |
| --- | --- | --- |
| `1cb323c8` | `merge: POD-1078 final — cross-user presence non-leak mutation-proven` | **yes** |
| `3336ae8b` | `docs(POD-1078): closure evidence` | **yes** |
| `b45dce5b` | POD-1078 branch TIP, `docs(gateway): finalize stable candidate evidence` | no (docs-only) |
| `af302fee` | POD-1343 tip, worktree runtime resolution | **yes** |

POD-1078's code is in the candidate. Its evidence is nonetheless **not cited**: every condition below
was re-run first-party against this candidate.

## Ambient-principal census

POD-425's coordinator carries a production ambient-principal count of **77**. No script, doc or
baseline in the candidate produces that figure, so the definition is stated here explicitly rather
than assumed:

```
grep -rn "FIRST_ADMIN_USER_ID" --include=*.ts packages/*/src apps/*/src \
  | grep -v "\.test\.\|__fixtures__\|/conformance/" | wc -l
```

Before the campaign: **77**. (Re-measured after; see the closing section.)

## Verdict — one line per mutant

| Mutant | Cond | What was planted | File:line | Guardrail | Exit | Result |
| --- | --- | --- | --- | --- | ---: | --- |
| `C1` | 1 | second registry INSIDE PresenceRouting | `apps/server/src/gateway/presence-routing.ts:21` | presence-routing.test.ts + protocol planes | **1** | CAUGHT |
| `C1b-scoped` | 1 | second registry AT THE COMPOSITION ROOT | `apps/server/src/relay.ts:536` | browser-open + oracle-decomposition | **1** | CAUGHT |
| `C2b` | 2 | personal-not-granted flipped to visible | `packages/sync/src/feed/visibility.ts:316` | scripts/audit-scoped-feed.test.ts | **1** | CAUGHT |
| `C3a2` | 3 | principal minted from hello.clientId before dispatch | `apps/server/src/gateway/client-mux.ts:288` | client-mux.test.ts | **1** | CAUGHT |
| `C3b` | 3 | session-expiry check deleted from the auth gate | `apps/server/src/auth-route.ts:48` | auth-route + wsServer.client-auth | **0** | **SURVIVED** |
| `C4a` | 4 | throughSeq made optional on the batch arm | `packages/sync/src/authority/scoping.ts:67` | bun run audit:scoped-feed | **1** | CAUGHT |
| `C4b2` | 4 | watermark taken from visible data, not the evaluated range | `packages/sync/src/authority/scoping.ts:150` | scripts/audit-scoped-feed.test.ts | **1** | CAUGHT |
| `C4c-runtime` | 4 | evict replaced by remove on the anchor path | `packages/sync/src/authority/scoping.ts:230` | packages/sync/src/authority | **1** | CAUGHT |
| `C5a` | 5 | verb check dropped: any principal that can SEE may USE | `apps/server/src/machine-access.ts:305` | fleet + machine-access + grants | **1** | CAUGHT |
| `C5b` | 5 | fleet fan-out loses its per-machine use filter | `apps/server/src/modules/fleet/handlers.ts:205` | bun run audit:machine-grants | **1** | CAUGHT |
| `C6a` | 6 | room join no longer visibility-gated | `packages/protocol/src/planes/stream-port.ts:110` | protocol planes + presence-routing | **1** | CAUGHT |
| `C6b` | 6 | presence state outlives the connection | `packages/protocol/src/planes/stream-port.ts:197` | protocol planes + presence-routing | **1** | CAUGHT |
| `C6c` | 6 | outbound stream queue bound raised 64 -> 1,000,000 | `apps/server/src/gateway/presence-routing.ts:27` | presence-routing + reattach-storm + planes | **0** | **SURVIVED** |
| `C7a` | 7 | absent refusal leaks the machine NAME | `apps/server/src/machine-access.ts:326` | fleet + machine-access + handoff | **1** | CAUGHT |
| `C8a2` | 8 | unclassified entity kind resolves VISIBLE | `packages/sync/src/feed/visibility.ts:291` | packages/sync/src | **1** | CAUGHT |
| `C8b` | 8 | real aggregate points at a nonexistent matrix row | `packages/model/src/aggregates/registry.ts:153` | model aggregates + representations | **1** | CAUGHT |
| `C9a` | 9 | SYSTEM writer attributed as a user | `apps/server/src/command-principal.ts:173` | authz-matrix + addComment-principal + … | **1** | CAUGHT |
| `C9b` | 9 | agent attribution drops its on-behalf-of half | `apps/server/src/command-principal.ts:171` | authz-matrix + addComment-principal + … | **1** | CAUGHT |
| `C10` | 10 | instance_id column planted on the sessions table | `apps/server/src/migrations/schema.ts:33` | bun run audit:rearch | **1** | CAUGHT |

Every row above restored to **byte identity** (sha256 equal to the original), every anchor count
back to 1, and `git status --porcelain` empty after each run — asserted by the runner, which aborts
rather than reports if any of those fail.
## Three mis-aims, recorded because a green from a mis-aim reads exactly like a pass

The campaign produced three exit-0 results that were **not** guardrail gaps. Each is recorded with
the re-aim, because "the mutant ran and nothing failed" is the same observation in both cases and
only reading the code path distinguishes them.

| Mutant | Why the green meant "missed" | Re-aimed as |
| --- | --- | --- |
| `C3a` | Reassigned `conn.principal` **after** `dispatch(this, conn, msg)` had already handed the port the original principal — the guardrail never walks that path. | `C3a2`, set before the dispatch → exit 1 |
| `C4b` | Wrote `?? throughSeq` as the fallback, so a **fully suppressed** batch still watermarked correctly — and the fully-suppressed case is exactly what the check exercises. | `C4b2`, `?? 0` → exit 1 |
| `C8a` | Aimed correctly, but run scoped to `packages/sync/src/feed`, which does not contain the assertion (`conformance/binding.test.ts`). | `C8a2`, scoped to `packages/sync/src` → exit 1 |

A fourth was an instrument error rather than a mis-aim: `C4c`'s first invocation ended in a shell
pipe, so the recorded exit code was `tail`'s (`0`) and not the guardrail's. Re-run as `C4c-runtime`
with an unpiped command → exit 1. **A piped guardrail command cannot produce evidence.**

## Findings — three places the guardrails cannot say NO

### F1 — the fail-closed auth gate has no test caller at all (POD-1410)

`C3b` deleted the session-expiry check from `requestUserId()` and **29 tests passed**. The test that
looks like it covers this (`auth-route.test.ts:279`, *"a session validates until it expires, then no
longer"*) asserts on the **store predicate**, never on the gate that consults it.
`grep -rn 'requestUserId\|isRequestAuthed'` over `apps/ packages/ tests/` returns **only production
call sites**. `requestUserId` feeds `server.ts:367 requestPrincipal`, which performs no second expiry
check, so an expired cookie resolves to that user's full principal. §3.1.6 S4's fail-closed rule is
unenforced at this edge. This is the most serious result in the campaign: unlike the others, **no
lane can catch it, because nothing calls the function.**

### F2 — condition 1's guardrail covers the seam, not the composition root

`C1` (inside `PresenceRouting`) is caught with a diagnostic that names the property. `C1b` (the same
defect at `relay.ts:536`, which is where `routing.ts` says the one instance actually lives) exits **0**
against `bun run audit:scoped-feed` and against the **entire 9-file / 112-test gateway suite**, because
every `PresenceRouting` test injects its own registry and is blind to it by construction. It is caught
— but only by `browser-open.test.ts` and `oracle-decomposition.test.ts`, which no one would think to
cite as the single-registry guardrail. The condition is satisfied; the *instrument a gate would reach
for* is not the instrument that holds.

### F3 — the presence queue bound is unguarded (POD-1412)

`C6c` raised `STREAM_QUEUE_MAX_FRAMES` from 64 to 1,000,000 and **88 tests passed**. That constant has
exactly two references in the repo: its definition and its single use. The test that appears to cover
it drives a socket whose `send` **fails** and counts `STREAM_EVICT_AFTER_DROPS`; it never exercises the
queue **depth**. Condition 6's other halves are genuinely guarded (`C6a` gating, `C6b` durability), so
this is a narrow hole in a mostly-covered condition — but it is the half that matters for a consumer
that accepts slowly rather than failing.

## Two instrument observations for the gate

1. **`bun run audit:scoped-feed` is source-text only.** It exits **0** on `C2` — a real, wide-open
   cross-principal leak — and says so in its own output (*"the running-object half is
   audit-scoped-feed.test.ts"*). A gate that ran the audit script and stopped would have recorded
   condition 2 as protected while the filter was returning `visible: true` for every ungranted row.
2. **The `remove-for-revocation` source-text check cannot see the real production site.** It keys on
   functions whose *name* names revocation; the shipped site is `anchorFor`, which does not. `C4c`
   exits 0 against `audit:scoped-feed` and is caught only by the running objects.

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
| Candidate | `d8fba769`, unchanged |
| `git status --porcelain` | empty |
| Ambient-principal census, my command | **77** |
| Ambient-principal census, coordinator's command | **77** (the two definitions agree at this candidate) |
| Live config mtime after | `2026-08-02 11:07:07.128162673 +0200` — **unchanged** |

Census commands, both reported because a number nobody can re-derive is not a baseline:

```
# mine
grep -rn "FIRST_ADMIN_USER_ID" --include=*.ts packages/*/src apps/*/src \
  | grep -v "\.test\.\|__fixtures__\|/conformance/" | wc -l     # 77

# coordinator's
grep -rn 'FIRST_ADMIN_USER_ID' apps packages --include=*.ts \
  | grep -v '\.test\.ts' | grep -v '/dist/' | wc -l             # 77
```

Neither is enforced by anything. Filed as POD-1408.

## Discovered work

- **POD-1408** — Ambient-principal census ratchet (no instrument produces the gating number).
- **POD-1410** — Bug: session expiry gate untested (F1).
- **POD-1412** — Bug: presence queue bound untested (F3).
