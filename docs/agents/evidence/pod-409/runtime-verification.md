# POD-409 — runtime verification (config-driven automation subforms)

Branch `issue/409-6-4e-automationsview-config-driven-subfo`, **rebased onto
`origin/issue/279-integration` at `71a9265e`**; every result below was
re-measured on that rebased tip, with `bun install` run after the rebase and
`ls node_modules/@podium` confirming the hoisted links are at the repo root.
Chromium desktop, `tests/e2e/playwright.config.ts`, `PORT=8831`.

    cd tests/e2e && PORT=8831 bunx playwright test \
      browser/automations.browser.e2e.ts --project=chromium-desktop

## What the lane proves

Both suites in `tests/e2e/browser/automations.browser.e2e.ts` run to their final
step. Every assertion passes except one, in both suites, in the same place: the
DELETE step (see "Known failure" below).

Real clicks that pass, against the rebuilt composer:

- Nav to Automations; the view's two real sections render.
- **Create**: name, task prompt, frequency picker (daily → weekly), the cron
  read-back updating `0 9 * * *` → `0 9 * * 1`, the target picker, Create.
- **Config-driven visibility**: `Day of week` and `Time` appear only for the
  frequencies that declare them; `Cron expression` only for custom cron; `Run at`
  only for one-time; `Path glob` only for the file-changed reactive trigger. These
  used to be inline `freq === …` branches; they are now `visibleWhen` predicates
  on the field configs and the browser confirms the rendering is unchanged.
- **The reactive subform stays uncreatable**: its config carries
  `creatable: false`, the warning renders, and Create is disabled.
- **The delegation notice** (new, §3.1.6 S6): "runs as you" is visible in the
  composer, and no share control exists — asserted in the suite.
- **Read / persistence**: the card shows the human schedule, target and mode; it
  survives a full page reload.
- **Update**: Edit prefills the exact cron (`0 9 * * 1`) and the exact one-off
  run-at; changing session mode rides back into the card.
- **Toggle**: enable/disable persists across reload.
- Expanding a card shows the real (empty) run history.

Screenshots: `composer-schedule.png` (weekly — note Day of week + Time present,
cron read-back, delegation copy below the prompt), `composer-reactive.png`
(reactive subform, warning, Create refused).

## Baseline — the two failures are not this change's

The suite was already red before this change, and the A/B was run back-to-back on
the same checkout. The revert path was the safe one: the changed files were
**copied to a snapshot first**, then `git checkout --` returned the tree to
pre-change, and the restore copied the snapshot back — `git checkout --` reverts
past uncommitted work, so doing it without the snapshot would have destroyed the
diff being measured.

| Suite | Baseline | With this change |
|---|---|---|
| `desktop header links + a scheduled automation that persists` | FAIL at line 23 (`Issues` nav button not found) | runs to the end; FAIL at delete only |
| `a one-off automation persists its exact future run` | FAIL at delete | FAIL at delete |

The first failure was a **stale selector**: `Issues` became `Tasks` in the POD-650
naming trial, so the spec died at its second assertion and nothing below it had
run since. Fixed here by giving `NavItem` a `data-testid` keyed on the
DESTINATION (`topbar-nav-<view>`) and pointing the spec at it, so the next rename
cannot silently disable the lane again. The stale
`Fresh issue and session each run` copy assertion was corrected the same way.

## Known failure — delete does not leave the list (pre-existing)

Both suites now fail at exactly one step:

    await view.getByRole('button', { name: 'Delete <name>' }).click()
    await expect(view.getByText('<name>', { exact: true })).toHaveCount(0)

The row stays for the full 5s timeout. From the failure page snapshot: **no error
banner renders**, so `automations.remove` RESOLVED — `ScheduledSection`'s `mutate`
calls `onError('')` on success — and the client's automation list simply never
lost the row. Server-side `AutomationsService.remove` commits through the ledger
with `{ entity: 'automation', op: 'remove' }` and
`AutomationsRepository.remove` returns a real boolean, and the socket hub's
`case 'automation'` applies removals, so the break is somewhere in the
change-broadcast/apply path between them rather than in the UI.

Reproduces identically on the pre-change tree — and again on the rebased tip, at
spec lines 119 and 166 — so it is not caused by this issue and is separable from
it. Filed as **POD-1509**, parented under POD-293 (Phase 6) with a
`discovered-from` edge back to POD-409.

The D of "CRUD real-click verified" is therefore **not** claimed here; C, R and U
are.

> Filing note for the coordinator: POD-1508 is the same bug filed first WITHOUT
> `--parent-id`, which stranded it in Proposed where an agent can neither reparent
> nor close it. POD-1509 supersedes it and is correctly parented. **POD-1508 needs
> an operator to delete or archive it.**

---

## Mutation testing — what each guard actually protects

Eleven mutants, one per guard. Each was applied to a file, the automations suite
run, the test NAMES read out of the red (never the exit code), and the file
restored **by copying back a pristine snapshot** taken before the first mutant —
not by reverse-replacing the edit. Revert verified three ways after the last one:
`md5sum` equal to the snapshot, `grep` for every mutant string returning nothing
(rc=1), and `git status` clean.

Every run printed a `Test Files` summary, so none of these reds is the
"no tests collected, exit 1" shape that proves nothing.

| # | Guard | Mutation | Named test that went red |
|---|---|---|---|
| A | cron guard | `scheduleValid` returns `true` unconditionally | *refuses an empty custom-cron box rather than falling back to every minute*; *refuses a malformed expression and flags the field* |
| B | machine USE bounding | withheld targets pushed into `choices` anyway | *offers only usable targets and counts the rest by reason*; *renders an unusable saved target as an opaque, unselectable reference* |
| C | scoped-vs-unscoped rule | `const scoped = false` | same two |
| D | system refusal | `if (ctx.systemClass)` → never taken | *refuses every act on a system automation, and says why*; *blocks save when the right is denied, whatever the form says* |
| E | stop/delete not USE-gated | gate widened to every action | *gates the code-running acts on a usable machine, but never stop or delete* |
| F | no client attribution | `owner: 'me'` added to the payload | *carries no actor, owner or origin (§3.1.3 A3)* — plus both `NewAutomationDialog` edit-mode tests |
| G | config-driven visibility | weekday field `visibleWhen: () => true` | *shows only the frequency-relevant schedule fields* |
| H | system rows not listed | `userAutomations` returns everything | *keeps system automations out of the user list entirely* |

### The seam that was DELETED, mutated on its own terms

Replacing a mechanism does not inherit its coverage, so the three mutants below
target the behaviour the deleted inline branches used to produce, not the config
module that replaced them. All three are caught by the pre-existing
`NewAutomationDialog.test.tsx`, which is the point: the old path's contract still
holds through the new one.

| # | Deleted behaviour | Mutation | Named test that went red |
|---|---|---|---|
| I | one-off sends `cron: null` | `cron` always computed | *prefills and preserves an explicit targeted one-off schedule* |
| J | one-off opens as `once`, recurring as custom cron | always opens as `cron` | same |
| K | shared tail fields render under every subform | tail dropped | *prefills the exact schedule and updates the existing automation* |

**No mutant was silent.** There is nothing to classify as assertion gap, never
entered, or genuinely equivalent.

## Suites on the rebased tip

Run without a pipe, exit status captured directly (a pipe returns the pipe's
status, which has faked green here before):

| Suite | Result |
|---|---|
| `apps/web/src` | rc=0 — **172 files, 1323 tests passed** |
| `packages/client-core/src` | rc=0 — **71 files, 761 tests passed** |

POD-1499's timing-shaped 5s timeouts did not appear in either run.

`packages/protocol` was **not** run, and the reason is checkable rather than
asserted: `git diff --name-only origin/issue/279-integration...HEAD` touches
`apps/web/**`, `tests/e2e/**` and `docs/**` only — zero files under `packages/`,
so no wire fixture or golden is reachable from this diff.

## Slice consumption — why there is no `automations` slice

Per POD-330's rule that `useSlice` is for a NAMED slice several surfaces read
while `useStoreSelector` stays for one-offs: the automations composer is the only
reader of its target derivation, so it reads raw entity lists through
`useStoreSelector` and derives in a `useMemo`. Publishing it would add a slice
with one consumer, which is the "port every selector and rebuild the god object
with a nicer hook" failure mode.

What IS shared comes from the shared slice rather than being re-derived here:
`machineViews` / `MachineAvailability` / `repoUsageAt` are imported from
`@podium/client-core/viewmodels`. Nothing in a shared slice was edited.

One recommendation handed up rather than acted on: `machineViews` over a
`MachineWire[]` — including the "omitted `use` means not evaluated" reading — is
about to have at least three consumers (this dialog, POD-406's spawn gating,
SidebarUnified's repo machines). That is the shape that wants publishing, and it
belongs to whoever owns the machines slice, not to this surface.
