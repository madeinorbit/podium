# POD-5403 — Certified warm-cache read state

The production Expo phone export and web build both deliver the final read state
for all 5,200 sessions on the first warm-cache pool delivery. The baseline delivers
them twice: initially read, then unread after the first live posture. The candidate
removes that second bulk delivery while preserving the baseline's final values.

Measured on flatblock, 2026-10-03, with the timing lease held only for captures.
Tests, builds and captures ran in the foreground in private checkouts.

## Paired production captures

Each surface ran three balanced pairs (baseline/candidate, candidate/baseline,
baseline/candidate), then one traced pair. Every measured navigation resumed its
own durable cache with **zero bootstrap requests**. The corpus contains 5,200
sessions and 6,100 issues. Synthetic sessions have activity and no personal row.

| Surface | Baseline bulk deliveries | Candidate bulk deliveries | Removed delivery durations (ms) | Median removed duration |
| --- | --- | --- | --- | --- |
| Phone export, Pixel 7 profile | 2 in every sample | 1 in every sample | 180.7, 190.6, 173.7 | 180.7 ms |
| Web, Chromium desktop | 2 in every sample | 1 in every sample | 71.0, 77.6, 73.7 | 73.7 ms |

These counts refer to deliveries containing all 5,200 sessions. Ordinary updates
with zero affected sessions can still occur. All baseline second bulk deliveries
followed first paint. The traced pairs also show two versus one; their removed
delivery durations are 234.8 ms on phone and 104.1 ms on web.

In every baseline initial delivery the 5,200 synthetic sessions are read; in every
candidate initial delivery they are unread. Once live, both arms have exactly
5,200 unread synthetic sessions and the same `428982a9` hash of session identity,
unread, read cursor and snooze values. The facade tests separately assert explicit
personal-row values and exact object/value parity, including the loading-to-missing
transition for legacy caches.

Median time to the harness's settled condition was 2,197.1/2,152.4 ms
(baseline/candidate) on phone and 1,576.6/1,386.9 ms on web. These small,
instrumented samples on a shared host establish delivery removal and value parity;
they are not a general startup-latency gate. The phone capture runs the production
Expo web export with Chromium 148's Pixel 7 emulation, rather than physical phone
hardware.

## Production and harness provenance

| Item | Baseline | Candidate |
| --- | --- | --- |
| Production source | `7c71f8e699d6eee4cb4774953cfb391c96651339` | `2fe26345fea2dc70aa96240d4429382a6781665a` |
| Web bundle stamp | `bundle+C4EztrPP` | `bundle+Ij3x24VK` |
| Wire version/digest | `4` / `cb9f0786c0a97c2c` | `4` / `cb9f0786c0a97c2c` |

The cache adapter, replica, facade and amendment/spec sources in the production
candidate are unchanged in the landed implementation. Later commits repair the
capture harness and incorporate independently landed integration work.
The phone capture harness was `759781c6bb`; the successful web capture harness was
`cc41c05d82`.

Both arms serve untouched minified production bytes, built with `build:clients`,
against an isolated authority seeded with synthetic test data. The sized bootstrap
is protocol-valid and uses the real decoder; auth, RPC and resume traffic reach that
authority. Before a warm reload a readonly IndexedDB transaction waits behind the
data/metadata commits. No incomplete cold write is mistaken for a warm cache.

Conditional CDP logpoints resolve through external source maps to pool `apply`
entry/exit and live-posture dispatch. They return false and never pause the
debugger. They read the actual minified parameter names; the duration excludes
the probe's value-hashing work. Each navigation remains observed for five seconds
after settling. Sample summaries and an aggregate trace summary accompany the
issue. Full Chromium traces remain in the private capture checkout.

The contexts block service workers to avoid worker-handoff reloads. The web report
retains the resulting Workbox `waiting`-on-undefined registration diagnostics; the
harness excludes only that exact blocked-worker diagnostic from application-error
assertions. Other application errors fail the proof. Automatic approval review
refused full trace export, including a redacted copy, because traces can contain
runtime metadata. The attached trace summary contains aggregate numbers only
and omits all event arguments, headers, URLs, stacks and payload strings.

## Legacy cache and downgrade proof

Both surfaces also load a baseline-written cache with the candidate build. That
first upgrade keeps today's two-delivery fallback, reaches the same final values,
and commits a trusted marker after a successful resume. The next warm start
delivers final values once. Both starts use zero bootstrap requests.

No IndexedDB or SQLite schema version changes: both remain version 1. Raw old
metadata is reopened by a new adapter without a migration or boot refusal.

Cursor equality is possible after an older build reboots or rescopes: the feed
identity can be shared and the epoch need not rotate. A private scope fingerprint
therefore binds the persisted cursor to the completeness marker. An old install
rewrites the cursor as a plain triple, dropping that fingerprint. Shared conformance
tests prove that an old install at the **identical triple**, including old discard
followed by reinstall, cannot inherit certification; durable tests overwrite the
metadata row and reopen independently. See
[ADR 6 Amendment 1 D10](../adr/0006-replica-storage-amendment-1.md#d10--additive-compatibility-without-a-boot-migration).

## Focused validation

The focused adapter/kernel/facade lane covers **414 distinct tests in 12 files**:

| Area | Passing distinct tests |
| --- | --- |
| Memory conformance and fidelity | 61 |
| IndexedDB conformance, fidelity, crash and store | 83 |
| Mobile SQLite conformance, fidelity, crash and store | 82 |
| Replica | 123 |
| Client facade | 65 |

The first run passed 413 and exposed one obsolete transaction-count expectation:
rebootstrap now clears certification before installing the single buffered
snapshot. After correcting that expectation, all 123 replica tests passed. The
291 other tests passed in the initial run. This is combined focused evidence,
not a claim that a final-SHA full suite ran.

The proofs include same-batch cursor/data/marker commit and abort, staged visibility,
independent crash reopen, final buffered-bootstrap cursor, prior-frame recovery
races, every rebootstrap rung, discard, principal partitioning, uncertified writes,
old metadata, identical-cursor downgrade, attach-time values and live parity.

The incomplete-personal-row fault was actually planted in a separate remote-only
candidate: remove `alice-read` while retaining the claimed complete marker. The
focused parity case failed with a missing read timestamp instead of its expected
value (exit 1). Restoring the real candidate made the same case pass. The planted
fault is absent from the landing.

Filtered sync/client-core/mobile/e2e typechecks passed, as did span-effect lint
(162 bodies, zero unclassified), shadowing and changed-file formatting checks.
The ordinary seeded production phone startup passed, and the uninstrumented
paired cold-start diagnostic passed on phone and web. The phone warm-capture case
passed; its combined runner also exposed a web readiness selector that assumed an
expanded sidebar. The final focused web rerun observes either sidebar mode and
passes. No full suite was run.

The committed opt-in capture is
[`replica-completeness-warm-start.browser.e2e.ts`](../../tests/e2e/browser/replica-completeness-warm-start.browser.e2e.ts).
On flatblock, with prepared baseline/candidate production snapshots and
`bench:flatblock` held, run from the private checkout root:

```sh
PORT=15403 \
PODIUM_WARM_CACHE_PROOF=1 \
PODIUM_WARM_CACHE_STARTUP_ONLY=0 \
PODIUM_WARM_BASELINE_DIST=/home/mgw/podium-capture-5403/baseline \
PODIUM_WARM_CANDIDATE_DIST=/home/mgw/podium-capture-5403/candidate \
PODIUM_WARM_BASELINE_CHECKOUT=/home/mgw/podium-test-5403-base \
PODIUM_WARM_CANDIDATE_CHECKOUT=/home/mgw/podium-test-5403 \
bun run test:browser -- --suite replica-completeness-warm-start
```

Use `--project=chromium-desktop` for the focused web case. The issue artifacts hold
`phone-warm-start.json`, `web-warm-start.json`, both certified warm screenshots,
and `trace-summary.json`. Full baseline/candidate traces for both surfaces remain
under `/home/mgw/podium-test-5403/.artifacts/5403/` on flatblock.
