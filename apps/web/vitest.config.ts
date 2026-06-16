import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Web-local vitest config. The repo-root vitest.config.ts excludes **/.claude/**,
// and this worktree lives under .claude/worktrees/, so the root config would
// silently skip every test here. This config runs the web suite under happy-dom.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['@podium/source'],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: false,
  },
})
