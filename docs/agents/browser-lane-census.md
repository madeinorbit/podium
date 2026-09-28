# Browser lane census

What the 70 Playwright suites actually do when something runs them [POD-1227].

Until this lane existed, every `tests/e2e/browser/**.browser.e2e.ts` suite was run
exactly once — by hand, by the agent that wrote it, on the day it was written — and
never again. "Runtime verified" in handoffs and in merge commit messages has been
resting on that single execution ever since. POD-756 counted the suites (56 → 54,
corrected) and ran a chromium-only baseline, but the lane in its title was never
built, so the count went stale (54 → 70) and the baseline was never re-measured.

**Read this document before citing any browser suite as evidence.** A suite listed
below as failing does not verify anything today.

- Lane: `bun run test:browser` → `scripts/browser-lane.ts` (takes `test:heavy` from a live session)
- Single-suite: `bun run test:browser -- --suite <stem>` (e.g. `--suite clipboard`);
  unknown names error out. Pass Playwright flags after that
  (`--project=chromium-pixel`, `--grep …`). Prefer this over hand-rolling playwright.
- Hand-run prep only: `bun scripts/browser-lane.ts --build-only` then playwright
  (bridge when you must bypass the lane; webServer fails fast if dist is missing).
- Quarantine: `scripts/browser-quarantine.ts` (printed on every run)
- CI: the `browser` job in `.github/workflows/ci.yml`, **non-blocking**, one leg
  per Playwright project

## How to read the CI job

The job is `continue-on-error`. That is deliberate and temporary: the baseline is
too red for a required lane, and a red required lane would stop every branch in
the POD-279 fan-out. It also means **the checkmark on this job is meaningless** —
open the step output and read the census. Making the lane blocking is a follow-up,
gated on the failure count reaching zero.

The POD-744 lesson (a bundled `continue-on-error` made the boundary guardrail
decorative for weeks) is why this job is its own leg with exactly one test step:
nothing blocking may ever be folded in beside a swallowed red.

## What the lane does that the Playwright config does not

The config (`tests/e2e/playwright.config.ts`) is used **almost unchanged** — its
`webServer` only boots `serve-harness.ts`. Four things live in the runner instead:

1. **Building workspace packages, web, and the mobile web export (POD-535).** The
   test process imports `@podium/protocol` without the `@podium/source` condition,
   so it resolves to `dist`. The harness also serves `apps/web/dist` and the Expo
   mobile export. Those used to rebuild inside Playwright's `webServer` command
   and spent minutes under its wall clock; the lane builds them once, then the
   harness starts in ~5s. Prefer `bun run test:browser -- --suite <stem>` so the
   lane owns the build. Hand-runs that must bypass the lane use
   `bun scripts/browser-lane.ts --build-only` first; webServer fails fast via
   `browser-dist-preflight.ts` if dist is missing. On a fresh checkout every suite
   dies without this step (`Cannot find module …/packages/model/dist/index.js`).
2. **Probing imports per suite.** Playwright aborts the entire run when a single
   file fails to import — `Total: 0 tests in 0 files`, and no census at all. The
   runner probes first (fast, no browser), names the unloadable suites as ERRORED,
   and runs the rest, so one rotten import cannot hide the state of the other 69.
3. **Suite selection and zero-test refusal [POD-536].** `--suite` picks from the
   discovered list (no match → exit 2, never the full lane). The lane also refuses
   success when the list probe reports zero tests, so a masked or empty run cannot
   read as green. Use `--project=name` (equals form); the space form is variadic
   and will swallow a following token as another project name.
4. **The `test:heavy` lease** (inside `browser-lane.ts` for the full run only;
   `--build-only` does not take it so it cannot deadlock a held hand-run lease).

<!-- CENSUS RESULTS -->

## First census + triage (2026-09-26 run, triaged 2026-09-28 under POD-4701)

First full run since POD-4664 made the suites loadable: dev/mw c81dc5ea2 on
flatblock, 131 suites / 718 tests listed → **39 passed, ~254 failed, 430
skipped** (2.1 h; per-test marks by project: chromium-desktop 28 pass / 148
fail, chromium-pixel 6 / 59, webkit 5 / 47). No baseline exists — before
POD-4664 no suite could load.

### Before table (flatblock 2026-09-26)

| suite | pass | fail | skip |
|---|---|---|---|
| update-dialog-reload-fix.browser.e2e.ts | 0 | 15 | 0 |
| issues.browser.e2e.ts | 1 | 10 | 22 |
| settings-surfaces.browser.e2e.ts | 0 | 9 | 27 |
| issue-reference.browser.e2e.ts | 0 | 7 | 2 |
| attachment-driver-contract.browser.e2e.ts | 0 | 6 | 0 |
| mobile-shell-redesign.browser.e2e.ts | 0 | 6 | 3 |
| motion-primitives.browser.e2e.ts | 3 | 6 | 0 |
| settings.browser.e2e.ts | 0 | 6 | 12 |
| transcript-loading.browser.e2e.ts | 0 | 6 | 12 |
| ux-batch.browser.e2e.ts | 0 | 6 | 12 |
| expo-mobile-launch-continuity.browser.e2e.ts | 0 | 5 | 10 |
| reveal-refit.browser.e2e.ts | 1 | 5 | 0 |
| clickable-files.browser.e2e.ts | 1 | 4 | 10 |
| interaction-feedback.browser.e2e.ts | 1 | 4 | 1 |
| mobile-scroll.browser.e2e.ts | 0 | 4 | 2 |
| ui-state-persistence.browser.e2e.ts | 0 | 4 | 8 |
| ux-batch-mobile.browser.e2e.ts | 0 | 4 | 2 |
| clipboard.browser.e2e.ts | 0 | 3 | 6 |
| closed-issue-fold.browser.e2e.ts | 0 | 3 | 6 |
| daemon-restart.browser.e2e.ts | 0 | 3 | 0 |
| grok-transcript.browser.e2e.ts | 0 | 3 | 0 |
| harness-scoped-session-defaults.browser.e2e.ts | 0 | 3 | 0 |
| native-pane.browser.e2e.ts | 0 | 3 | 6 |
| native-view-latency.browser.e2e.ts | 0 | 3 | 0 |
| offer-layout.browser.e2e.ts | 0 | 3 | 0 |
| quarter-size.browser.e2e.ts | 0 | 3 | 0 |
| reattach.browser.e2e.ts | 0 | 3 | 0 |
| reflow.browser.e2e.ts | 0 | 3 | 0 |
| server-restart.browser.e2e.ts | 0 | 3 | 0 |
| snooze.browser.e2e.ts | 0 | 3 | 0 |
| transport-compression.browser.e2e.ts | 0 | 3 | 0 |
| unified-sidebar.browser.e2e.ts | 0 | 3 | 6 |
| warm-panel-residency.browser.e2e.ts | 0 | 3 | 0 |
| (all remaining suites) | ≤2 | ≤2 | — |
| TOTAL (131 suites, 718 listed) | 39 | ~254 | 430 |

### Triage verdicts (largest suites; each reproduced locally on ludovico)

- OUTDATED, deleted: `update-dialog-reload-fix` — `UpdateDialog`
  (`data-testid update-dialog`) deleted by POD-2102 (daf066b4a); behaviour
  unit-guarded by `UpdatePanel.test.tsx` / `operation-view.test.ts`.
- OUTDATED, rewritten: `settings-surfaces` — root locator `region[Settings]`
  died with POD-365 (2641b5c2e, AppSheet `role=dialog`); the three
  visibility-class banner tests pinned banners dropped by POD-407 (57c4ad880).
  Secrets-leak + telegram describes kept (live testids). Verified locally:
  6 pass / 0 fail (chromium-desktop; 3 member-arm skips).
- OUTDATED, rewritten: `settings` — `settings.set` blob write retired
  (POD-420 derived surface + POD-1213); seeds now use
  `updatePersonal`/`updateInstance`; `region` → `dialog`; Grok test scoped to
  the first Model button (subagent picker added since); background-LLM labels
  follow POD-4475 (`/^Codex/` + suffixes). Verified locally: 5 pass / 0 fail
  (1 skip: needs native accounts).
- OUTDATED, deleted 2 tests: `ux-batch` #8 (home command center deleted by
  POD-991, 08dea3214) and #18 (session-header Archive removed by the
  session-verbs rename, 9bd36349a). Remaining #13 / #16 / #17 still red —
  see product note below.
- TEST BUG, fixed: `issues` STAGES listed a `Verifying` column the board never
  had (`ISSUE_BOARD_STAGES` has six); dropped the phantom seventh.
- PRODUCT BUG, kept red: 8 `issues` tests — the New Task button
  (`issues-new-task`) is covered by the `header-host-indicators` well
  (pointer-events intercept, both hosts). Filed as POD-4718.
- PRODUCT BUG, kept red: `transcript-loading` (a) — a running session with a
  bound on-disk transcript renders zero `.chat-md` rows (both hosts). Filed
  as POD-4719.
- ENVIRONMENT: flatblock-only harness timeouts (e.g. all of `ux-batch` died in
  `gotoWorkspace` on flatblock; locally the same run gets past setup and 2
  tests pass) — the 2.1 h loaded-host run overstates the failure count.
  Ludovico is currently too loaded for the lane's mobile-export build
  (exit 137), so `ux-batch` / `issues` re-runs after the deletions are
  pending a quieter host or the next flatblock lease.

Also stale in the same way (not yet touched): `region[Settings]` locators in
`login-password-ux`, `experimental-boundaries`, `settings-telegram`,
`machine-transfer`.

### After table (flatblock 2026-09-28, base = pre-rebase tip 06342feba)

129 suites / 682 listed → **54 passed, 213 failed, 415 skipped** (1.9 h).
Deltas vs before: −36 listed (deleted suites), +15 passed, −41 failed.
Per-project fails: chromium-desktop 148 → 121, chromium-pixel 59 → 54,
webkit-iphone 47 → 42 (all webkit fails are one cause: no WebKit build exists
for ubuntu26.04-x64 — `Playwright does not support webkit` — so the whole
webkit column is environmental on this host).

Touched suites: `settings-surfaces` 0/9/27 → 6/0/21, `settings` 0/6/12 →
5/1/12 (remainder is POD-4730), `ux-batch` 0/6/12 → 0/3/6, `issues` unchanged
1/10/22 (still blocked on POD-4718; the Verifying fix shows as the absent
column error), `update-dialog-reload-fix` gone (15 fails → 0).
`harness-scoped-session-defaults` 0/3 → 1/2 (seed fix lands; rest is timing).
Later commits (machine-transfer deletion, login/telegram/issue-ref/harness
fixes, concierge/engraved deletions) are NOT in this run — see the local
verification notes in the POD-4701 handoff.

| suite | pass | fail | skip |
|---|---|---|---|
| issues.browser.e2e.ts | 1 | 10 | 22 |
| issue-reference.browser.e2e.ts | 0 | 7 | 2 |
| attachment-driver-contract.browser.e2e.ts | 0 | 6 | 0 |
| mobile-shell-redesign.browser.e2e.ts | 0 | 6 | 3 |
| motion-primitives.browser.e2e.ts | 3 | 6 | 0 |
| transcript-loading.browser.e2e.ts | 0 | 6 | 12 |
| expo-mobile-launch-continuity.browser.e2e.ts | 0 | 5 | 10 |
| reveal-refit.browser.e2e.ts | 1 | 5 | 0 |
| clickable-files.browser.e2e.ts | 1 | 4 | 10 |
| interaction-feedback.browser.e2e.ts | 1 | 4 | 1 |
| mobile-scroll.browser.e2e.ts | 0 | 4 | 2 |
| ui-state-persistence.browser.e2e.ts | 0 | 4 | 8 |
| ux-batch-mobile.browser.e2e.ts | 0 | 4 | 2 |
| clipboard.browser.e2e.ts | 0 | 3 | 6 |
| closed-issue-fold.browser.e2e.ts | 0 | 3 | 6 |
| daemon-restart.browser.e2e.ts | 0 | 3 | 0 |
| grok-transcript.browser.e2e.ts | 0 | 3 | 0 |
| native-pane.browser.e2e.ts | 0 | 3 | 6 |
| native-view-latency.browser.e2e.ts | 0 | 3 | 0 |
| offer-layout.browser.e2e.ts | 0 | 3 | 0 |
| quarter-size.browser.e2e.ts | 0 | 3 | 0 |
| reattach.browser.e2e.ts | 0 | 3 | 0 |
| reflow.browser.e2e.ts | 0 | 3 | 0 |
| server-restart.browser.e2e.ts | 0 | 3 | 0 |
| snooze.browser.e2e.ts | 0 | 3 | 0 |
| transport-compression.browser.e2e.ts | 0 | 3 | 0 |
| unified-sidebar.browser.e2e.ts | 0 | 3 | 6 |
| ux-batch.browser.e2e.ts | 0 | 3 | 6 |
| warm-panel-residency.browser.e2e.ts | 0 | 3 | 0 |
| colour-flow.browser.e2e.ts | 0 | 2 | 4 |
| desktop-session-shortcuts.browser.e2e.ts | 1 | 2 | 0 |
| desktop-shell.browser.e2e.ts | 0 | 2 | 4 |
| expo-mobile-draft-launch.browser.e2e.ts | 0 | 2 | 7 |
| expo-mobile-routing.browser.e2e.ts | 0 | 2 | 1 |
| expo-mobile-terminal-rendering.browser.e2e.ts | 0 | 2 | 1 |
| harness-scoped-session-defaults.browser.e2e.ts | 1 | 2 | 0 |
| issues-view-pod406.browser.e2e.ts | 0 | 2 | 1 |
| kernel-replica.browser.e2e.ts | 3 | 2 | 10 |
| machine-transfer.browser.e2e.ts | 0 | 2 | 4 |
| mobile-home.browser.e2e.ts | 0 | 2 | 1 |
| palette-ctxmenu.browser.e2e.ts | 0 | 2 | 4 |
| preload-error-recovery.browser.e2e.ts | 1 | 2 | 0 |
| pwa-update-handoff.browser.e2e.ts | 1 | 2 | 1 |
| session-rename-skeleton.browser.e2e.ts | 0 | 2 | 7 |
| setup-reachability-port.browser.e2e.ts | 1 | 2 | 0 |
| sidebar-redesign.browser.e2e.ts | 0 | 2 | 4 |
| sidebar-rename-spawn.browser.e2e.ts | 0 | 2 | 4 |
| static-html-file-viewer.browser.e2e.ts | 0 | 2 | 4 |
| tabs.browser.e2e.ts | 0 | 2 | 4 |
| topbar-overflow-regression.browser.e2e.ts | 0 | 2 | 4 |
| worktree-follow.browser.e2e.ts | 0 | 2 | 4 |
| agent-panel-lifecycle.browser.e2e.ts | 0 | 1 | 2 |
| awaiting-merge-sidebar.browser.e2e.ts | 0 | 1 | 2 |
| blocked-session-bar.browser.e2e.ts | 0 | 1 | 2 |
| chat-ime.browser.e2e.ts | 0 | 1 | 2 |
| chat-interrupt.browser.e2e.ts | 0 | 1 | 2 |
| chat-slice-consumers.browser.e2e.ts | 0 | 1 | 2 |
| closed-issue-task-panel.browser.e2e.ts | 0 | 1 | 2 |
| design-foundation.browser.e2e.ts | 0 | 1 | 2 |
| discovered-work-placement.browser.e2e.ts | 0 | 1 | 2 |
| dock-shell-machine.browser.e2e.ts | 0 | 1 | 2 |
| experimental-boundaries.browser.e2e.ts | 0 | 1 | 2 |
| experimental-settings.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-back-navigation.browser.e2e.ts | 1 | 1 | 4 |
| expo-mobile-composer-media.browser.e2e.ts | 1 | 1 | 4 |
| expo-mobile-composer.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-keyboard.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-parity.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-persistence.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-pull-refresh.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-sheet-gestures.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-startup-silence.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-sync-responsiveness.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-terminal-crop.browser.e2e.ts | 0 | 1 | 2 |
| expo-mobile-work-first.browser.e2e.ts | 0 | 1 | 2 |
| file-browser.browser.e2e.ts | 0 | 1 | 2 |
| finished-delegate-sidebar.browser.e2e.ts | 0 | 1 | 2 |
| flight-deck-polish.browser.e2e.ts | 0 | 1 | 2 |
| group-by-repo.browser.e2e.ts | 0 | 1 | 2 |
| issue-color-picker.browser.e2e.ts | 0 | 1 | 2 |
| issue-peek.browser.e2e.ts | 0 | 1 | 2 |
| issue-session-delete.browser.e2e.ts | 0 | 1 | 2 |
| issues-hierarchy.browser.e2e.ts | 0 | 1 | 2 |
| kanban-drag-boundary.browser.e2e.ts | 1 | 1 | 1 |
| login-password-ux.browser.e2e.ts | 0 | 1 | 2 |
| message-ledger.browser.e2e.ts | 0 | 1 | 2 |
| optimistic-spawn-attach.browser.e2e.ts | 0 | 1 | 2 |
| optimistic-spawn.browser.e2e.ts | 0 | 1 | 2 |
| outbox-dead-letter.browser.e2e.ts | 0 | 1 | 2 |
| phone-dead-message-replay.browser.e2e.ts | 1 | 1 | 1 |
| phone-session-layout.browser.e2e.ts | 0 | 1 | 2 |
| queued-chat.browser.e2e.ts | 0 | 1 | 2 |
| quota.browser.e2e.ts | 1 | 1 | 1 |
| richer-file-browser.browser.e2e.ts | 0 | 1 | 2 |
| session-attribution-sidebar.browser.e2e.ts | 0 | 1 | 2 |
| settings-telegram.browser.e2e.ts | 0 | 1 | 2 |
| settings.browser.e2e.ts | 5 | 1 | 12 |
| sidebar-drag-reorder.browser.e2e.ts | 0 | 1 | 2 |
| sidebar-error-state.browser.e2e.ts | 0 | 1 | 2 |
| sidebar-order-geometry.browser.e2e.ts | 0 | 1 | 2 |
| startup-silence.browser.e2e.ts | 0 | 1 | 2 |
| status-strip-history.browser.e2e.ts | 0 | 1 | 2 |
| terminal-sizing.browser.e2e.ts | 0 | 1 | 2 |
| transcript-incarnation.browser.e2e.ts | 0 | 1 | 2 |
| workflows.browser.e2e.ts | 0 | 1 | 2 |
| worklist-slice-consumers.browser.e2e.ts | 0 | 1 | 2 |
| automations.browser.e2e.ts | 2 | 0 | 4 |
| browser-open-forwarding.browser.e2e.ts | 1 | 0 | 2 |
| codex-identity-real.browser.e2e.ts | 0 | 0 | 3 |
| experimental-update-controls.browser.e2e.ts | 1 | 0 | 2 |
| expo-pull-refresh.browser.e2e.ts | 1 | 0 | 2 |
| handoff-menu.browser.e2e.ts | 0 | 0 | 3 |
| input.browser.e2e.ts | 1 | 0 | 2 |
| markdown-preview.browser.e2e.ts | 1 | 0 | 2 |
| mission-gauge-shedding.browser.e2e.ts | 1 | 0 | 2 |
| native-desktop-chrome.browser.e2e.ts | 3 | 0 | 6 |
| native-login.browser.e2e.ts | 0 | 0 | 3 |
| pod-2920-queue-position.browser.e2e.ts | 0 | 0 | 3 |
| pod1153-cold-deck.browser.e2e.ts | 1 | 0 | 2 |
| pod1595-failure-paths.browser.e2e.ts | 0 | 0 | 12 |
| pod1595-recording.browser.e2e.ts | 0 | 0 | 3 |
| pod1595-send-state.browser.e2e.ts | 0 | 0 | 6 |
| pod1733-interrupt-recording.browser.e2e.ts | 0 | 0 | 6 |
| relay.browser.e2e.ts | 0 | 0 | 18 |
| screening-card-swipe.browser.e2e.ts | 1 | 0 | 2 |
| session-pane-links.browser.e2e.ts | 1 | 0 | 2 |
| settings-surfaces.browser.e2e.ts | 6 | 0 | 21 |
| short-session-id-links.browser.e2e.ts | 4 | 0 | 8 |
| ux-batch-real.browser.e2e.ts | 0 | 0 | 9 |

## Quarantine

Quarantine is for suites that **cannot** run — a real agent CLI, machine-specific
state, a live daemon, a dependency CI cannot provide. "Flaky" and "broken" are not
quarantine reasons: a suite that runs and fails belongs in the census as a failure.
Quarantining a red suite turns this lane back into the thing it replaced.
