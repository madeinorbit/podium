/**
 * POD-4445 — production build for the round-two browser pages. One entry per
 * arm plus the legacy control, each mounting over a kernel seeded at the
 * `?scale=` corpus (1/2/4) and exposing `window.__proto` for the driver
 * (`harness/browser/run.ts`).
 *
 * Per-arm entries keep bundles isolated (the §1a bundle budget is per arm).
 * The hand/mobx entries were PENDING stubs until their H issues landed;
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
    alias: [
      // The control's native list imports `react-native`, whose Flow source
      // no bundler here parses. The dynamic chunk Rollup builds for it must
      // resolve the same `react-native-web` mapping the unit renderer and
      // `expo export -p web` use; the chunk is never loaded by these pages.
      {
        find: /^react-native$/,
        replacement: fileURLToPath(
          new URL('../../node_modules/react-native-web/dist/index.js', import.meta.url),
        ),
      },
      // Commit logging rides React.Profiler, whose onRender is a no-op in a
      // production react-dom-client (every browser page logged zero commits
      // on all arms while counts stayed exact). The profiling bundle
      // re-enables it; all pages share it, so walls stay comparable.
      //
      // Alias ONLY react-dom/client, never bare react-dom: the profiling CJS
      // requires bare react-dom for its shared internals at module init. A
      // prior alias matching both re-resolved that inner require to the
      // profiling bundle itself (a CJS cycle), leaving
      // __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
      // undefined and breaking page boot with a TypeError at init. Every
      // proto source imports createRoot from react-dom/client and nothing
      // from bare react-dom, so the client-only alias covers all pages while
      // the inner require keeps resolving to the normal main bundle.
      {
        find: /^react-dom\/client$/,
        replacement: fileURLToPath(
          new URL('../../node_modules/react-dom/profiling.js', import.meta.url),
        ),
      },
    ],
  },
  build: {
    // POD-4747: `PROTO_LAYERS=1` builds the layer-split pages
    // (`harness/browser/layers.ts`) unminified into `dist-layers`, so a heap
    // snapshot names every class by its source name. Timing always serves
    // `dist`.
    outDir: process.env['PROTO_LAYERS'] === '1' ? 'dist-layers' : 'dist',
    minify: process.env['PROTO_LAYERS'] !== '1',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        control: entry('control'),
        hand: entry('hand'),
        mobx: entry('mobx'),
        // POD-4825: the MobX pool with its write layer, idle and with pending edits.
        'mobx-write': entry('mobx-write'),
        'mobx-pending': entry('mobx-pending'),
        // POD-4558: the instrument floor (an arm that does nothing).
        noop: entry('noop'),
      },
    },
  },
})
