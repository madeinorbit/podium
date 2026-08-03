# POD-335 — boundary lint end state: the retirement ledger

**Issue:** POD-335 (7.3 Boundary lint end-state) · **Epic:** POD-294 (Phase 7)
**Baseline:** `9eea645d` on `issue/279-integration` · **Measured:** 2026-08-03

> `bun run lint:boundaries` → **`boundaries OK — 0 allowlisted, 0 new`**
> `scripts/boundary-allowlist.ts` → **`BOUNDARY_ALLOWLIST = []`**
> `ERROR_LEVEL_MANIFEST_RULES` → **every manifest rule**

---

## 0. What changed, in one paragraph

POD-296 landed the architecture manifest in WARN mode beside eight bespoke
boundary rules, with a phase-mapped allowlist under both, and said the two
families would coexist "until POD-335 retires each legacy rule against an
equivalent manifest constraint". This issue did that. The manifest now carries
four tag families instead of two — layer, platform, role and features, plus
per-workspace **closed dependency sets** and **consumer restrictions** — every
rule runs at error level, the allowlist is empty, and re-adding an entry is a
build failure rather than a quiet reopening of the ratchet.

**Scope note, per the issue's revision:** the end state is NOT "two axioms only".
Platform browser-safety, server role tiers and feature ownership all SURVIVE as
manifest entries. Nothing was simplified away.

---

## 1. The retirement table

No rule was dropped without a named equivalent. Every row's replacement has a
test that plants the same bad code the legacy rule refused —
`scripts/boundary-retirement.test.ts`, 51 cases, one describe per retired rule.

| # | Retired rule | Replacement | Equivalence notes |
|---|---|---|---|
| 1 | `no-app-to-app` | `manifest-layer` (undeclared same-layer edge) | Apps are all L4, so an app→app import is a same-layer edge and same-layer is not implicit. The ONE sanctioned exception (`apps/web` importing the `AppRouter` **type** from `apps/server`) is now a declared row in `SAME_LAYER_TYPE_ONLY_ALLOWED`; a runtime import of the same specifier is still refused, and every OTHER type-only app→app edge is still refused. Test-file exemption preserved. |
| 2 | `agent-host-consumers` | `manifest-consumers` + `manifest-open-entrypoint` | See §2 — this is the one that needed new mechanism, not just a new home. |
| 3 | `leaf-package` | `manifest-deps` with `deps: []` | "Imports no workspace package" is the empty closed set. An ABSENT `deps` means "governed by the layer axiom alone"; the two are deliberately different. |
| 4 | `restricted-package-deps` | `manifest-deps` | **The layer ordinal alone was strictly weaker and this is measured, not assumed:** `packages/runtime` is L2 and `packages/commands` is L1, so the layer axiom admits `runtime → commands` while legacy rule 3b never did. Same for `transcript → commands` and `composer → commands`. The closed set is what still refuses them. |
| 5 | `packages-no-apps` | `manifest-layer` (upward edge) | Packages are L0–L3, apps are L4, so every package→app import is upward. Exempts nothing — not type-only, not tests — which is what legacy rule 4 did. |
| 6 | `cli-no-apps` | `manifest-layer` | `apps/cli` is an app under rule 1; it had no separate mechanism, only a separate sentence. |
| 7 | `server-role-tiers` | `manifest-role` | An exact duplicate: both delegate rank and composition-root exemptions to `apps/server/src/roles.ts`. `checkManifestRole` already existed; the legacy copy is deleted. |
| 8 | `model-single-home` | `feature-single-home` | Reads the home from the MANIFEST rather than a constant, and **widens the forbidden zone from `packages/*` to `apps/*` as well** — see §4 for the three real duplications that widening found. |
| 9 | `runtime-browser-safety` (8a + 8b) | `manifest-browser-reach` (a) + (b) | 8a said "`apps/web` may import only the bare `@podium/runtime` specifier"; that is now one row of `BROWSER_ENTRYPOINTS`, generalised from one app to every browser-safe workspace (ADR 6 puts a client adapter on mobile too). 8b's one-hop barrel check is replaced by (b)'s **transitive** closure walk — strictly stronger, and 8b's own doc said the two-hop leak slipped through it. Subsumes the former `sync-browser-reach` (POD-307) into the same mechanism. |

Rules NOT in the retired eight — `host-edge-separation`, `replica-direction`,
`sync-kernel-purity`, `declared-deps`, `harness-principal-free`,
`ui-storage-ownership`, `session-binding-field-access`,
`harness-classifier-boundary`, `harness-branching` — are unchanged. They are not
dependency-matrix facts; they constrain the SHAPE of code inside one place, and
no tag on a workspace could express them.

**How the retirement is measured rather than asserted:**
`architecture-manifest.test.ts` greps both checker sources for `rule:` literals
and fails if any of the eight ids is still EMITTED. That test caught
`checkRuntimeBarrelPurity` surviving the cut with nothing calling it.

---

## 2. The one retirement that needed new mechanism

`agent-host-consumers` was a WHOLE-PACKAGE ban: importing `@podium/harness` or
`@podium/pty` means driving real agent processes, so only `apps/daemon` and the
build tier may. Four `apps/server` files sat under it in the allowlist for weeks.

Reading what they actually imported is what unlocked it. None of the four wanted
the capability:

| File | Wanted |
|---|---|
| `harness-manifest.ts` | 14 static metadata functions (display name, capability descriptors, pure transcript mappers) |
| `relay.ts` | two prompt-pointer string constants |
| `modules/sessions/daemon-lifecycle.ts` | `acceptAgentObservation` — a protocol-level causal state machine merely FILED in the harness package |
| `accounts.ts` | one fact: "is this CLI logged in, and as whom" |

So the boundary became PRECISE instead of merely strict:

- `packages/harness` declares `consumers: ['apps/daemon', 'scripts']` **and one
  open entrypoint**, `@podium/harness/metadata`. Everything else stays shut,
  including every other subpath.
- `packages/pty` declares the same consumers and **no** open entrypoint: every
  export there drives a process.
- `accounts.ts` now calls a named `harnessDetectLogin(kind, homeDir)` — it takes
  the ANSWER, never the manifest registry that can also launch a process.

`manifest-open-entrypoint` holds the declaration honest: the entrypoint may not
`export *`, may not export a process-driving name, and may not import a process
API. **This is a SURFACE check, not a closure check, and the reason is written in
the code:** the metadata functions resolve through `AGENT_MANIFESTS`, whose own
closure legitimately reaches `node:child_process`, so a transitive walk would
refuse the whole surface and prove nothing about it. What IS provable is that the
surface cannot widen without someone editing an explicit named list. Stated here
rather than left to be discovered, because a limitation nobody wrote down is one
somebody will later mistake for a guarantee.

The other two allowlist entries (`apps/desktop/scripts/stage-sidecar.ts`) were
closed by the decision their own note deferred to Phase 7: `apps/*/scripts/**` is
now BUILD TIER, which says the true thing about a per-app build script rather
than excusing a false accusation. Narrow on purpose — only `scripts/` directly
under an app, so product code cannot be hidden in a folder of that name.

---

## 3. Guardrails with NO legacy predecessor

These arrive with multi-user (`docs/multi-user-readiness.md`, human decisions of
2026-07-29). They are not retirements; they are additions Phase 7 owns the end
state of.

| Guardrail | What it enforces | Where | Proven to fire |
|---|---|---|---|
| `authz-single-home` (a) — no second classification table | ADR 1's ownership matrix is the ONE classification; `visibilityClassOf` is its total, default-closed resolver | `scripts/architecture-manifest.ts` | Planted a `{ session: 'personal', …, setting: 'deployment-substrate' }` table into `apps/server/src/modules/memory/visibility.ts` → **fired** |
| `authz-single-home` (b) — no decision declared without consulting a home | §3.2: extend the closed `IssueScope` set with owner/grant scopes *"rather than inventing a parallel check"*; §3.1.4 M6: machine access as grants on the same principal model *"rather than as a separate fleet ACL"* | same | Planted `export function mayRead(u, r) { return r.owner === u ‖ r.grants.includes(u) }` into `apps/server/src/accounts.ts` → **fired** |
| Visibility-classification totality | §3.1.1 rule 2 — every entity class declares its visibility class on ADR 1's matrix; rule 1 fixes the failure DIRECTION: unclassified is personal/private | `packages/model/src/aggregates/registry.ts` + `annotations/matrix.ts`; consumed by `packages/sync/src/feed/visibility.ts` | See §3.1 |

### 3.1 Phase-entry verification of the totality guardrail

The brief required verifying at phase entry that it (a) exists, (b) runs at error
level in a permanent CI lane rather than as a one-off Phase-1 test, and (c) fails
closed. All three hold; none of them was taken on report.

**(a) It exists.** POD-304 landed the per-field obligation over the matrix (53
annotated rows, `visibilityClassOf`'s total resolver, a totality test that plants
an unclassified fixture). POD-365 landed the same obligation for the canonical
aggregates: `CanonicalAggregate` makes `visibility` and `matrixRow` REQUIRED,
`classificationViolations` checks the declaration against the matrix, and
`visibilityClassOf` resolves an unknown row to `personal` as the semantic
backstop. Three mechanisms, none substituting for another.

**(b) Permanent CI lane, error level.** `packages/model/**` runs under
`vitest.unit.config.ts`, which is the `unit-tests` job's `bun run test:unit`
step in `.github/workflows/ci.yml` — a blocking job, not `continue-on-error`,
and not a Phase-1 one-off. Measured: `registry.test.ts` + `matrix.test.ts` = 70
tests, rc=0.

**(c) It fails closed — proven by mutation, twice, at both layers.**

| # | Mutation (production source) | Instrument that fired | Result |
|---|---|---|---|
| M1 | Added a canonical aggregate declaring `deployment-substrate` against the `issue-core` row (which the matrix resolves `personal`) | `classificationViolations()` over the REAL registry, `registry.test.ts:35` | **RED** — `declaration-disagrees-with-matrix`. 6 tests failed; the named check is the one asserted. |
| M2 | Removed the `visibility` field from the `Grant` entry | `tsgo --noEmit` | **RED** — `TS2741: Property 'visibility' is missing … but required in type 'Omit<CanonicalAggregate, "name">'` at `registry.ts(171,3)`. The type has no hole. |
| M3 | Flipped the consumer's default-closed branch: `if (declared === null) return { visible: false, reason: 'unclassified' }` → `return { visible: true }` in `packages/sync/src/feed/visibility.ts` | `authority.scoped.test.ts` + `conformance/binding.test.ts` | **RED** — "an UNCLASSIFIED entity kind is invisible — and says so". The unclassified class is treated as PRIVATE by what consumes the classification, and that is asserted, not assumed. |

Each revert byte-verified: md5 back to the snapshot, plus a grep for the probe
string returning rc=1. `git status --porcelain` empty afterwards.

**Nothing was missing, so nothing was fixed here.** The guardrail was already
permanent, already blocking, and already default-closed at both the
classification layer and the consuming policy layer.

---

## 4. Every guardrail seen to REFUSE

POD-337's convention is that each guardrail must FIRE on planted bad code. These
are end-to-end runs of `bun scripts/check-boundaries.ts` against mutated
PRODUCTION source — not unit calls into the checker — each reverted from a
byte-verified snapshot.

| Rule | Planted into | Fired |
|---|---|---|
| `manifest-layer` | `apps/server/src/accounts.ts` ← `@podium/daemon` | ✅ |
| `manifest-platform` | `apps/web/src/lib/agent-models.ts` ← `@podium/transcript` | ✅ |
| `manifest-role` | `apps/server/src/accounts.ts` ← `./hub/pairing` | ✅ |
| `manifest-deps` | `packages/transcript/src/index.ts` ← `@podium/commands` | ✅ |
| `manifest-consumers` | `apps/server/src/accounts.ts` ← `@podium/harness` | ✅ |
| `manifest-open-entrypoint` | `packages/harness/src/metadata.ts` — a `launchAgent` re-export | ✅ |
| `manifest-open-entrypoint` | `packages/harness/src/metadata.ts` — an `export *` | ✅ |
| `manifest-browser-reach` | `apps/web/src/lib/agent-models.ts` ← `@podium/runtime/config` | ✅ |
| `feature-single-home` | `apps/server/src/accounts.ts` — a second `isIssueClosed` | ✅ |
| `authz-single-home` (a) | `apps/server/src/modules/memory/visibility.ts` — a second class table | ✅ |
| `authz-single-home` (b) | `apps/server/src/accounts.ts` — a `mayRead` decision | ✅ |

**One silent mutant, recorded because the record is the point.** The first
`authz-single-home` (b) probe planted `mayReadThing`, which is not in the rule's
decision vocabulary, and the gate stayed green. That mutant could not move the
measured quantity, so it proved nothing either way; re-planted with `mayRead` it
fired. A silent mutant is a finding about the PROBE until it is shown otherwise.

---

## 5. Duplications this found, and removed

Both `authz-single-home` arms were tuned against the whole repo to zero false
positives before being switched on (7 → 6 → 5 hits across four tuning rounds,
each round removing a homonym class: `visibility:`/`resource:`/`kind:`/`scope:`
declaration keys, the ambiguous `'secret'` literal, interface members, and call
sites). What survived was real.

| Site | What it was | Fix |
|---|---|---|
| `apps/server/src/modules/memory/visibility.ts` | A literal `MEMORY_DOCUMENT_VISIBILITY` table for six document classes, plus its own owner-or-grant rule, plus its own view of which grant verbs imply read | Class derived from `visibilityClassOf(ROW.x)` — verified row by row, all six identical, which is exactly the state a drift begins in. Decision routed through `authorize`. `hasReadGrant` became `readGranteesOf`, a LOOKUP that hands `authorize` the fact. |
| `apps/server/src/modules/sessions/queries.ts` | `owner === caller.userId ‖ grants.includes(caller.userId)`, spelled out again | Routed through the new `mayReadOwned` in `apps/server/src/issue-authz.ts` |

**Both copies had the same latent bug, and it is the reason this is a
correctness fix and not a tidy-up.** Each compared a possibly-ABSENT owner to a
possibly-ABSENT caller, so an unowned row and an unauthenticated reader compared
`undefined === undefined` and read as **ALLOW**. `authorize` refuses an unowned
entity outright (§3.1.1 default-closed, §3.1.4 M4's all-in-one case) and refuses
it without an override.

Three more came from widening `feature-single-home` to `apps/*`:

- `apps/server/src/repo-id.ts` declared `normalizeOriginUrl`, and it is a
  DIFFERENT function from the model's: the model's returns `''` for unparseable
  input, this one returns `null`, because repo_id identity must be able to say
  "no identity". Renamed `canonicalizeRepoOrigin` — a rename, not a merge,
  because the behaviours genuinely differ.
- `apps/web/src/features/issues/issue-context-menu.ts` declared `isIssueClosed`
  as `closedReason != null`, while the model's is
  `stage === 'done' ‖ closedReason != null` — two answers under one name, and a
  comment claiming the server agreed with it. Renamed `issueHasCloseReason`.
- `apps/server/src/modules/messages/characterization-support.ts` re-declared
  `OPERATOR` byte-identically. Replaced with a re-export.

---

## 6. The named reviewer pass

**Reviewer:** the POD-335 session (`Manifest error level, rules retired`),
2026-08-03. Recorded per the issue's requirement that file-size caps are REVIEW
SIGNALS, not proof, and that the exit review confirm no split preserved a god
object through shared mutable context.

**Method.** `bun run audit:god-objects` is clean (26 modules over 600 lines, each
carrying a reviewed exception whose structural predicate still holds). That
green was deliberately NOT taken as the answer: the audit's own "what this
instrument cannot see" section states that it measures one file at a time and is
therefore blind to exactly the coupling this review is asked about. So the pass
went after its three named shapes directly.

**Finding 1 — RESOLVED.** `observationLeases`, the audit's own example of a raw
`Map` shared by reference across three modules, is now a typed
`SessionObservationLeases` owner with `get`/`record` (POD-1396, done). No raw
map crosses that boundary.

**Finding 2 — OPEN, filed as POD-1553.** `sessions: Map<SessionId, Session>` is
handed by reference to SIX modules in `apps/server/src/modules/sessions/`, and
TWO of them mutate it:

| Module | writes | reads |
|---|---|---|
| `repository.ts` | 2 (`set` L404, `delete` L283) | 8 |
| `session-kill.ts` | **1** (`delete` L124) | 4 |
| `daemon-lifecycle.ts` | 0 | 15 |
| `session-teardown.ts` | 0 | 5 |
| `session-revival.ts` | 0 | 4 |
| `view.ts` | 0 | 1 |

Six individually defensible files; one shared mutable container; two writers.
This is shape 2 verbatim — a split that makes the audit greener and the design
worse — and no gate in the tree can see it: `audit:god-objects` measures one file
at a time, and `lint:boundaries` sees no import boundary crossed. The remedy is
in POD-1553: repository as sole writer, a read-only view for the four readers so
a future writer is a compile error rather than a review question.

**Finding 3 — no duplicated visibility or grant check survives.** The census in
§5 was run over `apps/**` and `packages/**` and is now a permanent lint, so this
is not a point-in-time assertion. The two duplications the multi-user landings
left passing are removed.

**Verdict.** No god object was preserved through shared mutable context in a
module this issue touched. ONE pre-existing instance of the pattern exists
elsewhere in the sessions module family; it is measured, filed and named rather
than left for the gate to miss.

---

## 7. Also filed

| Issue | Why |
|---|---|
| POD-1543 — Terminal-client reaches up into client-core | Splitting the type-only exemption surfaced 8 `packages/terminal-client → packages/client-core` type imports: an L2→L3 inversion no legacy rule ever refused. The package-to-package upward exemption stays until it is fixed, and the carve-out is named in `checkManifestEdge` rather than silent. |
| POD-1553 — Session map shared across six modules | Reviewer-pass finding 2, above. |

---

## 8. Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| Manifest at error level, allowlist empty, CI green; every legacy rule retired with its documented equivalent | **MET** | `BOUNDARY_ALLOWLIST = []`; `ERROR_LEVEL_MANIFEST_RULES = MANIFEST_RULES`; `boundaries OK — 0 allowlisted, 0 new`; §1's table; the retirement test measures that no source still EMITS a retired id |
| Platform/role/feature constraints demonstrably still enforced (a violation of each category fails lint in a test fixture) | **MET** | §4's eleven end-to-end refusals + `scripts/boundary-retirement.test.ts` (51 cases) |
| Identity/authz/visibility single-home enforced by the manifest, with a planted-parallel-check fixture that fails lint | **MET** | `authz-single-home`, both arms; §3's table and §4's rows |
| Visibility-classification totality test verified permanent, at error level, and default-closed, with a planted unclassified-class fixture; recorded in the ledger's guardrail table | **MET** | §3.1 — (a)(b)(c) each measured, three mutations, both layers |
| Layer diagram in ARCHITECTURE.md generated from the same manifest the lint reads | **MET** | `scripts/render-layer-diagram.ts`, rendered from `MANIFEST` / `SAME_LAYER_ALLOWED` / `SAME_LAYER_TYPE_ONLY_ALLOWED`; `bun run docs:layers:check` blocks in CI and in the unit lane |

**Not in scope, and not done:** no instance-scoping rule was added. Multi-user is
not multi-tenancy; ADR 1 D5 is unaffected.

---

## 9. Verification run

| Check | Result |
|---|---|
| `bun run lint:boundaries` | `boundaries OK — 0 allowlisted, 0 new` |
| `bun run typecheck` | rc=0, Tasks 22/22 |
| `bunx tsgo --noEmit -p tsconfig.json` (scripts/) | rc=0 |
| `bun run audit:god-objects` | rc=0 — probe passed, 26 explained modules |
| `bun run docs:layers:check` | up to date |
| `scripts/{architecture-manifest,check-boundaries,boundary-retirement,render-layer-diagram}.test.ts` | 219 passed |
| `apps/server/src` + `packages/{model,sync,commands}` [`vitest.unit.config.ts`] | 359 files, 5560 passed, 1 skipped |
| `apps/web/src` + `packages/client-core/src` [**ROOT** vitest config] | 272 files, 2319/2321 — see below |

The two `apps/web` failures are load flake, and the distinction was measured
rather than assumed: `IssuePage.agent-data`, `IssuePage.agent-start` and
`IssuePage.issue-switch-reset` pass in isolation (3 files, 10 tests, rc=0), the
failing assertions timed out at 4–7 s under a full parallel run, and no file in
this issue's diff is reachable from them. Named with its config per the
operational brief: the same two paths give 79 files / 848 tests under
`vitest.unit.config.ts` and 272 / 2321 under the root config.
