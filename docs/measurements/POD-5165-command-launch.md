# Command and launch menu pool readers

The web command palette, panel launch menu and new-task composer read the existing
runtime's shared pool when the device's shared MobX pilot setting is enabled.
The setting defaults OFF. `?mobxCommands=1` and `?mobxCommands=0` override this
screen, and `mobxCommandsCheck=1` additionally enables the explicit comparison.
Hydrated UI state and URL choices latch before the first render; later URL,
setting or principal changes take effect after reload. Commands and mutation
actions retain their existing owner.

## Allocated scope and baseline

The coordinator allocated the web component files, their focused tests, new
command source/projection/diagnostic modules, two supplied-session guard seams,
the palette boundary hook and the optional precomputed repository views input.
POD-5167 owns source registration and cold-summary mode; this issue adds its
screen entry after that handoff. NewIssueDialog ownership was mailed to POD-5080,
and shared selection declarations to POD-5077.

Baseline evidence is in [the legacy reader inventory](POD-5082-legacy-reader-inventory.md),
lines 217–227 and its callsite appendix:

| Surface | Baseline acquisition | Pool acquisition |
| --- | --- | --- |
| CommandPalette | Selectors at 102, 143 and 268; replica issues at 305; sidebar projects for spawn targets | Declared window/catalog, issue summaries, resident relations and selected detail |
| CommandPaletteBoundary | `paletteOpen` selector at 18 | Declared window row |
| NewPanelMenu | Choices selector at 141; recent-file/actions selector at 409 | Repository/worktree/machine relations, session summaries and window recents |
| NewIssueDialog | Choices and RPC selector at 219 | Pool launch choices plus the existing stable RPC handle |
| ConfiguredIssueLaunchSheet (mobile) | RPC selector at 42 | Stable `useTrpc` handle |
| NewIssueScreen (mobile) | Combined repository/RPC selector at 47 | Stable RPC handle; repository/session readers remain pending mobile wiring |

Per the coordinator's allocation, mobile NewWorkButton, NewIssueScreen and
LaunchConfigurationFields retain their current pool-dependent choice derivations
until POD-4976 supplies the mobile pool provider. Shared catalog/descriptor and
mutation handles already use POD-5161's stable access. No second mobile runtime,
replica, outbox or provisional pool was added, and no new issue was filed for the
explicitly reserved mobile work.

## Declarations and reads

`command-launch-schema.ts` declares window locals (palette, pins, selected/open
issue, worktree, focused session, recents and sidebar settings), catalog key order,
raw discovery repositories, grouped repositories, worktrees, machines and the
issue-summary alias. Relationships cover group members, worktrees, machine
placement, explicit issue members, exact worktree sessions, repository containment
and window selection. Only resident sessions enter the maintained indexes.

Cold issue/session fields are declared before first ingest through
`commandLaunchScreen.options`. Browsing and repository ranking read only
`pool.row(..., 'summary')`. Selected task commands request full rows through the
normal reader and its batched loader. Missing rows remain LOADING; the enabled
path never falls back to legacy derivation. All row values, including source
extension rows, come through the one pool reader.

Existing pure command eligibility, formatting and machine policy helpers keep
their behavior. Repository grouping, picker ranking and palette spawn targets
are computed in the pool projection; the enabled path does not call
`reposToViews`, `repoUsageAt`, `lastUsedMaps`, the worklist slice or replica issue
viewmodel derivation. Shared close/delete guards accept supplied sessions and
acquire only stable actions, preserving their existing legacy callers.

The existing pool chooses parked resume-group winners. The command catalog uses
the declared two-string resume identity to preserve the legacy list's first-slot
replacement order, without retaining a cold relation index or repeating the
winner derivation. The shared guard APIs accept `SessionView` arrays:
`useSessionGuard(id?, knownWorking?, sessions?)`, `useIssueCloseGuard(sessions?)`
and `IssueCloseDialog sessions={sessions}`. Hosts choose the reader once per
mount and supply an empty array while their pool is loading.

## Evidence

Acceptance was repeated after rebasing onto `a83e67944d` on 2026-10-02. All
validation runs use `~/podium-test-5165` on flatblock with the checkout's
`.toolchain` (Bun 1.4.2); the coordinator requested focused files only.

| Check | Result |
| --- | --- |
| Root `bun run test:file -- <12 named files>` | 51 tests: graph 5, web 30, mobile 16; 12 files, zero failed groups |
| Root filtered `bun run typecheck` | All 17 graph/web/mobile dependency tasks successful; normal cache policy |
| Exact graph ESLint files | Schema, source, views, focused test, comparison and replay: exit 0 |
| Synthetic graph parity | Initial state and 13 addressed scenarios, eviction, selection, recents and rescope match |
| Cold browsing | Zero loads and unchanged resident issue count; selected detail returns pending and loads in the existing batch |
| Resident maintenance | Session activity leaves repository/window publications unchanged; explicit issue membership moves by addressed delta |
| Resume ordering | A newer parked winner occupies its group's first slot, without warming cold twins |
| Chromium interactions | Keyboard task navigation, New Shell and task creation; identical mutation inputs in both modes |
| Chromium comparison | 10,622 positions, zero differences and zero pending |

The twelve focused files are `command-launch.test.ts`, `CommandPalette.test.tsx`,
`CommandPaletteBoundary.test.tsx`, `new-panel-menu.test.tsx`,
`pool-screens.test.ts`, `NewIssueDialog.agent-start.test.tsx`,
`issue-lifecycle.test.ts`, `issue-lifecycle.pool.test.tsx`,
`use-session-guard.pool.test.tsx`, `command-launch-data-layer.test.ts`,
`NewIssueScreen.selectors.test.tsx` and `launch-configuration.test.ts`.
These are focused results, not a full-suite or lean-gate claim.

Chromium drives the actual menus over one synthetic offline runtime, replica and
outbox with 5,600 tasks and 5,014 sessions. Fixture callbacks record mutations;
no backend or daemon is started. The fixture initializes readers at the same
pre-render boundary as AppShell. The counts-only runner is
`apps/web/test/command-launch-proof.ts --counts-only`.

| Activity | Legacy selectors / derivations / menu reads | Pool selectors / derivations / menu reads | Legacy / pool React commits |
| --- | --- | --- | --- |
| 40 session publications with palette open | 560 / 12 / 160 | **0 / 0 / 0** | 80 / 18 |
| 10 session publications with composer open | 90 / 0 / 40 | **0 / 0 / 0** | 10 / 0 |

Counts are browser observations, not click-time measurements. Per the resume
instruction, timing work remains with POD-5089. The final browser run is green;
an earlier run exposed a fixture startup mismatch after the shared pilot latch
landed, which the fixture now reproduces correctly.

All 13 planted controls were caught, with source bytes restored
afterward: wrong issue title, browsing via full-row demand, omitted resident
session edges, self-comparison hiding faults, repeated startup latching, ignored
shared setting, legacy selectors in each supplied guard, forced legacy palette
reader, wrong panel launch path, a selector in the composer, parked-winner
ordering, and the operator replay's title mismatch. The comparator fixture also
plants value, ordering and membership faults while detail is pending.

The final ludovico replay covers **5,968 issues, 5,139 sessions, six machines and
571 repositories**. Five browse/selected contexts compare **55,745 positions
with zero differences and zero pending**. The operator title plant produces
5,968 mismatches in the browsing context, first field `title`, and exits 1.
Source hashes match their original bytes after restoration.

The replay emits only counts and safe comparison positions. Raw rows and
credentials stay in memory. Final operator wire version is 4. An earlier replay
used version 3; only fixture metadata is adapted to the candidate version for
the existing strict parser, retaining actual payloads and checking frames,
transfer identity, counts and completion. Both readers use the current
normalized session display joins, leaving retired wire extras inert. This is a
row-fixture comparison, not evidence of a connected old-wire product client.

## Rollout and retirement

Keep the startup switch OFF until the operator elects to enable this screen.
Retire its legacy branches about one week after the operator defaults it ON,
following the parent migration's comparison and rollback recipe. This change
does not start that week or retire the rollback reader.
