# POD-1105 — boundary gate evidence

Verification record for "Boundaries gate green on integration". The gate is one of the four lanes
every POD-279 implementer is told to run, so this file exists to make the green claim auditable
rather than asserted.

## Before / after

| | `bun scripts/check-boundaries.ts` |
|---|---|
| Base (`201dd989`, = `issue/279-integration`) | **exit 1** — 69 violation lines: 1 hard failure + 18 NEW manifest violations + 48 allowlisted warnings |
| This branch | **exit 0** — `boundaries OK — 58 allowlisted, 0 new` |

The allowlisted total rises (48 → 58) while NEW falls to zero. That is the reconciliation, not a
loosening: see "Ledger reconciliation" below.

## The hard failure, diagnosed rather than assumed

`apps/server/src/modules/sessions/service.ts` imports `acceptAgentObservation` from
`@podium/agent-bridge`, which rule `agent-bridge-consumers` forbids.

Established before deciding, as the brief required:

- **What the symbol is.** It lives in `packages/agent-bridge/src/agent-state/causal.ts`, whose only
  imports are *types* from `@podium/protocol`. It contains no harness knowledge — it is a
  protocol-level causal state machine (cursor succession, binding version, terminal fence). So the
  import does not create the harness coupling the rule exists to prevent; it records that the symbol
  sits in the wrong package. Same debt class as the two already-allowlisted siblings.
- **Whether it was new debt.** No. This ledger was authored **2026-07-16**; the import landed
  **2026-07-18** (`ae03d500`, "Establish causal session reattachment"). It is an entry never added,
  refused by nobody because `bun run lint` dies at biome before this gate runs (POD-30).

Resolution: allowlisted with the siblings' `POD-740` phase and a justification naming *why*.

## The harness-branching half

The brief listed 7 violations; there were **18**. Treatment differs by kind, deliberately.

### Relocated, not allowlisted — `apps/web` (5 sites) and `packages/composer` (2)

- Brand tone in `WorkerLabel`, `SidebarUnified`, `SidebarRail` and `AgentPanel`'s model dot became
  per-kind tables in `apps/web/src/lib/agent-tone.ts` — the fix those entries' own notes prescribed.
  Three allowlist entries went to zero and were **deleted** (a zero-count entry fails the gate).
- Two genuine capability decisions moved into the one declarative table (`AGENT_CAPABILITIES`):
  `promptModeHints` (the prompt-chrome hint row) and `handoff` (issue-row eligibility).
- `packages/composer`'s driver `if` chain became a registry `Record`.

`packages/domain`'s identical claude/codex pair was left alone on purpose: domain is L0 and protocol
is L1, so it cannot read the capability table without inverting the layer order.

### The composer decision — neither option in the brief

The brief offered "move it into the agent-bridge adapter" or "declare composer a second sanctioned
home". Both are worse than the registry form:

- **Moving it into `packages/agent-bridge` would be actively wrong.** composer is browser-safe
  (apps/web aliases it in `vite.config.ts`; terminal-client re-exports its extractors into the
  browser bundle) and agent-bridge is node-only. The move trades a harness-branching violation for a
  `manifest-platform` one and drags node code toward a browser bundle. **ADR 0008 already rejected
  this exact shape** for pure mappers: "would force harness deps on browser-safe consumers of pure
  parse."
- **A second sanctioned home was unnecessary** — and a sanctioned second home is the kind of
  exception that quietly becomes N homes, since every later package with a per-CLI concern would
  cite it.
- **What the branching actually was:** adapter *selection*, not behavior. The per-harness behavior
  already lives in the two driver objects — they *are* the adapters. The axiom explicitly blesses a
  `Record` keyed by harness, because a table makes adding a harness a new row instead of a
  found-and-edited `if`. `composerDriverFor` is now that table.

Recorded in the axiom's own docstring in `scripts/architecture-manifest.ts` as the precedent for
adapter selection, so the next reader finds it where the rule is defined.

## Ledger reconciliation — site by site, not by bumping numbers

The other 11 violations are backend debt no implementer on this branch introduced. Each added site
carries the commit and date that produced it:

| File | Count | Added sites |
|---|---|---|
| `apps/server/src/modules/sessions/service.ts` | 5 → 9 | `:2947` (codex half of an already-counted pair), `:4921`/`:4926` (`bebb8127f`, 2026-07-15), `:5031` (`86fd9b597`, 2026-07-07) |
| `apps/daemon/src/session-observers.ts` | 2 → 6 | `:1018` (`3578f3ece`, 2026-07-16), `:1313`/`:1342`/`:1356` (`8de33f327`, `5af0138b6`, 2026-07-19) |
| `apps/daemon/src/control/credentials.ts` | *absent* → 2 | `bd9e99c0b`, 2026-07-23 |
| `apps/daemon/src/control/session.ts` | *absent* → 1 | `783cd0c96`, 2026-07-18 |

Four sites **predate** the ledger — a miscount corrected. Seven arrived **after** it and were never
refused because the gate was dark. Raising a count to measured truth weakens no rule and narrows no
detector; the ledger's own contract is that counts are MEASURED. It does make those four files'
floor honest instead of flattering, which is why the reconciliation is dated in the header.

**No rule was weakened, retired, or turned down. No detector stopped matching.**

## Mutation check — three ways, each red then green again

| Mutation | Result |
|---|---|
| Reintroduce a harness branch in the file just cleaned (`agent-tone.ts`) | **exit 1** — flagged at `agent-tone.ts:70` |
| One EXTRA branch in an allowlisted file (`credentials.ts`, declared 2) — the over-count path the backend reconciliation relies on | **exit 1** — flagged as NEW at `:143` |
| A NEW `apps/server` consumer of `@podium/agent-bridge` — the legacy rule an entry was just added to | **exit 1** — `Dependency-boundary violations (1)` |

Each was reverted and the gate returned to `exit 0`.

## Other lanes

> **Verification posture (revised).** The coordinator diagnosed the box as swap-thrashing (16GB of
> swap in use, run queue over 200) and serialized the memory-heavy lanes behind a `test-lane` lease,
> stating they would rather have honest targeted-lane evidence than a full-lane run that segfaulted
> under thrash. So the full suite below is reported as measured *before* that rule, with its three
> failures individually exonerated, and the primary evidence is the targeted lane plus the cheap
> gates. I took the lease, found the box still thrashing from processes that never took it (so a
> "clean" full run was not actually available), released it for the agents queued behind me, and
> killed the four orphaned workers my stopped run left in this worktree.

| Lane | Result |
|---|---|
| **Targeted lane** (`vitest.unit.config.ts --project node`, the test files covering every changed file: protocol capabilities, composer driver + prompt-extract, issue-context-menu) | **exit 0 — 130 passed** |
| **Gate's own tests** (`scripts/architecture-manifest.test.ts`, `scripts/check-boundaries.test.ts` — they own the allowlist and manifest I changed) | **exit 0 — 134 passed** |
| Scoped typechecks: `@podium/protocol`, `@podium/composer`, `@podium/web` | **all PASS, zero `FULL TURBO`** (real work executed, not cache) |
| `bun scripts/check-no-nul-bytes.ts` | **exit 0** |
| `bun run typecheck` (whole repo) | **20/20 successful**, `3 cached, 20 total` — 17 packages actually executed, so not a `FULL TURBO` no-op. A `--force` run was NOT made: it is memory-heavy and now requires the lease |
| `bun scripts/rearch-audit.ts` | **exit 0** — "deletion audit OK — 21 items, 264 sites remaining (baseline exact)" |
| `bun run --filter '@podium/web' build` | **exit 0** — bundle builds, so the new module and protocol import resolve through vite |
| `bun run test` | 3 files failed / 410 passed, 5252 tests passed. **All three exonerated below.** |
| biome on changed files | No new issues. `SidebarUnified.tsx` keeps exactly its 2 pre-existing errors (verified by running biome against `HEAD`'s content on disk) — the formatter's unrelated fixes to that file were deliberately reverted to keep the diff scoped |

### The three test failures are not this change

- `scripts/rearch-audit.test.ts` — **flake**: passes **51/51** run alone; a different subset fails
  under contention. Its gate also passes standalone (lane above).
- `apps/daemon/src/connectivity-state.test.ts` — **flake**: failed alone once, passed on re-run.
- `packages/terminal-client/src/terminal-view.keyboard.test.ts` — **pre-existing**: a `beforeAll`
  hook timeout (10s) that skips all 13 tests. Proven not mine: with **every file I changed reverted
  to base content in place**, it fails identically.

One method note, since it nearly produced a false result: an attempt to probe the base commit in a
scratch worktree with symlinked `node_modules` produced a **startup error**, not a test result (vite
writes its temp config into the real `node_modules` path). That run was discarded rather than read as
base-red. `biome check --stdin-file-path` was likewise found to silently skip format/assist checks,
so baselines were measured against files on disk.
