import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'

// Web-local vitest config. The repo-root vitest.config.ts excludes **/.claude/**,
// and this worktree lives under .claude/worktrees/, so the root config would
// silently skip every test here. This config runs the web suite under happy-dom.

const sharedSetupFiles = sharedVitestConfig.test.setupFiles.map((file) =>
  fileURLToPath(new URL(`../../${file}`, import.meta.url)),
)
// Keep package subpaths on their exports maps; the root's bare aliases would
// prefix-rewrite `/browser` or `/terminal-view` onto `index.ts`.

const sharedAliases = sharedVitestConfig.resolve.alias.filter(
  ({ find }) => find !== '@podium/terminal-client' && find !== '@podium/transcript',
)

export default defineConfig({
  resolve: {
    ...sharedVitestConfig.resolve,
    alias: [
      {
        find: /^@\/features\/chat\/TranscriptFeedBoundary$/,
        replacement: fileURLToPath(
          new URL('./src/features/chat/TranscriptFeedBoundary.vitest.ts', import.meta.url),
        ),
      },
      ...sharedAliases,
    ],
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
