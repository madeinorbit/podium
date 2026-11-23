/** Smoke suites classified by the external resource they actually require. */
export const ptySmokeTests: readonly string[] = []

export const realAgentSmokeTests = [
  'apps/daemon/src/harness-exec.smoke.test.ts',
  'apps/daemon/src/headless-turns.smoke.test.ts',
] as const
