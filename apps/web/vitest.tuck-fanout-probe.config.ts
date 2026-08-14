import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['@podium/source'],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/perf/tuck-fanout.probe.tsx'],
    reporters: ['verbose'],
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
