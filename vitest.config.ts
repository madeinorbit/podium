import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@podium/agent-bridge': fileURLToPath(
        new URL('./packages/agent-bridge/src/index.ts', import.meta.url),
      ),
      '@podium/protocol': fileURLToPath(
        new URL('./packages/protocol/src/index.ts', import.meta.url),
      ),
      '@podium/terminal-client': fileURLToPath(
        new URL('./packages/terminal-client/src/index.ts', import.meta.url),
      ),
    },
    conditions: ['@podium/source'],
  },
  test: {
    passWithNoTests: true,
  },
})
