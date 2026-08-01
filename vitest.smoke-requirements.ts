/** Smoke suites classified by the external resource they actually require. */
export const ptySmokeTests = ['apps/daemon/src/composer-sync.smoke.test.ts'] as const

export const realAgentSmokeTests = [
  'apps/daemon/src/harness-exec.smoke.test.ts',
  'apps/daemon/src/headless-drivers.smoke.test.ts',
  'apps/daemon/src/superagent-brevity.smoke.test.ts',
] as const
