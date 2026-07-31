/**
 * Browser-lane quarantine [POD-1227] — suites the lane does NOT run, with a
 * reason each.
 *
 * Its own module, and not a `testIgnore` glob in playwright.config.ts, so the
 * list is greppable, printed on every run, and asserted by
 * scripts/test-configuration.test.ts. A quarantine nobody can see is how 70
 * suites came to run nowhere in the first place.
 *
 * `reason` must name what is MISSING — a real agent CLI, machine-specific
 * state, a live daemon, a browser dependency CI cannot provide. "Flaky" and
 * "broken" are not quarantine reasons: a suite that runs and fails belongs in
 * the census as a failure. Quarantining a red suite turns this lane back into
 * the thing it replaced.
 */
export type QuarantinedSuite = { suite: string; reason: string }

export const QUARANTINE: ReadonlyArray<QuarantinedSuite> = [
  // Empty on purpose after the first census (docs/agents/browser-lane-census.md).
  // The one suite that needs a real agent CLI — codex-identity-real — gates
  // ITSELF on `PODIUM_E2E_REAL_AGENTS`, so it enters the lane and skips; it does
  // not need to be hidden from it. Nothing else was found that cannot run.
]
