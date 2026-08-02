# POD-325 exit audit

Audited on `issue/325-5-3-harness-pty-audit` from integration `27f78f89` on
2026-08-02. Overall verdict: **OUTSTANDING**. Criteria 1, 2, 3, 5 and 6 are met
after two small audit fixes on this branch; criterion 4 still lacks an all-five
real-binary end-to-end matrix and the current real-agent lane is not green.

## 1. Package split and independent lanes — MET

- `git ls-files packages/agent-bridge` returns no files, and
  `packages/agent-bridge` does not exist on disk. There is therefore no leftover
  `dist/`, `node_modules/` or `.tsbuildinfo` under the deleted package.
- `scripts/architecture-manifest.ts` places both `packages/pty` and
  `packages/harness` at L2. `bun run lint:architecture` reports 0 new
  violations (two unrelated allowlisted desktop warnings).
- Both independent builds pass: `bun run --cwd packages/harness build` and
  `bun run --cwd packages/pty build`.
- The package-local test scripts initially were not independent: harness
  collected 37 files but 28 suites failed workspace import resolution, while
  pty incorrectly collected three `bun:test` files under Vitest. This branch
  makes both scripts select the root Node project explicitly. Final evidence:
  harness **35 passed / 2 skipped Test Files, 467 passed / 3 skipped Tests**;
  pty **4 passed Test Files, 22 passed Tests**.

## 2. One exhaustive manifest per CLI — MET

- `packages/harness/src/manifests/` has one manifest for each of Claude Code,
  Codex, Grok, OpenCode and Cursor. The only registry is
  `AGENT_MANIFESTS: Record<BuiltinHarnessKind, AgentManifest>`; capability
  accessors read it rather than a parallel table.
- `bun scripts/rearch-audit.ts --phase POD-325` reports the
  `capability-tables` audit item at zero.
- The committed registry suite passes as part of the harness package lane and
  checks every capability and incremental-completeness field.
- Compile-time totality was proved with a temporary sixth kind. With
  `@ts-expect-error`, harness typecheck passed; removing only that directive
  failed with TS2741: property `"pod-325-probe"` is missing from the five-entry
  registry. The probe was then removed completely.

## 3. Corrected harness axiom at error level — MET

- `HARNESS_ADAPTER_HOME` is `packages/harness`; lookup maps are the declared
  data-driven exception, while comparisons and switches outside that package
  are violations.
- CI invokes `bun run lint:architecture` as its own blocking step in
  `.github/workflows/ci.yml`; it is not relying on the non-blocking general lint
  step. The live command passes with 0 new violations.
- The committed `--probe` inserts a Codex branch under `packages/pty`.
  `bun scripts/check-boundaries.ts --manifest-only --probe` fails with one new
  `harness-branching` violation. The detector tests pass: **2 Test Files, 192
  Tests**.

## 4. All-five daemon/discovery/transcript E2E and real smokes — OUTSTANDING

The deterministic coverage is green:

- daemon launch/headless argv matrix: **2 Test Files, 22 Tests**;
- all-five discovery-provider matrix with `PODIUM_REAL_CLI=1` so the installed
  OpenCode path actually ran: **5 Test Files, 39 Tests**;
- all-five transcript mapper matrix: **5 Test Files, 56 Tests**.

All five binaries are installed on the audit host. The configured real-agent
lane (`bun run test:smoke:agents`) collected **7 Test Files** and **18 Tests**:
**5 files passed, 1 skipped, 1 failed; 16 tests passed, 1 skipped, 1 failed**.

| CLI | Real-binary cases that actually ran | Skipped / absent | Result and limitation |
|---|---:|---:|---|
| Claude Code | 3 | 1 | 2 passed; the brevity evaluation failed because the live answer had 4 sentences against a 3-sentence threshold. The node-pty smoke skipped because the current HOME was not trusted by its readiness check. |
| Codex | 2 | 0 | Headless resume and official-hook cases passed. |
| OpenCode | 2 | 0 | Binary resolution/help detection passed; there is no real turn/resume E2E in the lane. |
| Cursor | 1 | 0 | Binary resolution/help detection passed; there is no real turn/resume E2E in the lane. |
| Grok | 0 | 0 | No real-binary smoke is collected at all. |

This criterion cannot be called met from skip-if-absent green: Grok has no
instrument to run or skip, and OpenCode/Cursor only prove detection. Completing
the missing real turn/resume coverage for Grok, OpenCode and Cursor, plus making
the Claude lane reliably green without weakening its behavioral assertion, is
larger than this audit and should be scheduled separately.

## 5. Principal-free package seam — MET after audit fix

- A production-source scan finds no user, principal, grant, authorization or
  visibility identifiers in either package (the only `authorize` matches are
  OAuth URL text in harness tests/comments).
- The existing lint claimed pty coverage but omitted `packages/pty` from
  `PRINCIPAL_FREE_WORKSPACES`; its test comment named pty while probing a harness
  path a second time. This branch adds pty to the rule, changes the mutation to
  a real pty path, and includes the real pty source tree in the clean-tree test.
  The boundary detector suite passes (**2 Test Files, 192 Tests**).
- `HarnessCapabilities` remains deliberately excluded: it describes software
  support, not an authorization capability.

## 6. Machine-keyed resolved inventory and visibility — MET

- `MachineHarnessInventory` requires `machineId`; `buildMachineInventory`
  requires it with no ambient default. The daemon cache key is
  `(machineId, homeDir)`, and `inventoryReport.machineId` comes from the resolved
  value.
- ADR 1 Amendment 1 D13.5 classifies harness and model inventory as a
  per-machine fact: owner `inherits Machine`, visibility `owned-compute`, grants
  inherited from Machine (`see` / `use` / `manage`). It is explicitly not
  tenant-visible infrastructure.

## Final verification totals

- Full `bun run test`:
  - Node unit + normalized-wire: **638 passed / 3 skipped Test Files, 9,343
    passed / 19 skipped Tests**.
  - Web: **182 Test Files, 1,456 Tests**, all passed.
  - Mobile: **4 Test Files, 34 Tests**, all passed.
  - Bun SQLite: **1 Test File, 14 Tests**, all passed.
- Workspace typecheck: **22/22 tasks** successful.
- Package builds, package tests, capability-table audit, blocking architecture
