import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Web-local vitest config. The repo-root vitest.config.ts excludes **/.claude/**,
// and this worktree lives under .claude/worktrees/, so the root config would
// silently skip every test here. This config runs the web suite under happy-dom.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['@podium/source'],
    // apps/mobile pins react-dom 19.2.3, which bun hoists to the repo root;
    // dedupe makes every import resolve the web app's react-dom 19.2.7.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    passWithNoTests: false,
  },
})
