# POD-409 — runtime verification (config-driven automation subforms)

Branch `issue/409-6-4e-automationsview-config-driven-subfo`, tip before commit
`2b637a2b` + this change. Chromium desktop, `tests/e2e/playwright.config.ts`,
`PORT=8831`.

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
the same checkout (my files copied out, `git checkout --` to the pre-change tree,
run, restore):

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

Reproduces identically on the pre-change tree, so it is not caused by this issue
and it is separable from it. Filed as its own issue with a `discovered-from` edge.
The D of "CRUD real-click verified" is therefore **not** claimed here; C, R and U
are.
