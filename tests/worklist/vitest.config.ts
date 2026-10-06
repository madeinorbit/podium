import { productWorkMeter } from './harness/src/perf/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'
import { unitTestExclude } from '../../vitest.unit.config'

// Package-local vitest config, following the apps/web happy-dom pattern
// (apps/web/vitest.config.ts): the arms mount real row components, so this
// lane runs under happy-dom. Resolution, setup and exclusions stay identical
// to the root unit lane. `test:file` routes package files to the root node
// lane instead; this config is for the package's own `test` script.
const sharedSetupFiles = sharedVitestConfig.test.setupFiles.map((file) =>
  fileURLToPath(new URL(`../../${file}`, import.meta.url)),
)

export default defineConfig({
  plugins: [productWorkMeter()],
  resolve: {
    ...sharedVitestConfig.resolve,
    alias: [
      ...sharedVitestConfig.resolve.alias,
      // The React Native unit renderer: `react-native` ships Flow-typed
      // source this lane cannot parse, so native modules resolve to
      // `react-native-web` — the same mapping `expo export -p web` builds
      // against and the one `apps/mobile/vitest.config.ts` uses. Only the
      // G4 native lane (`harness/native/`) imports `react-native`.
      {
        find: /^react-native$/,
        replacement: fileURLToPath(new URL('./node_modules/react-native-web', import.meta.url)),
      },
    ],
  },
  test: {
    ...sharedVitestConfig.test,
    setupFiles: sharedSetupFiles,
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'shared/**/*.test.{ts,tsx}', 'arms/**/*.test.{ts,tsx}', 'harness/**/*.test.{ts,tsx}', 'diagnostics/**/*.test.{ts,tsx}', 'product/**/*.test.{ts,tsx}', 'legacy-values/**/*.test.{ts,tsx}', 'replays/**/*.test.{ts,tsx}'],
    exclude: unitTestExclude,
    passWithNoTests: true,
    retry: 0,
    server: {
      deps: {
        // Keep the web renderer inside Vite's transform pipeline (with the
        // alias above) instead of letting Node require it externalized.
        inline: ['react-native-web'],
      },
    },
  },
})
