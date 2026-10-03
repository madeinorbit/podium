# POD-4977 — mobile WorkScreen from the pool

The startup-latched mobile pilot selects a separate pool WorkScreen. Its rows,
bands, counts, search, disclosures, styling and navigation use the existing UI.
The legacy WorkScreen body remains unchanged when the pilot is off. All writes
still use the StoreProvider's existing actions and outbox.

## Native data and subscriptions

SectionList receives plain immutable data arrays cached independently for each
resident project and the pinned/attention bands. Equal lane contents retain
their array; equal sections retain their object. Fold changes replace the
affected section only. Payload changes do not map a complete row world into
SectionList. A membership change can rebuild its affected lane; this does not
promise constant-time membership maintenance inside that lane.

Each native slot reads through `pool.mobileWork.row`. Its equality-filtered
projection contains paint and navigation facts, excluding full issue/session
records and bookkeeping. A missing payload renders loading and requests the
existing batched load. Hooks stay mounted while the shared pool attaches.
Full menu compatibility data is acquired through pool readers on the gesture.

The mounted NewWorkButton uses the shared command-launch source with the pilot
on, avoiding its former worklistSlice subscription. Its existing launch UI and
mutation path remain in use. The shared host still owns one app runtime,
replica and outbox. The landed preference, notice and settings options are
preserved.

## Native acceptance

The fixture mounts the real StoreProvider, normalized kernel replica facade,
pool, react-native-web SectionList, WorkRow, row parts and NewWorkButton. Only
platform/navigation chrome and menu/sheet containers are replaced. Both arms
receive the same synthetic corpus, principal, pins and clock.

At **1× and 4×**, mounted text, accessibility labels and inline styles are
identical. The full mobile differential checks cover all declared row and
section values, including rows outside the native initial window.

| Check | 1× | 4× |
| --- | ---: | ---: |
| Scenario/fold comparisons | 34 | 34 |
| Value differences | 0 | 0 |
| Unchanged native data identities retained | 388 | 528 |

Three observed seeds of 200 changes each also report **zero differences**.
Pinned attention duplicates keep distinct list keys; loading, batched reads,
eviction, draft quietness and navigation match the legacy model.

The identity assertion runs at every observed publication. Keeper eviction
can legitimately move a rescue parent into and back out of a lane within one
scenario. Comparing consecutive publications checks unchanged lanes without
requiring historical versions of changed lanes to remain resident.

React Profiler counts update commits for the mounted native rows, excluding
initial mounts. Both scales produce the same table:

| Change | Legacy row commits | Pool row commits |
| --- | ---: | ---: |
| Unshown description | 9 | 0 |
| Shown title | 9 | 1 |

Only the renamed row commits on the pool arm; section geometry keeps identity.
Guards reject a legacy slice subscription or a legacy row/fleet derivation
anywhere on the tested pool work/launch path. Search overrides folds, match
counts are native counts, and long press resolves the correct pool menu row.
The real MobileClientProvider/SQLite attachment test mounts a row before the
lazy pool attaches and observes loading-to-absence without a hook-order error.

POD-4946's window/native meter landed before this consumer work. This proof
uses its stable-lane contract and the real RN-web list; these are native model
and browser-renderer results, rather than device CPU measurements.

## Planted controls

Each control used a committed input, cp backup, planted source error,
foreground flatblock run and cp restoration. No assertion or lint rule was
disabled.

| Plant | Observed failure |
| --- | --- |
| Copy every native section/data array | Native data identity fails at both scales, including the final observed-publication check |
| Include unshown description in row projection | Pool description commits become 1 instead of 0 at both scales |
| Omit pool fleet display prop | Legacy row derivation guard fires |
| Force legacy launch inputs | Legacy slice subscription guard fires |
| Ignore a native fold | Collapsed pinned data remains nonempty |
| Ignore search | Returned rows fail the independent title-match assertion |
| Return loading before the row hooks | React reports more hooks than the previous render |
| Prefix the actual native status formatter | Mobile corpus reports 215/815 differences at 1×/4× |

## Validation and production boundary

All tests, typecheck and lint run on flatblock in the issue's isolated
`~/podium-test-4977` checkout, with its own Bun 1.4.2 toolchain and dependency
links. Commands are bounded and foreground. Only synthetic fixture/harness
data is used; operator data is not copied or captured.

Completed native checks: **22 passed across four named mobile files**. The
mobile model's six existing loading/draft/key/random checks pass; its two
revised corpus/publication checks pass separately, with six unchanged checks
excluded from that second run. Uncached changed-project typecheck is **3/3
green** before the preference/settings rebase. These are focused results, not
a full-suite claim.

Rebased mobile integration and final static validation are in progress.
POD-5375 owns the test-only projection callback repair: its factory lives
outside the component, keeping the shared hook's fresh-reader counts without
adding observer or lint exemptions. Production seeded-issue export acceptance
is blocked by POD-5370 and tracked by internal POD-5374. The three-row
off/on style comparison and interleaved Chrome Paint/heap capture are prepared
for the landed root fix; no production timing result is claimed yet.
