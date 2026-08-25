import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Serves the working-mark harness (POD-1259) — NOT an app build.
 *
 * The mobile app builds with Metro, which has no dev server a browser probe can
 * drive cheaply. This is the same mapping `expo export -p web` performs, cut
 * down to what one component needs: react-native → react-native-web, and the
 * platform extension order that lets `react-native-svg` resolve its `.web`
 * entry the way Metro would.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  define: { __DEV__: 'true', 'process.env.NODE_ENV': '"development"' },
  plugins: [react()],
  resolve: {
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      // The composer harness (POD-1659) pulls the real component, which reaches
      // for three Expo modules a plain vite page has no runtime for. Stub the
      // two that only matter on device; safe-area is a hook, so it gets a
      // module rather than a provider tree.
      {
        find: /^expo-blur$/,
        replacement: fileURLToPath(new URL('./harness/stub-expo-blur.tsx', import.meta.url)),
      },
      {
        find: /^expo-haptics$/,
        replacement: fileURLToPath(new URL('./harness/stub-expo-haptics.ts', import.meta.url)),
      },
      {
        find: /^react-native-safe-area-context$/,
        replacement: fileURLToPath(new URL('./harness/stub-safe-area.ts', import.meta.url)),
      },
      {
        find: /^lucide-react-native$/,
        replacement: fileURLToPath(new URL('./harness/stub-lucide.tsx', import.meta.url)),
      },
      // react-native-svg's package entry points at Flow-typed native source
      // (its `react-native` export condition), which nothing here can parse,
      // and its web barrel re-exports an XML/uri layer with its own tangles.
      // The mark needs two elements; name the web element module outright.
      {
        find: /^react-native-svg$/,
        replacement: fileURLToPath(
          new URL(
            '../../node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js',
            import.meta.url,
          ),
        ),
      },
      // ONE COPY OF REACT, AND IT HAS TO BE THE ROOT'S — the same trap the unit
      // lane documents (vitest.config.ts): the root and apps/mobile resolve
      // different Reacts, and two copies means "Invalid hook call" from a
      // component that is fine. Exact-match regexes: a bare `react` alias is a
      // PREFIX match and would rewrite `react-dom/client` with it.
      {
        find: /^react$/,
        replacement: fileURLToPath(new URL('../../node_modules/react', import.meta.url)),
      },
      {
        find: /^react-dom$/,
        replacement: fileURLToPath(new URL('../../node_modules/react-dom', import.meta.url)),
      },
      {
        find: /^react-dom\/client$/,
        replacement: fileURLToPath(new URL('../../node_modules/react-dom/client', import.meta.url)),
      },
    ],
  },
  // Nothing in this graph may reach React Native's Flow-typed source. The
  // aliases above redirect every native package the composer touches; excluding
  // them from prebundling keeps the optimizer from resolving the originals.
  optimizeDeps: {
    exclude: [
      'expo-blur',
      'expo-haptics',
      'lucide-react-native',
      'react-native-safe-area-context',
      'react-native-svg',
    ],
  },
  server: { port: 8091, strictPort: true },
})
