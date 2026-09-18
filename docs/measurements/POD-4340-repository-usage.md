# Repository picker usage scans

The ColdStartComposer repository picker now checks session usage inputs once per changed
session array and retains the usage index when those inputs are equal. Material changes
build one path-prefix maximum index; repository roots and linked worktrees then use map
lookups. The cache belongs to the mounted composer and retains only its latest scope.

## Before selection

The existing memo depends on full `sessions` identity. It filters shells, then calls
`repoUsageAt` for every raw repository. At 500 repositories and 4,304 non-shell sessions,
that is 2,152,000 session visits per recomputation, plus the shell-filter pass. Sort
comparisons already use a map; they are not the repeated session scans. Material inputs
are shell membership, cwd and lastActiveAt, not status, title, archive state or machine.
This establishes both the invalidation and repeated-scan problems and motivates a
material cache plus prefix index rather than an identity-only memo or delayed update.

The reported live baseline attributed 5,494 ms self CPU to repoUsageAt over 65.8 seconds.
This change does not claim a new live timing or a measured live material-change frequency.

## Focused counterfactual evidence

`packages/client-core/src/viewmodels/repository-usage.test.ts` drives the legacy helper
and the production selector over 500 repositories and 4,304 sessions, then replaces all
session entities three times with unchanged usage fields. Instrumented array iteration
counts actual session visits; A2 store-stats counts material scans and index derivations.
Warmup is excluded. Shell filtering is outside the counted legacy inner scans, making
that arm a conservative count of the old work.

| Three idle frames | Legacy | New |
| --- | ---: | ---: |
| Session visits | 6,456,000 | 12,912 |
| Material checks over session array | 0 | 3 |
| Usage derivations / index builds | 3 | 0 |
| Nonzero repository choices per frame | 500 | 500 |

Session visits fall 99.8% (500x). All 500 usage values on all three frames are asserted
equal across arms. The legacy arm explicitly exceeds the new 12,912-visit budget, so
this instrument rejects the unfixed path. Component sorting retains its existing
checkout filter, clone aggregation and name tie-break; its memo now depends on the
stable usage index rather than full session identity.

The material-invalidation case records 9 material scans and 6 index builds, including
initialization. Non-shell agent-kind changes and title/archive/status changes preserve
index identity. Cwd, lastActiveAt, entering/leaving shell membership and removal rebuild.
Other regression cases cover MRU changes, removal of a maximum, linked worktrees,
independent/empty scopes, invalid and pre-epoch dates, nested and similarly prefixed
paths, relative paths, and literal trailing/double slash behavior. Existing machine and
archive semantics are retained; the new code does not add a scope filter.

## Validation and limits

Ran `bun run test:file -- packages/client-core/src/viewmodels/repository-usage.test.ts`:
1 file, 4 tests passed, 1.22 seconds test execution. This is focused unit evidence, not
a full-suite, typecheck, browser or live CPU result. No interaction boundary changed.
Remaining work per changed array is O(sessions) material comparison. Material changes
also cost O(total cwd length) to build prefixes; repository lookup no longer scans
sessions. Repository-wire changes still recompute the existing structure and sort.

A2 counters `repositoryUsage.materialScan` and `repositoryUsage.indexBuild` are off by
default and use the selector as their component-local owner. Enable with
`__podiumStoreStats.enable()` and disable with `__podiumStoreStats.enable(false)`.

## Revert

Revert the single implementation commit to restore the old composer memo and remove
this selector, export and tests. No data, wire format, settings or migration change is
involved; `repoUsageAt` remains unchanged for existing callers and the legacy test arm.
