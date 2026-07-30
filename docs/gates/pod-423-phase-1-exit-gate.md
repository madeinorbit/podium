# POD-423 — Phase 1 exit gate: model foundation verified

**VERDICT: HELD OPEN.** Phase 1 does not close. Three blockers below, each re-measured on
this branch rather than quoted from a prior report. The verification lanes are green and
the audit ratchet has tightened; what fails is the gate's literal acceptance criteria and
Phase 1's own thesis.

**Measured at** `b812e549` (branch `issue/423-1-7-phase-1-exit-gate-model-foundation-v`,
**0 ahead / 0 behind `issue/279-integration`, working tree clean**). That zero-diff posture
matters for every red below: this branch changes nothing, so no failure here can be a
regression introduced by it. Own `bun install` in this worktree before measuring.

---

## Blockers

### B1 — Raw-string ids are NOT at zero, and NO instrument measures them

The gate's own AC names four Phase-1 audit items: hand-restated definitions, **raw-string
ids**, agent-kind/capability tables, stateDir. Three are real keys in
`scripts/rearch-audit-baseline.json` and all three are 0. **There is no raw-string-id key
at all** — `grep -rniE 'raw.?string|rawStringId' scripts/*.ts` returns nothing. POD-363's
AC ("the raw-string-entity-id audit item reaches ZERO repo-wide") names an item that was
never implemented, so its zero was never measurable and no ratchet protects it.

Measured directly instead:

- **66 sites** repo-wide (non-test, `apps` + `packages`) declare an explicitly
  entity-named id field as bare `z.string()`:
  `grep -rnE '\b(sessionId|issueId|machineId|repoId|conversationId|threadId|mutationId|userId)\s*:\s*z\.string\(\)'`.
  Concentrated in `apps/server/src/router.ts` (13), `packages/commands/src/issues/contracts.ts` (9),
  `superagent/contracts.ts` (6), `sessions/command-plane.ts` (6), `packages/protocol` (~22).
- The brands exist and are unused at those sites. `MachineIdField`, `MutationIdField`,
  `SessionIdField`, `IssueIdField`, `UserIdField` are all exported from
  `packages/model/src/ids/brands.ts`.
- **The inconsistency is intra-file, which rules out "boundary parse" as the explanation.**
  `packages/commands/src/issues/contracts.ts` imports `IssueIdField`/`SessionIdField`/`UserIdField`
  and uses them at lines 143–145, then declares `machineId`/`mutationId`/`id` as `z.string()`
  at 199, 215, 235, 255, 308, 319. `apps/server/src/router.ts` does both patterns too:
  `sessionId: z.string().min(1).pipe(SessionIdField)` at 203/226, bare
  `machineId: z.string().optional()` at 207/766/821.
- **Inside `packages/model` itself:** `fields/change.ts:132` declares
  `mutationId: z.string().optional()` while `MutationIdField` exists — and `MutationId` is
  one of the seven brands POD-301's scope names by hand. `entities/issue-vocabulary.ts:110`
  (`IssueComment.id`) is bare, immediately below `IssueDepWire` which uses `IssueIdField`.

**Not defects — checked, not assumed.** Four other `z.string()` id sites in
`packages/model` carry explicit "UNBRANDED BY DECISION" doc comments with reasons that
hold: `transcript.ts:36` (harness-derived/synthesized), `conversation.ts:42` (native agent
session id — evidence, not identity), `session.ts:116` (`NativeSubagent.id` is a
harness-minted `agent_id`, brand is `AgentIdentityId`), `session.ts:157` (native resume
ref). These are correct and must not be flipped.

**POD-301 — "1.3 Branded IDs everywhere", the parent of 360–363 — is `stage=backlog`.**
Its children are all `done`; the parent whose scope is the repo-wide flip is not started.

**Correcting POD-1162's mail on mechanism, not conclusion.** It reported "POD-363 is
blocked behind POD-362 (in_progress)". Both are `stage=done`. Its *conclusion* — raw-string
ids are not at zero — is correct and is confirmed here by direct measurement.

**Note on `inventory:ids`:** POD-363 established it over-reports by design (NAME-based
classifier, 1798 before and after an A-schema flip). It is not read as a completion metric
anywhere in this gate. The `POD-361-EDGE-CAST` marker count is the audit item and it **is**
0 in code — 2 remaining hits are both prose in `docs/`
(`rearch-branded-id-flip.md:218`, `rewrite-fanout-ledger.md:1859`).

### B2 — 14 live durable classes have no ADR 1 matrix row

Phase 1's thesis is "every entity defined once in `packages/model`". Fourteen durable
classes are classified by nobody, and `visibilityClassOf` is TOTAL and default-closed, so
they answer `personal` from the D4 backstop — **indistinguishable from a class deliberately
classified `personal`.** Every gate in the repo is green about them. Evidence and method:
`docs/agents/pod-385-matrix-coverage-sweep.md`.

Three are per-user-state-shaped, where the backstop's `personal` is *wrong*, not merely
undeclared: `recap_watermarks`, `notification_facts`, `message_wake_cooldowns`. Three more
(`maintenance_commands`, `maintenance_leases`, `steward_state`) are substrate-shaped, where
`personal` is wrong in the *widening* direction. The rest: `subscriptions`,
`subscription_deliveries`, `repo_draft_seq`, `offers`, `session_observation_checkpoints`,
`session_observation_rebinds`, `session_terminal_candidates`, `podium_events`.

**This is the run's dominant defect class in its purest form** — a gate whose refusing arm
can never fire, because the backstop returns the same value for "classified" and "never
classified". `matrix.test.ts` proves the backstop fires for a *synthetic* undeclared id; it
cannot prove no *real* class is undeclared. The durable fix POD-385 names is a **membership
gate** enumerating schema tables against matrix rows + `DECLARED_OMISSIONS`. It would have
caught all fourteen. It is not built, and building it is outside this gate's verify-only
scope.

**POD-1194 (the sweep) is `stage=proposed, ready=false`** — filed, not scheduled. Phase 1
cannot close while its central claim carries fourteen unadjudicated exceptions.

### B3 — The AC "all Phase-1 children closed" fails literally

- **POD-301** (1.3 Branded IDs everywhere) — `backlog`
- **POD-1076** (1.9 Per-user state family) — `backlog`, and it owns the
  `per-user-singletons: 8` ratchet POD-368 explicitly mapped to it
- **POD-288** (the phase issue) — `backlog`

Closed: 299, 300, 302, 303, 304, 360–368, 643, 1075, 1141, 1151, 1153, 1162.

---

## What IS verified (green, re-measured)

| Lane | Result |
|---|---|
| Workspace typecheck, `--force` | **exit 0** — `Tasks: 23 successful, 23 total` / **`Cached: 0 cached, 23 total`** / 1m1.2s |
| `scripts/rearch-audit.ts` (deletion audit) | **exit 0** — **25 items, 186 sites, baseline exact** |
| `scripts/representation-audit.ts` | exit 0 |
| `scripts/change-row-audit.ts` | exit 0 |
| `scripts/check-boundaries.ts` | exit 0 — 56 allowlisted, **0 new** |
| `scripts/check-no-nul-bytes.ts` | exit 0 |
| `audit-{fleet,issue,mail,session,superagent,workflow}-commands.ts` | **6/6 exit 0** |
| Wire goldens (both `wire-golden.test.ts`) | exit 0 — **176 tests passed** |
| scripts + `packages/model` + `packages/commands` | exit 0 — 69 files, 1080 tests |

**The deletion audit ratcheted DOWN, not up.** My brief quoted 194 sites and the POD-383
ledger entry recorded 194 → 193. Measured here: **186**, baseline exact. That is the ratchet
tightening as required. No rebaseline was performed by this gate (zero diff).

**Phase-1 audit items in the baseline:** `session-shapes` **0**, `issue-shapes` **0**,
`agent-kind-enums` **0**, `state-dir-defs` **0**, `representation-registry-rot` **0**.
`capability-tables` is **5** — correctly phased to POD-325 (Phase 5.3), **outside** Phase 1;
Phase 1's half is `agent-kind-enums`, which is 0. Not counted as a blocker.

### Oracle: RED, and neither red is Phase 1's

`bun scripts/oracle.ts` → **exit 1**: `typecheck GREEN, unit RED, integration GREEN, e2e
GREEN, multi-instance RED`.

1. **unit** — exactly **1 failed / 7666 passed / 19 skipped**, the single failure being
   `apps/daemon/src/connectivity-state.test.ts > reconnects with the freshly paired token
   without restarting the daemon`. **Isolated: 3/3 green** (`4 passed` each run). This is
   POD-1184, the named daemon-reconnect load-flake. MEASURED, not asserted.
2. **multi-instance** — fails in `install`, not in product code: `bash -i` resolved `podium`
   to a string beginning `To run a command as administrator (user "root"), use "sudo …"`.
   The host's interactive-shell sudo lecture is being captured as command output. An
   environment artifact of this host.

Both are **MECHANISTIC** not-mine claims in the strongest available form: this branch is
0 ahead / 0 behind integration with a clean tree, so its diff is empty and cannot have
caused either. I did **not** re-measure them on a detached checkout, and say so.

---

## Limits of this gate — what I could NOT re-measure

- **Raw-string ids have no instrument**, so "66 sites" is my own grep, not an audit item.
  A grep is necessary and never sufficient: it keys on eight field NAMES and cannot see a
  raw id under any other name, nor a branded field wrongly widened downstream.
- **The 14 unclassified classes are POD-385's measurement, re-read but not re-derived.** Its
  own stated Limit 2 stands: it enumerated the 54 `sqliteTable` declarations only, so
  filesystem-backed and daemon-local durable state was never swept. pspec — the class that
  started this — is exactly such a store. **The true count of unclassified classes is
  unknown and is ≥ 14.**
- **Wire-fixture delta attribution** (632/635 byte-identical, 3 handoff deltas from
  POD-643/POD-1153) is POD-1162's measurement, consumed as given per the split. I verified
  the suites pass and that fixture history is handoff-only; I did not re-diff the 635 cases.
- `capability-tables: 5` is phased outside Phase 1 on POD-1162's reading of POD-325. I
  confirmed the baseline value, not the phasing decision.

## To close this gate

1. Land POD-301 (or re-scope it explicitly and record the deviation) — raw-string ids to 0.
2. **Add a raw-string-id audit item to `rearch-audit-baseline.json`**, so the zero is
   ratcheted instead of asserted. Without it, closing B1 is unverifiable by construction.
3. Schedule POD-1194; classify the fourteen, starting with the three per-user-shaped.
4. **Add the matrix membership gate** — the durable fix, and the only thing that stops B2
   recurring silently.
5. Land POD-1076 (per-user state family, owns `per-user-singletons: 8`).
6. Re-run this checklist and flip the verdict.
