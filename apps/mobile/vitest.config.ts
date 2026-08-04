import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The mobile unit lane (POD-1220).
 *
 * IT DID NOT EXIST BEFORE, and the two tests that ran without it were pure logic
 * modules importing nothing from the workspace — so the absence was invisible
 * rather than fine. The first test that imports a composition root needs all
 * three of these:
 *
 *   `conditions` / `ssr.resolve.conditions` — `@podium/*` packages expose their
 *     sources under the `@podium/source` export condition and their built `dist`
 *     otherwise. Without it every workspace import fails to resolve, and the
 *     error names the package rather than the missing condition.
 *
 *   the `react-native` alias — React Native ships Flow-typed source that no
 *     bundler here can parse. `react-native-web` is already a dependency (it is
 *     what `expo export -p web` builds against), so the alias runs the same
 *     mapping the web build does rather than inventing a test-only stub.
 *
 *   `happy-dom` — react-native-web touches `document` at import time.
 *
 *   the `expo-sqlite` alias — it pulls `expo-modules-core`, which reads the
 *     native `globalThis.expo` at module scope. Nothing under test reaches it
 *     (`openMobileReplica` takes the database as an argument), and the stub
 *     throws so that stops being true loudly rather than quietly.
 *
 *   `__DEV__` — expo's runtime reads Metro's global at module scope. `false` is
 *     the honest value: a test run is not a Metro dev server.
 */
const conditions = ['@podium/source']

export default defineConfig({
  define: { __DEV__: 'false' },
  resolve: {
    conditions,
    // Platform suffixes, as Metro and `expo export -p web` resolve them. A
    // screen that imports `../terminal/TerminalPane` has only `.native.tsx` and
    // `.web.tsx` on disk; without this the import is unresolvable and the
    // failure names the module rather than the missing extension list.
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.jsx', '.js', '.json'],
    alias: [
      { find: 'react-native', replacement: 'react-native-web' },
      {
        find: 'expo-sqlite',
        replacement: fileURLToPath(new URL('./test/expo-sqlite-absent.ts', import.meta.url)),
      },
      // ONE COPY OF REACT, AND IT HAS TO BE THE ROOT'S.
      //
      // The workspace root and `apps/mobile` resolve different React versions,
      // and `@testing-library/react` lives at the ROOT — externalized CJS, so a
      // vite alias never rewrites what it requires. Left alone, a component test
      // renders with the root's React while the component under test calls the
      // app's, and every hook throws "Invalid hook call" — a failure about the
      // harness that reads exactly like a failure about the component.
      //
      // So the app's imports are pointed at the root copy rather than the other
      // way round. The exact-match regexes matter: a bare `'react'` alias is a
      // PREFIX match and would rewrite `react-dom/client` and
      // `react/jsx-runtime` with it.
      {
        find: /^react$/,
        replacement: fileURLToPath(new URL('../../node_modules/react', import.meta.url)),
      },
      {
        find: /^react-dom$/,
        replacement: fileURLToPath(new URL('../../node_modules/react-dom', import.meta.url)),
      },
    ],
  },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: false,
    // Match the repo-wide cap; this config is intentionally standalone.
    maxWorkers: 2,
  },
})
