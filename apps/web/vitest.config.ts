import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'

// Web-local vitest config. The repo-root vitest.config.ts excludes **/.claude/**,
// and this worktree lives under .claude/worktrees/, so the root config would
// silently skip every test here. This config runs the web suite under happy-dom.

const sharedSetupFiles = sharedVitestConfig.test.setupFiles.map((file) =>
  fileURLToPath(new URL(`../../${file}`, import.meta.url)),
)
// Keep terminal-client subpaths on the package exports map; the root's bare alias would
// prefix-rewrite `@podium/terminal-client/terminal-view` to `index.ts/terminal-view`.

const sharedAliases = sharedVitestConfig.resolve.alias.filter(
  ({ find }) => find !== '@podium/terminal-client',
)

export default defineConfig({
  resolve: {
    ...sharedVitestConfig.resolve,
    alias: sharedAliases,
    // apps/mobile pins react-dom 19.2.3, which bun hoists to the repo root;
    // dedupe makes every import resolve the web app's react-dom 19.2.7.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    ...sharedVitestConfig.test,
    setupFiles: sharedSetupFiles,
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    passWithNoTests: false,
  },
})
