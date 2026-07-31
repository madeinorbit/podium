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

- Lane: `bun run test:browser` → `scripts/browser-lane.ts`
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

The config (`tests/e2e/playwright.config.ts`) is used **unchanged**. Two things had
to live in the runner instead:

1. **Building the workspace packages.** The test process imports `@podium/protocol`
   without the `@podium/source` condition, so it resolves to `dist`, which imports
   `@podium/model`'s `dist`. The config's `webServer` builds protocol + web for the
   *server*; nothing built what the *test process* loads. On a fresh checkout every
   suite dies with `Cannot find module …/packages/model/dist/index.js`.
2. **Probing imports per suite.** Playwright aborts the entire run when a single
   file fails to import — `Total: 0 tests in 0 files`, and no census at all. The
   runner probes first (fast, no browser), names the unloadable suites as ERRORED,
   and runs the rest, so one rotten import cannot hide the state of the other 69.

<!-- CENSUS RESULTS -->

## Quarantine

Quarantine is for suites that **cannot** run — a real agent CLI, machine-specific
state, a live daemon, a dependency CI cannot provide. "Flaky" and "broken" are not
quarantine reasons: a suite that runs and fails belongs in the census as a failure.
Quarantining a red suite turns this lane back into the thing it replaced.
