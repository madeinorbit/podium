/**
 * POD-4445 — production build for the round-two browser pages. One entry per
 * arm plus the legacy control, each mounting over a kernel seeded at the
 * `?scale=` corpus (1/2/4) and exposing `window.__proto` for the driver
 * (`harness/browser/run.ts`).
 *
 * Per-arm entries keep bundles isolated (the §1a bundle budget is per arm).
 * The hand/mobx/tanstack entries are PENDING stubs until their H issues land;
 * the build covers all entries so a broken stub fails the gate, never the
 * measurement run (the driver skips `ready:false` pages loudly).
 *
 * Build (a heavy operation — run through the heavy-test lease):
 *   bun scripts/test-heavy.ts -- bunx vite build --config packages/worklist-proto/harness/web/vite.config.ts
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const entry = (name: string): string =>
  fileURLToPath(new URL(`./entries/${name}.html`, import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: {
    // Workspace sources, never dist (the proto package has no dist).
    conditions: ['@podium/source'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        control: entry('control'),
        hand: entry('hand'),
        mobx: entry('mobx'),
        tanstack: entry('tanstack'),
      },
    },
  },
})
