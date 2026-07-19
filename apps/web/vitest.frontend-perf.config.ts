import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Hermetic large-state frontend performance lane (POD-999).
 *
 * This is deliberately separate from the default web unit suite: it renders a
 * Ludovico-scale Tasks board and exercises whole-replica/derivation paths. CI
 * runs it explicitly, with one worker and no retries so its operation budgets
 * remain deterministic and failures cannot be hidden as timing weather.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['@podium/source'],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/perf/large-state.frontend-perf.tsx'],
    reporters: ['verbose'],
    passWithNoTests: false,
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
