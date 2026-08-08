# POD-554 review of 45b251608 — closed

The operator's decision on finding 1 (keep the Reclaim tab, make it PROPOSE-FIRST
with per-row approval) is built. Every finding below is done, plus one defect that
runtime verification turned up.

| # | Finding | Status |
|---|---------|--------|
| 1 | Reclaim tab applies via `issues.stop` / unconfirmed "Free all" | **Done.** `onFreeAll` deleted. Checkbox per row, nothing ticked, one action labelled with the selection count, one confirm in front of every path including per-row Free. |
| 2 | Invented `--superade` / `--race-navy` | **Done.** `.hp-review-btn` deleted outright — `.hp-link` was already this popover's button. |
| 3 | New `.hp-rrow*` primitives | **Done.** Renamed `.hp-kv` / `-key` / `-value`; the reason no existing primitive fitted is in the stylesheet comment. |
| 4 | Runtime verification | **Done.** Real running app, live instance, real load + residency. Evidence below. |
| 5 | Header recomputes reclaimable on issues/sessions churn | **Done.** One scan for all machines instead of one per host, keyed on `residentWorktreeKey` rather than the sessions array. |
| — | `worktreeGc` in `NOT_ON_THIS_SCREEN` (3f20d5027) | **Done.** Both entries deleted, `worktreeGc` added to `TAB_PATHS.hibernation`. |

## The confirm

`ReclaimConfirmDialog` follows `issueCloseConcerns` (`features/issues/issue-lifecycle.tsx`)
rather than inventing a second pattern: presentation-only, one named consequence
at a time, plus the checkouts listed by title so the count can be checked against
what was ticked.

It names both halves. Given up: the checkouts leave the disk, attached sessions
stop, and **the next agent there pays to rebuild the checkout**. Guaranteed:
branches are kept unmerged-included, and a dirty tree refuses rather than being
discarded.

**On the POD-580 wording.** The brief asked the confirm to say that resuming an
existing session recreates a freed checkout but starting a brand-new agent fails.
That is no longer true — POD-580 landed on main as 46a9031f0 ("rebuild freed
worktree for new agents"), which routes `start` and `addSession` through
`ensureWorktree` exactly like resume, with tests for both. Writing it would have
put a false statement in a destructive-action confirm, so the row states the cost
that IS real: the rebuild itself — a fresh `git worktree add` plus any install or
build state that lived only in the old directory.

## Defect found by the runtime pass

The reclaimable inventory read **"0 checkouts" while 78 aged checkouts sat on the
host**, and would have shipped that way.

`listReclaimableWorktreesClient` filtered `row.machineId === thisMachine`. A real
instance sets an issue's `machineId` ONLY when the issue is deliberately placed on
a remote machine: all 587 rows on the live board carry null, including issues
created today. The server reads that null as "the hub" — every git op it runs
passes `row.machineId ?? undefined`, which routes to the local daemon — so the
equality filter drops every ordinary checkout.

Placement is now one exported rule (`placeReclaimable`) used by the header and
both panels: a row that names a machine belongs to that machine only; a row that
names none belongs here when this is the only machine; otherwise it is COUNTED and
reported ("N record no machine") rather than silently dropped, because offering it
under every chip would double-count it and offer a free that routes elsewhere.

This is exactly what finding 4 existed to catch. Unit tests and a `file://`
fixture both passed against the broken filter.

## Runtime evidence (`.artifacts/POD-563/runtime/`)

Branch build served by a second vite on :55599 proxying to the LIVE backend on
:18787 — the operator's real board, the shared root `dist` untouched. Read-only:
the confirm dialog was opened and dismissed, its destructive action never pressed.

| Shot | Shows |
|------|-------|
| `runtime-chip-comfortable.png` | The chip with real data: `MEM 46%`, `LOAD 0.9×`, `AGT 31` (red — 31 resident against a target of 30), amber health dot from 78 reclaimable |
| `runtime-chip-balanced.png` | The same chip at balanced density: marks and values shed, AGT gone entirely, MEM/LOAD survive as bare meters |
| `runtime-popover-pinned.png` | Reclaimable inventory — `.hp-kv` rows, `.hp-link` Review consistent with the settings shortcuts below it |
| `runtime-reclaim-selected.png` | 78 real candidates, one ticked, action reading "Free 1 checkout" |
| `runtime-reclaim-confirm.png` | The confirm, all five consequences named |
