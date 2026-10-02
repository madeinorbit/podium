# Command and launch menu pool readers

The web command palette, panel launch menu and new-task composer use the existing
runtime's shared pool when `?mobxCommands=1` is present at startup. The switch
defaults OFF and is latched once. `mobxCommandsCheck=1` additionally enables the
explicit side-by-side diagnostic; changing the URL later does not switch readers.
All commands and mutation actions retain their existing owner.

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

## Evidence

Validation results and planted controls will be recorded here after the shared
seam lands. Focused checks run only in `~/podium-test-5165` on flatblock with its
checkout `.toolchain`. Chromium drives the actual command palette, panel menu
and composer over one synthetic offline runtime; its mutations are fixture
callbacks. Operator replay is restricted to ludovico and prints only counts and
comparison positions, with raw rows and credentials confined to memory.

## Rollout and retirement

Keep the startup switch OFF until the operator elects to enable this screen.
Retire its legacy branches about one week after the operator defaults it ON,
following the parent migration's comparison and rollback recipe. This change
does not start that week or retire the rollback reader.
