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

Active search caches each filtered native band as well. Matching still reads
resident rows, but an unchanged match sequence allocates no replacement row
array. Removing a title match changes its band only; the strict native
identity checks cover both scales, and a planted copy of every filtered array
fails on an untouched band at both scales.
The test drains the real batched loader after entering search, as the mobile
row's paint can request more input than section placement. Its initial 4×
attempt observed late matching-row hydration; after settling those requests,
both restored identity checks are green with the same strict assertions.

Each native slot reads through `pool.mobileWork.row`. Its equality-filtered
projection contains only native paint facts, excluding hidden navigation IDs,
full issue/session records and bookkeeping. Presses acquire the current
navigation target through that same reader; replacing an otherwise identical
session ID causes zero row commits and opens the replacement session.
A missing payload renders loading and requests the existing batched load.
Hooks stay mounted while the shared pool attaches. Full menu compatibility
data is acquired through pool readers on the gesture.

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
| Include hidden navigation in row projection | Otherwise identical session replacement causes 1 commit instead of 0 |
| Omit pool fleet display prop | Legacy row derivation guard fires |
| Force legacy launch inputs | Legacy slice subscription guard fires |
| Ignore a native fold | Collapsed pinned data remains nonempty |
| Ignore search | Returned rows fail the independent title-match assertion |
| Copy every filtered native data array | Untouched search-band object identity fails at both scales |
| Return loading before the row hooks | React reports more hooks than the previous render |
| Prefix the actual native status formatter | Mobile corpus reports 215/815 differences at 1×/4× |
| Prefix the production native status formatter | Seeded production off/on row comparison fails on the planted text |
| Log a production pool formatter error | Final application-error assertion fails with twelve planted errors after equal off/on rows/styles |

## Validation and production boundary

All tests, typecheck and lint run on flatblock in the issue's isolated
`~/podium-test-4977` checkout, with its own Bun 1.4.2 toolchain and dependency
links. Commands are bounded and foreground. Only synthetic fixture/harness
data is used; operator data is not copied or captured.

Initial native checks: **22 passed across four named mobile files**. The
mobile model's six existing loading/draft/key/random checks pass; its two
revised corpus/publication checks pass separately, with six unchanged checks
excluded from that second run. Rebased integration checks are **17 passed**:
six shared projection counts and eleven mobile consumer/provider checks in
three named files. Uncached changed-project typecheck is **3/3 green** after
the preference/settings rebase. These are focused results, not a full-suite
claim.

Graph and prototype package lint, root shadowing and span-effect lint are
green. The final plain projection fixture passed its six unchanged counting
checks, uncached graph typecheck and graph lint. POD-5375 landed that exact
test-only repair independently at `5a211c749d`; its callback factory lives
outside the plain component, with no observer or lint exemption.

The **lean gate is green: 154 tests in 4/1769 files (0.2%)**, comprising boot
(16), router setup (41), daemon connection state (56) and lane configuration
(41). The initial lean attempt could not spawn Turbo's node-shebang CLI;
the isolated checkout's `.toolchain/node` link to its pinned Bun restored
that command. No global toolchain or cache was changed.

The final active-search checks are **2 passed, 6 unchanged tests deselected**;
the changed search/fold/menu case passed separately before the readiness-only
fixture correction. The final mobile-only uncached typecheck is green, and
shadowing reports no shadowed declarations in 5,859 files. The changed-input
span-effect gate is green: 162 span bodies, 7 accepted effects, zero
unclassified effects and 8 declared opaque bodies.

The final gesture-only navigation checks are **7 passed across two named
mobile files**, with seven unchanged checks deselected. Prototype uncached
typecheck is green. Mobile typecheck initially rejected two fixture strings
as unbranded session IDs; a type-only correction passed the mobile-only retry,
without repeating the already-green runtime checks.
Final navigation shadowing is green in 5,865 files; the span-effect gate is
green with 162 span bodies, 7 accepted effects, zero unclassified effects and
8 declared opaque bodies.

POD-5370's seeded phone startup fix landed at `8db927c57f` before this
consumer's production acceptance. The restored minified Expo export passes
**all three Pixel Chromium checks**: default-off and restart-latched switch
behavior, plus the seeded real WorkScreen row/style comparison and mission
press. The three synthetic rows have **zero differences** in text,
accessibility labels and computed styles across off/on/off/on. Application
errors are zero.

The production fixture waits for the previous saved preference before changing
arms: the pilot-on preference's lazy pool attachment can initially display
the default off value. Its first console control stopped at that readiness
race and did not count. The corrected final console control fails exclusively
on the planted app error. Expected anonymous-harness 401 resource reports
are recorded separately; page errors, application console errors and other
resource errors remain failures.

The capture ran on flatblock under `bench:flatblock`, acquired after the
build completed and the 1-minute load dropped below eight. Chromium was
**148.0.7778.96**. All four arms used the same production build,
`8c178e62f9856f877155e0abe750c250840166c8`, an empty WIP checkpoint with
the same tree as local candidate `4e6f12ebe1`. The JSON and foreground browser
log are attached to this issue. The five separately recorded 401 reports
all came from the anonymous harness's `/auth/client-sessions` request.

| Browser observation, two samples per arm | Off | On |
| --- | ---: | ---: |
| Input → actual Paint, ms | 86.136 / 96.511 | 109.767 / 137.181 |
| Median input → actual Paint, ms | 91.324 | 123.474 |
| Median fresh-start → visible row, ms | 273.945 | 458.168 |
| Median forced-GC heap before press, bytes | 18,625,980 | 19,135,740 |
| Median forced-GC heap after mission, bytes | 21,109,724 | 22,128,520 |

The pool arm is **35.2% slower** in these two press-to-Paint samples; the
capture shows a row-commit reduction, not a browser timing win. Two samples
per arm on three synthetic issues are observations rather than a calibrated
mobile performance gate. Fresh-start readiness measures new principal/provider
construction on each document load, not an in-place principal switch.
These are RN-web production results, not device CPU measurements.

**POD-5389 (Mobile pilot timing overhead)** is filed in Proposed with a
`discovered-from` dependency. It owns calibration with a representative
corpus and investigation of any repeatable navigation/publication overhead.
This issue's native parity, stable-section and commits-per-change acceptance
criteria are met; the timing follow-up remains open.
