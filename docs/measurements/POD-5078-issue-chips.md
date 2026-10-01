# Issue reference chips through the pool

The chip reader is on `integrate/4286-pilot`, initially landed at
`5b52e6d8b8ce62647ca7e36704da1e049707932a`. Its startup switch defaults off.
Conversation, mail and issue-page Markdown references, React issue references,
and the reference miniview use the same pool when enabled. Writes retain the
existing store actions and outbox.

## Reading and loading

Each chip observes a structurally compared projection of its own issue:
`ref`, `issueId`, `title`, `stage`, `availability`, and `accessibleLabel`.
Changing other fields does not repaint it. The reference index is seeded once
when the reader attaches and contains resident issue rows only. Issue and
repository reads use `pool.row`; the chip path has no peek or whole-list lookup.

An unknown reference returns `LOADING` immediately. The existing load window
deduplicates all requested references into one batch, capped at 200 references
per window. The additive `issues.resolveRefs({ refs })` endpoint returns opaque
IDs or null under the caller's read permissions. Resolved IDs use the normal
absent-row loading path. Scope replacement resets unresolved demands without
losing subscriptions, and old scope replies are ignored.

The server currently makes one transient issue-list pass per batch. A persistent
server index is proposed separately in POD-5103; no client index includes cold
summaries, and no chip triggers a per-reference server request.

## Browser comparison

The private fixture renders the actual `ChatView`, reference components, mail
anchor, and floating reference card in Chromium on flatblock. It has 4,887
synthetic issues, 674 sessions, 120 transcript messages, and 366 displayed chips.
Neither operator records nor operator browser state are used in this fixture.

Both settings have sidebar pool reads disabled. Each measured open starts from
a fresh page/runtime and an uncached transcript. Development module delivery
is warmed beforehand; timing starts at conversation open and ends after chip
attributes are present and two animation frames. App bootstrap and the resident
reference-index seed precede this window. Five cold opens are measured for each
setting in the same foreground run under `bench:flatblock`.

The replacement run completed from 22:49:39 to 22:51:16 UTC on 2026-10-01,
after an explicit lease renewal/status check and a process census that found
zero processes rooted in the preceding lane's private test checkout. Its
recorded Vite PID was 488176; the runner stopped it before releasing the lease.

| Setting | Five sorted cold-open samples (ms) | Median (ms) |
| --- | --- | ---: |
| Legacy | 1660.6, 2272.0, 2873.8, 3117.0, 3286.3 | 2873.8 |
| Pool | 2487.4, 2534.1, 2620.2, 3205.7, 3684.2 | 2620.2 |

The observed median improvement is 253.6 ms, or 8.8%. Sample ranges overlap;
these numbers describe this five-sample development-browser comparison on the
shared host. The first paired run was voided after POD-4959 reported possible
collector startup overlap at 22:38:50–22:39:50 UTC. None of those earlier timing
samples are used here.

Displayed chip values match exactly between settings, including the actual
floating card's title, stage and accessible label. The six-field pool comparison
reports 366 chips, zero pending reads, and zero differences.

| Event with pool enabled | Retained chips changed | New anchors | Pool reads | Paints | Legacy scans |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unrelated session publication | 0 | 3 | 12 | 3 | 0 |
| One referenced issue's title and stage change | 11 | 3 | 33 | 14 | 0 |

The three new anchors are an existing transcript-tail remount, recorded as the
separate proposal POD-5129. Counters account for those mounts explicitly. No
retained chip changes on unrelated traffic; changing one issue touches only its
11 retained chips and the newly mounted anchors. Opening the actual pool
miniview also leaves the chip legacy-scan counter at zero.

## Field parity and regression evidence

The synthetic corpus comparison is green at 1x and 4x through bootstrap, edits,
missing rows, loading, scope changes and creation. All six fields are compared;
the diagnostics emit counts, positions, field names and opaque IDs only.

The final ludovico-only replay reads one live bootstrap into memory and reports
5,705 issues, 5,057 sessions, 5,697 references, zero pending reads, and zero
differences. Eight prefix-less `#seq` fallback labels are reported separately.
They are not parseable reference tokens: a permanent rendering test verifies
that they remain plain text in both switch settings. A permanent reference-tie
test verifies that the replay uses the same replica ordering as `ClientRuntime`.
No live input file, title, path or text leaves ludovico.

Seventeen planted unit mistakes each executed an intended failing assertion,
including a full-list chip scan, per-chip requests, a peek, stale responses,
missed scope refresh, changed displayed fields, replica ordering and fallback
label decoration. The browser counter is also proven red by forcing legacy
liveness with the pool switch on. Each plant used a saved copy and restoration.

Focused flatblock checks are green: chip reader and liveness, reference and
miniview tests, startup and counter checks, server batch permissions, both arms'
tracking-counts, work-per-change, synthetic field parity, the two permanent replay
coverage tests, filtered package typechecks, and scoped formatting/MobX fences.
The inherited O1 server shard input gap was repaired separately; the generated
shard metadata check passes all ten tests. These are focused results, not a
full-suite result. The architecture boundary check retains the same pre-existing
10 architecture and 76 dependency/vendor violations, with no new chip violation.

## Operator controls

Reload with `?mobxChips=1` to enable or `?mobxChips=0` to roll back. The persisted
device preference is `podium.mobxChips=1`; the URL override wins. The choice is
read once at startup, independently of the sidebar and header switches.

Add `chipsPerf=1` for the store-owned census:
`window.__chipPerf.reset()` and `window.__chipPerf.read()`. Add
`mobxChipsCheck=1` with the pool enabled for the explicit six-field diagnostic;
read its report with `window.__chipPerf.check()` when the census is exposed.
That diagnostic alone intentionally runs the legacy oracle outside rendering.

The switch remains off by default. POD-5120 proposes deleting the chip legacy
path about one week after the operator enables it by default.
