# iPhone Safari mission reload

Issue: POD-5517. Baseline: `51f59c6f34` on `integrate/4286-pilot`.

The operator reports repeated mission page reloads in iPhone Safari. Reproduction
uses an isolated iPhone simulator on `podium-apple-runner` and POD-5508's
operator-size synthetic mission/session/transcript corpus. The copied host
metadata exception and its completed cleanup are documented below.

## First proven growth path

The mobile RN Web viewport mounted every loaded transcript row. Live frames
append to the shared controller's held history, so the DOM grew for the entire
time the chat stayed open. Desktop already limits its mounted following window.
The mobile viewport was introduced by `1d2ff316c7` on October 1; this path is not
new in the October 4 commits named by the operator.

On the iPhone 17 Pro simulator (iOS 26.5, 23F77), a production build of the
`51f59c6f34` product and the isolated synthetic corpus held 3,000 turns / 33,000
items on the server, then appended one mixed 11-item turn every 250 ms. The mission, session and transcript records are synthetic; the copied greeting/API
metadata exception and its cleanup are described below. The mobile session chat grew from 3,886 DOM nodes
at 49 seconds to 14,156 at 131 seconds. Its WebContent PID 32570 grew from
546 MiB physical footprint at 22 seconds, after bootstrap, to 743 MiB at 138
seconds (about 1.7 MiB/s). The initial 140 MiB sample includes startup and must
not be used as a steady-state growth rate.

## Mobile render-window comparison

The same production build with only the mobile viewport change rendered at
most 80 settled rows plus its footer while following. A fresh three-minute
streaming capture stayed at 81 transcript rows and 1,060–1,073 total DOM nodes.
Older loaded rows are revealed before disk paging. Reading retains mounted
history and its row anchor; search can reveal an unmounted target; returning to
newest restores the bounded tail. Native FlatList is unchanged.

RN Web also replaces the host node's browser `scrollTo` with its `{x,y}` API.
The viewport restores the native browser method for the shared DOM scroll
authority's `{top,behavior}` calls, preserving search navigation.

The candidate's two WebContent processes still used about 612–617 MiB at the
end, and the runner experienced substantial CPU pressure. Bounding mounted DOM
does not bound the controller's held items or the full-history compute work.
POD-5534 tracks that remaining path. This is a proven fix for mounted-node
growth, not evidence that all memory pressure is solved.

Neither capture recorded a JavaScript exception loop, React #185, an automatic
reload, or a jetsam termination. Recorded exits were capture cleanup. The
operator's repeated device reload has not been reproduced conclusively on the
simulator. SafariDriver automation suppresses the software keyboard, so these
captures do not validate the separate keyboard-focus issue.

The earlier fixture showed a live tail, but did not verify a Working agent
phase. Its captured DOM contained transcript text while the screenshot showed
a blank transcript region. Follow-up uses an explicit Working-state bootstrap,
same-ID partial output between tool-turn appends, and row paint geometry.
Those earlier observations prove DOM growth; they do not establish a complete
reproduction of the coordinator's actively working chat.

## Shared transcript work

At the coordinator's direction, `865b00d22b` landed on the pilot branch before
the queued native follow-up. While following, the shared controller retains
160 mobile or 400 desktop items and pages older history from the first retained
item's native cursor. Reading and searching retain their loaded history. The
merge keeps an ID-position index across frames. The desktop worker has one
transcript request in flight and only the latest queued request per pane;
changed item content crosses as a delta. Hidden panes cancel presentation
requests until reveal. Conversation updates skip unchanged transcript
membership, and completed sends stay completed after their history rows leave
the following window.

Focused foreground validation on flatblock passed 114 regressions in seven
files and scoped client-core/web/mobile typecheck (16 tasks). Four existing
hidden-pane assertions were updated to check deferred presentation and their
33-test file reran green. A production comparison build contains temporary
numeric counters and a `retainAll` switch, allowing a comparison of retention
with the same static marks and viewport cap. A qualified native comparison is
still pending; no post-warm CPU or heap improvement is claimed.

A mobile follow-up explicitly retains Find history before a matching row moves
the viewport. Its three-file Biome check, scoped mobile typecheck (14 tasks)
and four conversation/healing cases passed on flatblock. One cold fixture
attachment timeout was retried; the complete four-case file then passed.

## Validation and reproduction

Product validation ran foreground on flatblock in `~/podium-test-5517`, with
its own copy of `.toolchain` and Bun 1.4.2: focused Biome checks, scoped mobile
typecheck (14 tasks), and all five `TranscriptViewport.test.tsx` tests passed.
The production client build succeeded. No broad suite result is claimed.

The reusable capture and isolated preview are
`apps/web/harness/ios-mission-memory.py` and `ios-mission-preview.mjs`. The
preview reads only the synthetic fixture in `IOS_PREVIEW_ROOT`, binds loopback
port 19687, and streams for three minutes by default with `IOS_STREAM=1`.
`IOS_STREAM_SECONDS` changes the bounded capture interval. The native sampler
records physical footprint and CPU deltas converted from the host's Mach time
base, then captures `vmmap` region summaries after the timing interval. Those
summaries describe resident backing stores, not a GC snapshot's live JS heap.
`IOS_MOBILE_ARM=mobile-retention` selects the shared-retention comparison export.
`IOS_INITIAL_HISTORY=33000` injects oversized cold history pages to represent
3,000 turns already loaded during a long-running session; this is a stress seed,
not a claim that production returns that many items in one read. Seeding ends
at subscription; later reads honor their normal limit and native cursor.
Generated turns vary their text,
tool identifiers and results, and partial output updates an existing item.

Native preflight requires the exact chat URL, a Working tail, static marks,
at least 80 held items and exactly one transcript subscription. Normal Safari
uses `simctl openurl`; subsequent cases use the preview's loopback-only
`/__navigate` command to replace that same tab and reset the synthetic stream.
Preflight also requires the controller's numeric `maximumInput` counter to
confirm receipt of the full stress seed. With retention disabled, it additionally
requires that full history remain held. `ios-mission-instrument.py` adds these
number-only counters and the retention switch to an owned throwaway checkout;
its backup restores the product controller after the comparison build.
The sampler records document IDs, telemetry freshness and row paint geometry
as well as CPU and footprint. The diagnostic `retainAll` query disables only
the controller cap in a throwaway build; it is absent from product code.
`coverage.json` reports sample counts, spans and gaps. A capture exits nonzero
when useful page/native coverage is insufficient, Working/static state changes,
the document restarts, or streaming is not observed through the final quarter.
Failed traces are preserved
for crash analysis. Native Console logs use the actual capture start/end times,
so slow diagnostics cannot move a relative log window past the measurement.

Capture evidence
and the baseline screenshot are attached to POD-5517. Landing is ff-only on
`integrate/4286-pilot`; neither main nor dev/mw is advanced.

## Fixture qualification and cleanup

A normal-Safari attempt starting at runner load 4.92 failed its 60-second
preflight: the document had not mounted the chat. Later telemetry, outside the
measurement interval, reached 81 rows and 1,094 nodes but showed a live fallback
and “Offline — showing saved data”, with 160 held items and a 200-item maximum.
This run is stored as `native-startup-unqualified`, rather than a qualified
retention comparison. It recorded one document ID and no JavaScript errors.

The isolated preview lacked the HTTP `/sync/delta` endpoint used by persisted
replicas. The repaired endpoint returns an empty delta only at the exact
snapshot head (this fixture's sequence 2502), with matching feed identity and
schema digest; older or foreign cursors receive bootstrap-required HTTP 409.
The bootstrap and saved API replies now describe the same Working session.
Browser and generated transcript timestamps use the same advancing fixture
clock. Preflight allows 180 seconds and the measurement interval starts only
after qualification. These are fixture corrections, not additional product
fixes or evidence that the operator's reload has occurred.

POD-5508 identified host metadata in the copied harness greeting. Before any
further capture I removed two occurrences each of `inventory`,
`harnessVersions` and `targetUnavailableReason`, plus the ignored
`hostMetricsChanged` greeting, from my Mac fixture copies. The API cache also
contained six `login` fields, two `account` fields and six non-null
`accountId` references. All account/login keys, including `accountId`, were
removed entirely. `SessionMeta.accountId` is optional and rejects null; the
initial null replacement was corrected before the final snapshot validation. No operator chat
or issue records were part of this corpus.

Recursive verification covered JSON, NDJSON, JSON-encoded response bodies and
data members of owned archives on both the Mac and ludovico. It found zero
forbidden fields and zero nonempty account/login fields. Normal Safari cleared
only the preview origins `127.0.0.1:19687` and `localhost:19687`: both
acknowledged zero remaining IndexedDB databases, local/session storage keys,
CacheStorage entries and service-worker registrations. A literal quoted-field
scan found no inventory, diagnostic, account or login metadata in 100 Safari
app cache files or the relevant BrowserKit shared container. Cleanup was
reported to POD-4286 before restarting capture work.

The first cold retry exposed the old fixture's five retired feed rows: two
`issueEvent` and three `userLayout`. I reused POD-5508's final synthetic corpus
and its existing rechunking/count correction. After complete account/login
field removal, the production `SyncRecord` validator accepted all 346 records
and `readSyncStream` certified EOF with 21,963 rows. The final snapshot head is
6304. No schema version or sequence was fabricated.

A fresh same-tab memory trace started on the corrected fixture. Runner load
was 32.39, so CPU improvement is explicitly unqualified. Subsequent fresh SSH
connections timed out repeatedly, including IPv4, while the existing trace
connection remained pending. The generated stream was bounded to 600 seconds.

Runner reachability diagnostics later confirmed both repeated SSH timeouts and
a Tailscale ping with no reply. This is an external retrieval blocker, not a
reported product crash. Future captures bound process listing, openurl and
screenshot commands with timeouts so a stalled simulator cannot hold the
foreground evidence wrapper indefinitely.

The trace later returned exit 0 and did reach Working preflight, but coverage
was inadequate: five Working page samples span only document ages 49.8–60.7
seconds, with 63 controller updates. The overall wrapper elapsed 941.8 seconds.
The full 33,000-item history read is confirmed; held history stayed at 160
with maximum 160, mounted rows ranged 52–81 and DOM nodes 678–1,104. There
were no recorded JavaScript errors. Only three post-preflight native samples
were available. WebContent 71732 measured 469.1–498.8 MiB across those samples;
this does not establish a steady growth rate or a three-minute retention
comparison. Runner load later reached 147/185/191. The retention-disabled
comparison and desktop heap/native comparison remain outstanding.
Replaying this trace through the corrected coverage check admits only one
native sample inside the intended interval and rejects the measurement.

Retrieval confirmed one document ID across the five samples, and the final
phone screenshot visibly paints synthetic turn 3030 and the Working tail.
All four `vmmap` outputs are empty after timeouts. Console collection also
timed out: its partial log covers 21:27–21:31, after the useful page interval.
The widget watchdog and generic memorystatus messages in that log do not
establish WebContent jetsam or the operator's reload cause.

The stress seed was returned in one 33,000-item read, followed by a second
80-item cold read before Working preflight. The original instrumentation did
not measure incoming controller history, so this trace does not certify that
the full seed entered the controller. The preview now seeds every cold read
until subscription, and preflight checks `maximumInput` in the updated
comparison build. This is a measurement correction, not another product fix.

Owned-cohort cleanup is confirmed: recorded Safari/WebContent/preview/capture
PIDs 71254, 71272, 71289, 71326, 71732, 75313, 81631 and 82624 are absent.
Runner load had fallen to 60/96/139 but remained unsuitable for timing.
The bench was explicitly handed to queued POD-5558; both this issue and
POD-5534 remain in progress pending the qualified comparisons.
