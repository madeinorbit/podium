import { defineConfig } from 'vitest/config'
import { nodeTestExclude, sharedVitestConfig } from './vitest.config'

const agentSmokeTests = [
  '**/*.smoke.test.{ts,tsx}',
  'packages/agent-bridge/test/pty-behavior/claude-smoke.test.ts',
  'apps/daemon/src/codex-hooks.test.ts',
  'packages/agent-bridge/src/opencode/cli.test.ts',
  'packages/agent-bridge/src/cursor/cli.test.ts',
]

/** Explicit, potentially networked/credentialed real-agent smoke scope. */
export default defineConfig({
  resolve: sharedVitestConfig.resolve,
  test: {
    name: 'node',
    ...sharedVitestConfig.test,
    passWithNoTests: true,
    include: agentSmokeTests,
    exclude: nodeTestExclude,
    // Deliberately NO `env: { PODIUM_REAL_CLI: '1' }` here: vitest's test.env writes into
    // worker process.env before test files load, so setting it in the config would defeat
    // the opt-in gate and launch real agent CLIs (billing quota) on a bare
    // `vitest run --config vitest.agent-smoke.config.ts`. The opt-in comes from the shell:
    // `bun run test:smoke:agents` sets PODIUM_REAL_CLI=1 explicitly.
    retry: 0,
  },
})
