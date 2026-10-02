# Idle sidebar row attribution

The reported idle row commits are guest session rows observing every coarse clock
publication. With the fix, both 65-second Chromium windows commit **zero rows**;
the clock still publishes once and the legacy worklist derives zero times.

This reproduces the 4 / 16 idle counts in
[the sidebar acceptance report](pod-4948-acceptance.md) on the current pilot
baseline, then attributes every reproduced commit. It does not change the other
acceptance bars or claim that the whole acceptance run is green.

## Browser counts

| Synthetic cell | Baseline row commits | Fixed row commits | Clock publications per window | Derivations per window |
| --- | ---: | ---: | ---: | ---: |
| 1× | 4 | 0 | 1 | 0 |
| 4× | 16 | 0 | 1 | 0 |

Both arms use seed 4443, the production `SidebarUnified` fixture, ordinary
production React, and fresh isolated browser contexts on flatblock. Chromium is
153.0.8010.12. Each window lasts 65 seconds with the real 60-second runtime timer;
`Date.now` advances from the same synthetic anchor as the acceptance collector.
Networking is disabled, and the fixture owns its replica, IndexedDB store and
existing outbox. No operator data or running server/daemon is involved.

These are counts, not timing measurements. The shipped row counter and the
per-row attribution agree exactly: 4 / 16 before, 0 / 0 after. Each window has
only one `coarseNow` publication, empty legacy slice-build counters, and no
fixture or page errors.

## Every reproduced commit

All twenty are `PanelRow` bodies for unbound sessions in worktree rows. The
collector records the DOM text before and after each commit; all are identical.
Neither an issue row nor a folded row commits in these windows.

| Cell | Session id | Commits | Displayed text changed |
| --- | --- | ---: | --- |
| 1× | `s812` | 1 | No |
| 1× | `s814` | 1 | No |
| 1× | `s813` | 1 | No |
| 1× | `s815` | 1 | No |
| 4× | `s13742` | 1 | No |
| 4× | `s830` | 1 | No |
| 4× | `s832` | 1 | No |
| 4× | `s9435` | 1 | No |
| 4× | `s13741` | 1 | No |
| 4× | `s13743` | 1 | No |
| 4× | `s831` | 1 | No |
| 4× | `s9436` | 1 | No |
| 4× | `s833` | 1 | No |
| 4× | `s5122` | 1 | No |
| 4× | `s5123` | 1 | No |
| 4× | `s5124` | 1 | No |
| 4× | `s5125` | 1 | No |
| 4× | `s9433` | 1 | No |
| 4× | `s9434` | 1 | No |
| 4× | `s13740` | 1 | No |

The shared cause is `PanelRowInner`'s unconditional
`useStoreSelector(s => s.coarseNow)`. React memoization around the row cannot
suppress an update from that row's own subscription.

The fix supplies `snoozed` and `returned` verdicts from a computed over the
existing pool session reader and `DeadlineClock.reached(until)`. The row's memo
comparison includes those verdicts. A guest with no timed snooze observes no
minute ticks; a timed snooze changes its row when it expires, including a clock
rewind. The switch-off path keeps its existing shared clock and predicates.
No schema, reader, replica, outbox, startup switch or timer is added.

Folded rows already compare their displayed marker and relative age. That
comparison remains intact: a stable `2h ago` label causes no commit, a transition
to `3h ago` commits only that row once, and the following unchanged tick stays
cold.

## Focused checks and controls

All checks ran sequentially on flatblock in `~/podium-test-5135`, with its private
`.toolchain`, pinned Bun 1.4.2 and frozen checkout-local dependencies. Every run
has a WIP checkpoint. Source plants were copied aside and restored with `cp`.

- `bun run test:file -- apps/web/src/features/worklist/SidebarUnified.pool.test.tsx`:
  **17 / 17 pass**, one file, including six new cases. Existing legacy/pool row
  parity and navigation tests are included. This is a focused result, not a
  suite or lean-gate result.
- `bun run typecheck -- --filter=@podium/web`: **16 / 16 tasks pass** through the
  normal cache-aware wrapper; no forced cache bypass.
- Biome check of the three changed files exits 0, with 5 warnings and 5 infos.
- The final browser catcher reconciles per-row commits with the shipped counter
  and rejects a committed row whose text stays the same.

| Source plant | Intended red result |
| --- | --- |
| Restore unconditional `coarseNow` subscription | Five pool cases fail on unchanged guest commits; legacy case passes. |
| Remove folded age's clock observation | Hour-boundary case fails: the changed age row never commits. |
| Freeze legacy row clock verdict | Switch-off case fails: the snooze expires without displaying `Unsnoozed`. |

The six new cases cover unchanged pool ticks, unchanged legacy behavior, timed
expiry and rewind, indefinite snooze, invalid snooze, and a relative-hour
boundary. Restored sources pass all seventeen tests. Hermetic ticks use the
runtime's existing publication seam, while the browser windows exercise the
natural timer.

## Evidence and reproduction

The issue artifact `.artifacts/sidebar-idle-evidence.tar.gz` contains the four
raw window records, every before/after text pair, the capture script, source
control logs, final focused gate, typecheck, lint and browser-build logs, and a
provenance manifest with build SHAs and SHA-256 hashes. It is attached separately
from this report; the archive is not committed to the repository.

The capture uses a passive React commit hook and compares each row's last
committed hook/props identities, then reads its DOM text. Its count must equal
the shipped measurement hook. An early collector compared a fiber with a stale
alternate and overcounted reused subtrees; that attempt is excluded. The final
collector compares consecutive committed snapshots and reconciles both arms.

To reproduce in the isolated flatblock checkout, unpack the artifact at the
checkout root, put its own `.toolchain` on PATH and use its library directory.
Build the desired product checkpoint with a foreground timeout:

```sh
timeout 240s bun apps/web/harness/sidebar-acceptance.ts --phase=build
timeout 210s bun .artifacts/sidebar-idle-capture.ts --label=baseline
```

Build the fixed checkpoint the same way, then run the script with `--label=fixed`.
That label makes an unchanged-text commit fail the capture. No timing bar or
benchmark lease is needed for these count-only windows.
