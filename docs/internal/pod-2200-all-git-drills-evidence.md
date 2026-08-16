# POD-2200 — acceptance drills for an all-git fleet: evidence

Drive of the four claims POD-2194 could not reach, now that POD-2198 plans the pack per
delivery capability. Filled in as each phase runs.

- **Instance:** disposable named instance `pod2200` (never the operator's default)
- **Date:** 2026-08-16

## Setup

- Disposable checkout: `git clone --local --shared` at `/home/mgw/src/other/podium-pod2200`
- Disposable state root: `/home/mgw/src/other/podium-pod2200-state`, ports 18911 / 18912 / 18913
- No compiler: `BUN_BIN` points at a stub that logs its argv and exits 0

## Results

### Premise: an all-git fleet plans no pack — CONFIRMED

`updates.start` against a fleet whose one machine advertised `update.delivery.git` alone,
with the checkout moved from `b647162` to `68fc342`, planned `[machines, server]`. No
`prepare` step, no pack, no web build.

### 1. All-git fleet, end to end — PASS

The operation reached `done` in 2.8 s. The machine converged by git delivery, the process
restarted onto the moved checkout, and the successor adopted the same operation id.

### 3. Straggler reconciliation — offline machine is deferred

With the only machine offline, the plan was empty and the operation reached `done` carrying
`deferred: [{ ludovico, reason: offline }]` and no error.

A machine that answered `rejected` was then reconnected three times and no grant followed.

Reconnected one version behind, the straggler converged in one second with nobody looking,
no second click, and no new operation on record.

<!-- drill target F -->
