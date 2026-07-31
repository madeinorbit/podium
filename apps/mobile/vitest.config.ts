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
    alias: {
      'react-native': 'react-native-web',
      'expo-sqlite': fileURLToPath(new URL('./test/expo-sqlite-absent.ts', import.meta.url)),
    },
  },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: false,
  },
})
