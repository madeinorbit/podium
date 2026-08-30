# Acceptance matrix reconciliation — 2026-08-30 21:27:04 CEST

This is a static reconciliation of `docs/plans/pod-1761-results.tsv`; it did not
launch a provider, Podium runtime, browser, daemon, server, or sandbox, and it
did not change any scored row or release document.

## Provenance

| fact | value |
|---|---|
| required base | local `issue/1761-agent-runtime` |
| epic tip reconciled | `cf51240509326cf6910e9cb13f4d65ad20d59abd` |
| epic tip commit time | `2026-08-30 21:10:59 +0200` |
| worktree `HEAD` before edits | `cf51240509326cf6910e9cb13f4d65ad20d59abd` |
| ancestry proof | `git merge-base --is-ancestor issue/1761-agent-runtime HEAD` exited 0 |
| source | `docs/plans/pod-1761-results.tsv` at that tip |

## Row shape and selection

The file has 396 non-comment data rows. Splitting on literal tab characters
produces exactly eight fields for all 396; zero rows have `NF != 8`. The header
is not a data row.

For acceptance rows, the cell is the first standalone `A1a`–`A11` token in
`what`. The verdict is only the leading alphabetic token from `verdict`:

```text
re.split(r'[^A-Za-z]+', verdict.strip().upper())[0]
```

Rows labelled `[parent]`, `(PARENT arm)`, `MAIN baseline`, or `MAIN comparison`
are controls, not release verdicts. For each cell and normalized
driver/posture, rows are ordered by parsed instants (ISO-8601, explicit CEST,
then legacy date-only rows at local midnight); file position only breaks an
exact timestamp tie. `REFUSED`, `UNDRIVEN`, `UNOBTAINABLE`, and `INCONCLUSIVE`
remain attempt records but do not replace the latest scored/control-valid
outcome. In particular, a `REFUSED` row says that the instrument declined to
score, not that the product failed.

Driver aliases are conservative: historical `*-headless` names fold into the
same concrete server driver, explicit `*-terminal` names fold into that
harness's PTY posture, and a bare `generic-pty` folds only when its row names
the harness/run unambiguously. No cross-driver inference fills a blank cell.

### Negative checks

All three checks executed against the selection rules at 2026-08-30 21:27:04
CEST:

- Substring rejection: `PARTIAL ... scrollback clause is UNMEASURED` classified
  as `PARTIAL`, not `UNMEASURED`.
- Malformed shape rejection: `NF=7` false, `NF=8` true, `NF=9` false. This
  rejects both too-few and too-many fields.
- Supersession rejection: even when supplied in reverse order, OpenCode A7a
  `FAIL` at `ba420c566…` / `2026-08-30 12:27:39 CEST` lost to `PASS` at
  `d6df08c41…` / `2026-08-30T18:40:47.141Z`.

## Latest verdict grid

`†` means the selected scored row is genuinely stale at the epic tip after the
path-blast audit below. `current` means no non-doc byte changed after the row
pin. `R` records a later refusal without replacing the scored outcome. `—`
means no qualifying row; it is not a pass.

| cell | Codex H | Codex PTY | OpenCode H | OpenCode PTY | Grok H | Grok PTY | Claude SDK H | Claude PTY | shell native |
|---|---|---|---|---|---|---|---|---|---|
| A1a | PASS† | PASS† | PASS† | PASS† | PASS† | — | PASS† | BLOCKED† | PASS† |
| A1b | PASS† | — | PASS† | PASS† | PASS† | — | PARTIAL† | PASS† | — |
| A1c | PASS† | — | PASS† | BLOCKED† | PASS† | — | BLOCKED† | PASS† | PASS† |
| A2a | PASS† | BLOCKED† | PASS† | PASS† | PASS† | — | PASS† | PASS† | — |
| A2b | PASS† | — | PASS† | — | PASS† | — | PASS† | PASS† | PASS† |
| A3 | PARTIAL† | PARTIAL† | PASS† | FAIL† | PASS† | — | PASS† | FAIL† | — |
| A4a | PARTIAL† | — | PASS† | BLOCKED† | PARTIAL† | — | BLOCKED† | BLOCKED† | — |
| A4b | PASS† | — | PASS† | — | PASS† | — | BLOCKED† | BLOCKED† | — |
| A5 | PASS† | — | PASS† | — | PASS† | — | PASS† | PASS† | — |
| A6a | PASS† | PASS† | — | PASS† | PASS† | — | BLOCKED† | PASS† | PASS† |
| A6b | PARTIAL† | UNMEASURED† | PARTIAL† | PARTIAL† | PASS† | — | BLOCKED† | PASS† | — |
| A7a | PASS† | — | **PASS current; later R** | — | PASS† | — | PASS† | PASS† | PASS† |
| A7b | PASS† | — | **FAIL†; later R** | — | PASS† | — | PASS† | PASS† | — |
| A8 | PASS† | — | PARTIAL† | — | PASS† | — | FAIL† | BLOCKED† | — |
| A9 | PASS† | — | PASS† | BLOCKED† | PASS† | — | PASS† | PASS† | PASS† |
| A10 | PARTIAL† | PASS† | — | — | PASS† | PASS† | PASS† | PASS† | — |
| A11 | FAIL† | PASS† | FAIL† | — | PASS† | — | FAIL† | — | — |

The only current scored cell is OpenCode H A7a: `PASS` at
`d6df08c41af3883685c3f18fad0fd0fef78bfec7`. The exact command
`git diff --name-only d6df08c41..issue/1761-agent-runtime` excluding `docs/`
returned zero paths. The same is true for the later refusal pin
`1dbac781be27161162661053dded82f633dc615e`; those refusals are current evidence
that no new A7 score was produced.

OpenCode H A7b is different: its latest scored outcome is the `FAIL` at
`fa0bbc8ac752c32a2de13d6835938b2633638f31`, followed by a current unscored
`REFUSED` attempt at `d6df08c41…`. Production A7/OpenCode paths changed between
the FAIL and the tip, including `apps/daemon/src/control/session.ts`,
`apps/daemon/src/runtime/opencode-attach.ts`,
`apps/daemon/src/runtime/opencode-driver.ts`, and
`apps/daemon/src/runtime/opencode-server.ts`; therefore the FAIL is stale and
the cell is presently unscored at current code.

## Stale and non-stale path audit

For every selected candidate whose pin differs from the epic tip, the audit ran
the required full diff first:

```text
git diff --name-only ROW_SHA..issue/1761-agent-runtime -- . ':(exclude)docs/**'
```

It then intersected that output with the production path for the concrete
driver and the cell's shared surface. Documentation, tests, release tooling,
and unrelated package movement were not used to stale a reading. The selected
stale cells group as follows; this is the complete `†` set in the grid.

| driver/posture | stale cells | actual production blast-radius examples |
|---|---|---|
| Codex H | A1a–A11 (all 17 listed criteria) | `apps/daemon/src/runtime/codex-driver.ts`, `apps/daemon/src/control/session.ts`, `apps/server/src/modules/sessions/{inbox,session-start,session,terminal}.ts`, `packages/client-core/src/engine/{actions,boot,runtime}.ts`; A11 also intersects `packages/agent-runtime/src/configure-catalog.ts` |
| Codex PTY | A1a, A2a, A3, A6a, A6b, A10, A11 | `apps/daemon/src/runtime/terminal-driver.ts`, `apps/daemon/src/control/session.ts`, `packages/pty/src/{abduco,session}.ts`, and the shared client/session paths above |
| OpenCode H | A1a, A1b, A1c, A2a, A2b, A3, A4a, A4b, A5, A6b, A7b, A8, A9, A11 | `apps/daemon/src/runtime/{opencode-driver,opencode-server,opencode-attach}.ts`, `packages/agent-runtime/src/drivers/opencode/runtime.ts`, `packages/transcript/src/opencode.ts`, `packages/harness/src/agent-state/opencode.ts`, plus shared session paths; A7a is expressly excluded |
| OpenCode PTY | A1a, A1b, A1c, A2a, A3, A4a, A6a, A6b, A9 | terminal/PTY paths plus `packages/harness/src/agent-state/opencode.ts`, `packages/transcript/src/opencode.ts`, and shared session/client paths |
| Grok H | A1a–A11 (all 17 listed criteria) | `apps/daemon/src/runtime/grok-driver.ts`, `packages/agent-runtime/src/drivers/grok-acp/runtime.ts`, `apps/daemon/src/control/session.ts`, and shared session/client paths |
| Grok PTY | A10 | terminal selection/identity paths, including `apps/daemon/src/runtime/{registry,terminal-driver}.ts` and `apps/web/src/lib/runtime-driver-options.ts` |
| Claude SDK H | A1a–A11 (all 17 listed criteria) | `apps/daemon/src/runtime/claude-sdk-driver.ts`, `packages/agent-runtime/src/drivers/claude-sdk/runtime.ts`, `apps/daemon/src/control/{inventory,session}.ts`, `apps/server/src/accounts.ts`, and shared session/client paths |
| Claude PTY | A1a–A10 (all 16 pre-A11 criteria) | `apps/daemon/src/runtime/terminal-driver.ts`, `packages/harness/src/agent-state/claude-code.ts`, `packages/harness/src/manifests/claude-code-classifier.ts`, PTY paths, and shared session/client paths |
| shell native | A1a, A1c, A2b, A6a, A7a, A9 | terminal/PTY and shared lifecycle/session paths |

This classification is intentionally narrower than “the branch moved.” For
example, the current A7a reading survives later docs-only commits, while the
older A7b reading does not survive concrete OpenCode lifecycle changes. At the
other extreme, old rows are not kept merely because their driver-specific file
did not move when the shared send, session, transcript, lifecycle, terminal, or
selection path used by that criterion did.

## Missing and weak controls

- OpenCode H A7b has no current scored row: the current-tip attempt is
  `REFUSED` because the runner exited before A7b, so its older FAIL cannot be
  promoted through the later repair.
- The final OpenCode A7 orchestration attempts at `1dbac781…` are also
  `REFUSED`: no A7 checkpoint/control existed. They add no product outcome.
- `BLOCKED` rows remain visible in the grid, but a `control=no` blocker is not
  evidence about product behavior. Notable examples include the old Grok
  permission cells, Claude SDK terminal-view cells, and PTY status/permission
  cells.
- `UNMEASURED` remains a scored description of a missing criterion, not PASS.
  Codex PTY A6b is the clearest surviving historical example.
- Legacy date-only rows sort deterministically but have only day resolution;
  every one is stale by a later relevant-code diff, so this weak timestamp
  precision does not affect the current/non-current boundary.

## Review/done child audit

All 241 descendants returned by `podium issue tree --id 1761 --max-depth 3
--max-nodes 400` were surveyed. Every child in `review` or `done` with a local
branch was compared with `issue/1761-agent-runtime` using both ancestry
(`git rev-list`) and patch equivalence (`git cherry`). Historical branches from
before the epic's integrations produce many `+` patches even when their product
work was later integrated under different commits, so the audit additionally
checked tip time, changed content, and whether the issue already has rows in
`results.tsv`.

| child | stage | branch tip | ahead | content | effect on matrix |
|---|---|---|---:|---|---|
| POD-2245 | review | `6d768041a6e06d393d7fa32aa19ce05afb279665` | 1 | `docs/operator-test-instance.md` only | no acceptance row; no product movement |
| POD-3018 | review | `95b9c650ed43b9523ddd010c4ed7af2933d9a881` | 1 | Claude SDK resume code and tests | unlanded product branch, not evidence for the epic-tip matrix; its older A7 evidence cannot be promoted |
| POD-3046 | done | `3a42ca9f67948eae159f9a4322b381e6eb14e2e6` | 1 | OpenCode switch-comparison README | unlanded evidence, but later POD-3060/POD-3038 A6b rows are already selected by timestamp |
| POD-3057 | done | `73927a8d6b67cd8248084938f8927ae54098bd19` | 1 | SDK transcript-home evidence README | its two TSV references are present; no newer untranscribed verdict |
| POD-3063 | done | `bdfe85268044fd7a2bde0d0bab779b8d1990398e` | 3 | SDK native-view pre/post evidence plus an unlanded typed-refusal repair | important unlanded evidence; no scored TSV row, and the repair is absent from the epic tip, so it cannot make Claude SDK A6a/A6b current |
| POD-3119 | review | `cf4747a71548a06d61fc0ef8dfa3a00f611daeda` | 1 | only `docs/evidence/pod-3112/r18-continuity.ts` and its static test | no missed result row and no product-code movement; unlanded evidence tooling |

The older acceptance-bearing divergent branches are POD-2115, POD-2116,
POD-2293, POD-2690, POD-2691, POD-2918, POD-2919, and POD-2921. Every one has
at least one explicit row reference in `results.tsv`; none supplies a newer
acceptance timestamp than the selected rows above. Other old `git cherry +`
branches contain implementation/review history rather than untranscribed
acceptance rows. This prevents “committed on a child” from being mistaken for
“landed on the epic,” while retaining POD-3063 as the material unlanded
pre/post evidence set.

## Minimal next live cells

The smallest honest current-tip drive does not repeat OpenCode H A7a. It is:

1. **OpenCode H A7b** first, because it is the only cell adjacent to a current
   PASS whose current attempt refused and whose last product FAIL predates the
   lifecycle repairs.
2. Re-drive the `†` cells grouped by driver/posture exactly as listed in the
   stale-path table. Within each group, preserve the existing controls and do
   not turn instrument `BLOCKED`/`REFUSED` into product outcomes.

That is minimal in cell terms: every omitted scored row has a concrete relevant
production-path diff, and no other current scored row exists to carry it
forward. The grid deliberately avoids prescribing provider launch order; this
report is static evidence only.
