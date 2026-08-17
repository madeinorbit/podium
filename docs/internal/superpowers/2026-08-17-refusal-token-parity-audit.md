# Two readers of one refusal — the audit, and what closed it (POD-2241)

**Date:** 2026-08-17 · **Branch base:** `worktree-updater-spec` @ `11c9c187a` · **Epic:** POD-2087

## The shape

Every reason a machine can decline an update was written down twice, in two
places that did not know about each other:

- `classifyMachineFailure` (apps/server) — sentence → code the operation persists
- `describeUpdateFailure` (apps/web) — sentence → words an operator reads

An arm added to one was therefore half a fix, and the missing half did **not**
produce a blank. Both readers fell through to the same default, so a machine
that was running, answering, and declining on purpose was reported as

> *"A machine stopped responding while updating. Check it's running; it will
> resume when it reconnects."*

Both halves false, and the second could never become true — nothing about that
machine was going to change on its own. POD-2210 hit it once (the foreground
all-in-one refusal). POD-2239/POD-2240 hit it again, three schema tokens at a
time.

## The audit, by import

Every sentence below was produced by **calling the real constructor**, not by
hand-writing a fixture: `refuseConvergence`, `refuseSchemaRegression`,
`createSchemaGate`, `planConvergence` through `applyGrant`'s own wrapper,
`convergeViaGit` through `fetchArtifact`'s wrapper, `fetchArtifact` itself,
`resolveOnBoot`, and the service's own `GRANT_TIMED_OUT_DETAIL`. Each was then
handed to both readers.

**Result: 11 of 20 real sentences fell to `machine-unreachable` and to the web's
generic "Podium could not finish the update."**

### Before

| Token / sentence | Producer | Server arm | Web arm | What the operator saw when it was missing |
| --- | --- | --- | --- | --- |
| `foreground-all-in-one` | `refuseConvergence` | ✅ `machine-cannot-restart` | ✅ | — |
| `schema-advanced` | `refuseSchemaRegression` | ✅ | ✅ | — |
| `schema-unknown` | `refuseSchemaRegression` | ✅ | ✅ | — |
| `schema-unreadable` | `createSchemaGate` | ✅ | ✅ | — |
| `dirty-working-tree` | `convergeViaGit` | ✅ `machine-dirty-checkout` | ✅ | — |
| `no-artifact` | `planConvergence` | ✅ `machine-unsupported` | ✅ | — |
| `unsupported-delivery` | `planConvergence` | ✅ | ✅ | — |
| `unsupported-platform` | `planConvergence` | ✅ | ✅ | — |
| `status-failed` | `convergeViaGit` | ❌ → unreachable | ❌ generic | "stopped responding" about a machine that had just reported a `git status` failure |
| `fetch-failed` | `convergeViaGit` | ❌ → unreachable | ❌ generic | same; the machine is up, its remote or network is not |
| `checkout-failed` | `convergeViaGit` | ❌ → unreachable | ❌ generic | same; the checkout is intact and nothing was swapped |
| `timed-out` (git budget) | `convergeViaGit` | ❌ → unreachable | ❌ generic | same; the daemon gave up on the remote and said so |
| `invalid-git-reference` | `convergeViaGit` | ❌ → unreachable | ❌ generic | "try again" for a target descriptor that will refuse identically forever |
| `cancelled` (git) | `convergeViaGit` | ❌ → unreachable | ❌ generic | unreportable in practice — see "holes that stay holes" |
| digest verification FAILED | `fetchArtifact` | ❌ → unreachable | ❌ generic | **a corrupt or tampered package reported as a connectivity problem** |
| signature verification FAILED | `fetchArtifact` | ❌ → unreachable | ❌ generic | same |
| `artifact download returned <n>` | `fetchArtifact` | ❌ → unreachable | ❌ generic | a broken release read as a broken machine |
| `artifact download timed out after <n>s` | `fetchArtifact` | ✅ `download-failed` | ✅ | — |
| git runner / artifact URL / pinned key missing | `fetchArtifact` | ❌ → unreachable | ❌ generic | "check the machine is running" for a server-side misconfiguration |
| `…pinned to last-known-good` | `resolveOnBoot` | ❌ → unreachable | ❌ generic | "it will resume when it reconnects" — said about a boot that had just reconnected |
| `…applying again will retry it` | `host-runtime` | ❌ → unreachable | ❌ generic | same |
| withdrawn-target reason | `setTargetUnavailable` | ❌ → unreachable | ❌ generic | the server retracted the update; the operator was sent to check a healthy machine |
| `stopped reporting progress` | `GRANT_TIMED_OUT_DETAIL` | ✅ `machine-unreachable` | ✅ | — (the one input the default is true for) |

### After

Every row above is now classified and answered on both sides. `machine-unreachable`
is reserved for exactly one token — `stopped-reporting-progress` — plus the
genuinely unrecognized sentence, which is the honest answer for a machine that
said nothing at all.

Five new §7 codes carry the recovered rows, chosen by the **next action** they
imply rather than by the step that failed:

| Code | Covers | Why not an existing code |
| --- | --- | --- |
| `machine-delivery-failed` | git status/fetch/checkout/timeout/cancel | Live machine, nothing changed, retry can genuinely differ |
| `machine-delivery-unavailable` | invalid git reference, missing runner / URL / pinned key | Property of the release or the pairing — retry is **guaranteed** to return here, so the copy must not offer it |
| `machine-artifact-rejected` | digest and signature verification | A security event. "Try again" is actively bad advice: what arrived was not what was signed |
| `machine-update-not-confirmed` | both boot-reconciliation verdicts | The machine is **up** — the boot is what reported this |
| `update-withdrawn` | `setTargetUnavailable` | The server retracted the target; nothing about the machine needs checking |

## Holes that stay holes, and why

- **`git-cancelled` and "artifact download was superseded by a newer grant"**
  have a row in the table but no operator will see them: `applyGrant` returns
  without reporting when its own abort signal is raised, which is the only way
  either sentence is produced. Pinned by a test rather than assumed — the table
  covers them anyway because "unreportable" is a property of one call site, and
  the cost of a row is one line.
- **`preparation-failed`, `web-build-failed`, `server-did-not-reach-target`,
  `stalled`** are not machine refusals and are not in this table. They are
  authored by the server about itself and already carry their own §7 sentence.
- **The desktop shell's codes** (`debug-build`, `signature-invalid`,
  `install-failed`, `restart-failed`, `no-pending-update`, `no-update-available`)
  stay in `operation-view.ts`'s open-string switch. They are not produced by any
  daemon sentence, so putting them in a classifier keyed on daemon prose would
  claim a relationship that does not exist.

## What makes the class hard to reintroduce

A convention is not an instrument that can say no — this epic has now found
nine gates that could not. So:

1. **One classifier.** `packages/protocol/src/update/refusal.ts` holds the
   ordered token table. `classifyMachineFailure` (server) delegates to it;
   `describeUpdateFailure` (web) delegates to it. Neither re-derives anything.
2. **One copy table.** `MACHINE_FAILURE_COPY` in `apps/web/.../update-view.ts`
   is a `Record<MachineFailureCode, …>`, and both of the web's entry points —
   the raw-sentence path and the operation-code path — render from it. They can
   no longer produce two answers for one refusal.
3. **TypeScript is the gate.** Adding a code to the protocol reds
   `@podium/server` (the failure union and its defaultless switch, plus an
   explicit `MachineFailureCode extends UpdateErrorCode` assertion) **and**
   `@podium/web` (the missing `Record` key). Proven: adding a tripwire code
   produced `TS2322` ×3 in apps/server and
   `TS2741: Property '"machine-tripwire-code"' is missing` in apps/web.
4. **The table is checked against reality.** `apps/daemon/src/refusal-tokens.test.ts`
   calls the real constructors and asserts each output lands on the token whose
   example the table quotes. apps/server and apps/web may not import apps/daemon,
   so they drive their coverage off `UPDATE_FAILURE_EXAMPLES`, and that test is
   what keeps the examples from becoming fiction.
5. **Ordering is checked too.** First-match-wins tables fail silently when a row
   is added in the wrong place. `refusal.test.ts` asserts every row classifies
   by its own example. This is not hypothetical: the withdrawn-target detail
   wraps publisher prose, and a real one says *"The source checkout has 2
   uncommitted changes"* — which the machine-side dirty-checkout pattern was
   claiming until the token was anchored and moved first.

### Proof the gates fire

| Gate | Mutation | Result |
| --- | --- | --- |
| apps/server typecheck | add a code with no arm | `TS2322` ×3 (union, two call sites, and the taxonomy assertion) |
| apps/web typecheck | same | `TS2741` naming the missing `Record` key |
| `refusal.test.ts` | add a row shadowed by an earlier pattern | red: "classifies every row by its own example" |
| `refusal-tokens.test.ts` | same | red: "leaves no token in the shared table without a producer behind it" |
| `operation.test.ts` | point a token at `machine-unreachable` | red: "reserves the unreachable default for the machine that actually went quiet" |
| `update-view.test.ts` | same | red: "never tells the operator a machine that answered on purpose stopped responding" |
