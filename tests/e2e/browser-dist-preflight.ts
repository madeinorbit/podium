/**
 * Fail-fast gate when Playwright starts without a prior lane build (POD-535).
 *
 * webServer no longer builds packages — that lives in scripts/browser-lane.ts.
 * Prefer `bun run test:browser -- --suite <stem>` (POD-536). Hand-runs that
 * bypass the lane must call `--build-only` first. Without this check the test
 * process dies on `Cannot find module …/packages/model/dist/index.js` with no
 * pointer to the fix.
 *
 * Used as the first half of playwright.config webServer.command.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Artefacts the test process and harness-served UI need. Mobile is optional
 *  (phone projects fall back to desktop shell when absent). */
const REQUIRED = [
  'packages/model/dist/index.js',
  'packages/protocol/dist/index.js',
  'apps/web/dist/index.html',
] as const

const missing = REQUIRED.filter((rel) => !existsSync(join(ROOT, rel)))
if (missing.length > 0) {
  console.error(
    [
      'browser e2e: package/web dist is missing — webServer no longer builds it (POD-535).',
      'Missing:',
      ...missing.map((m) => `  - ${m}`),
      '',
      'Preferred (builds + selects inside the lane):',
      '  bun run test:browser -- --suite <stem> --project=chromium-pixel',
      '',
      'Hand-run bypass (build then playwright):',
      '  bun scripts/browser-lane.ts --build-only',
      '  bunx playwright test --config tests/e2e/playwright.config.ts --project=chromium-pixel <suite>',
      '',
      'Full lane (builds + all suites):',
      '  bun run test:browser',
    ].join('\n'),
  )
  process.exit(1)
}
