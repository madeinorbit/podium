import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'
import {
  resolveMobileFile,
  resolveMobilePackage,
  resolveRootPackage,
  resolveThroughMobileDep,
} from './resolve-package'

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
 *     THE ALIAS ONLY REACHES CODE VITE TRANSFORMS (POD-1429). Third-party React
 *     Native packages under `node_modules` are externalized as CommonJS and
 *     `require`d by Node directly, so their own `require('react-native')` is
 *     resolved by Node — it lands on React Native's Flow source, and the file
 *     that names the failure is never the one under test: Node reports a bare
 *     `SyntaxError: Unexpected token 'typeof'` at import, before a single test
 *     is collected. Node also has no notion of Metro's `.web.js` platform
 *     suffix, so even a package that ships a DOM implementation loads its
 *     native one.
 *
 *     There are two ways out, and which one is right depends on whether the
 *     package belongs in the graph at all. A package the app genuinely renders
 *     comes back INSIDE vite — `server.deps.inline` plus an alias onto its web
 *     entry, as `react-native-svg` does below. A package
 *     that is only there because a leaf imported a composition root to read one
 *     context should not be in the graph in the first place: the context moves
 *     to its own module (`./launch-ready`, `./server-profile-context`) and the
 *     leaf imports that instead. `readiness-gate.test.tsx` needs no stubs at all
 *     for exactly that reason — if stubs reappear there, the split has regressed.
 *
 *   `happy-dom` — react-native-web touches `document` at import time.
 *
 *   the `expo-symbols` alias — glyph rendering is a native boundary while these
 *   tests exercise the controls around it. A fixed-size View preserves layout
 *   without loading Expo's native module or its web font.
 *
 *   `__DEV__` — expo's runtime reads Metro's global at module scope. `false` is
 *     the honest value: a test run is not a Metro dev server.
 */
const conditions = sharedVitestConfig.resolve.conditions
const sharedSetupFiles = sharedVitestConfig.test.setupFiles.map((file) =>
  fileURLToPath(new URL(`../../${file}`, import.meta.url)),
)
// The root `@` alias points at web, and terminal-client's bare alias breaks subpaths.
// Keep only shared aliases that are safe for mobile before adding app-specific mappings.
const sharedAliases = sharedVitestConfig.resolve.alias.filter(
  ({ find }) => find !== '@' && find !== '@podium/terminal-client',
)

export default defineConfig({
  define: { __DEV__: 'false' },
  resolve: {
    ...sharedVitestConfig.resolve,
    // Platform suffixes, as Metro and `expo export -p web` resolve them. A
    // screen that imports `../terminal/TerminalPane` has only `.native.tsx` and
    // `.web.tsx` on disk; without this the import is unresolvable and the
    // failure names the module rather than the missing extension list.
    extensions: [
      '.web.tsx',
      '.web.ts',
      '.web.jsx',
      '.web.js',
      '.tsx',
      '.ts',
      '.jsx',
      '.js',
      '.json',
    ],
    alias: [
      ...sharedAliases,
      // An ABSOLUTE replacement, because this rewrite also fires for inlined
      // third-party code (react-native-svg below), whose files live in the
      // isolated linker's store — a bare `react-native-web` would be resolved
      // relative to THAT directory, where it is not a dependency (POD-3174).
      { find: 'react-native', replacement: resolveMobilePackage('react-native-web') },
      {
        find: /^expo-symbols$/,
        replacement: fileURLToPath(new URL('./test/expo-symbols.tsx', import.meta.url)),
      },
      // react-native-svg publishes native CJS as its Node entrypoint. Its web
      // build is the same implementation Expo's web bundler selects, and an
      // absolute replacement keeps its imports inside Vite's alias pipeline.
      // Resolved from apps/mobile, which declares it — under the isolated
      // linker it is not at the workspace root at all (see resolve-package.ts).
      // react-native-svg's web build reaches for React Native's asset registry
      // without declaring it — a hoisted install made that work by accident.
      {
        find: /^@react-native\/assets-registry\/registry$/,
        replacement: resolveThroughMobileDep(
          'react-native',
          '@react-native/assets-registry/registry',
        ),
      },
      {
        find: /^react-native-svg$/,
        replacement: resolveMobileFile('react-native-svg/lib/module/ReactNativeSVG.web.js'),
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
      { find: /^react$/, replacement: resolveRootPackage('react') },
      { find: /^react-dom$/, replacement: resolveRootPackage('react-dom') },
    ],
  },
  ssr: { resolve: { conditions } },
  test: {
    ...sharedVitestConfig.test,
    server: {
      deps: {
        // Native packages commonly publish CJS entrypoints whose internal
        // `require('react-native')` calls bypass Vite aliases when externalized.
        // Keep the native dependency boundary in Vite so the react-native-web
        // alias and `.web.*` resolution above apply transitively. Otherwise
        // react-native-svg reaches RN's Flow-typed index.js and Node fails on
        // its `import typeof` declaration.
        inline: ['react-native-svg'],
      },
    },
    // `one-react.ts` last: it turns a drifted checkout into a message that names the
    // fix, instead of react-native-web's `useContext` of null. See that file.
    setupFiles: [
      ...sharedSetupFiles,
      fileURLToPath(new URL('./test/one-react.ts', import.meta.url)),
    ],
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'plugins/**/*.test.ts'],
    passWithNoTests: false,
  },
})
