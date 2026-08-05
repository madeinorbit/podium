/**
 * ONE REACT, CHECKED BEFORE THE FIRST RENDER (POD-405).
 *
 * `vitest.config.ts` points the app's `react` import at the workspace root's copy so
 * the component under test and `@testing-library/react` share a module instance. That
 * alias only rewrites what VITE resolves. `react-native-web` is externalized CJS: it
 * `require`s `react` through Node, and gets whichever copy its own `node_modules`
 * offers. A checkout whose install has drifted to a per-package layout hands it a
 * SECOND React, and then the very first `<View>` calls `useContext` on a module whose
 * dispatcher was never installed:
 *
 *   TypeError: Cannot read properties of null (reading 'useContext')
 *
 * That message names react-native-web and a hook, so it reads as a bug in the
 * component under test. It is not — it is the checkout, and no edit to the component
 * or to this lane's config will move it. This preflight makes the same condition say
 * so, with the command that fixes it.
 */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)

/** Where `pkg`'s own `require('react')` lands, as a real path. */
const reactSeenBy = (pkg: string): string =>
  realpathSync(require.resolve('react', { paths: [dirname(require.resolve(pkg))] }))

/**
 * The two sides that have to agree: the harness that renders, and the library every
 * mobile component is built out of. Ask `@testing-library/react` rather than
 * `react-dom` — the app declares its own `react-dom` at a different version, so a
 * question asked from this directory answers for the app, not for the renderer that
 * actually drives the test.
 */
export const assertOneReact = (harness: string, components: string): void => {
  if (harness === components) return
  throw new Error(
    'Two copies of React in this checkout — the mobile unit lane cannot render.\n' +
      `  @testing-library/react resolves: ${harness}\n` +
      `  react-native-web resolves:       ${components}\n` +
      'Fix the checkout, not this config or the component: run `bun install` at the\n' +
      'workspace root. bunfig.toml pins `linker = "hoisted"`, which keeps a single\n' +
      'React above react-native-web; a drifted per-package layout gives it its own.\n' +
      'See apps/mobile/test/one-react.ts.',
  )
}

assertOneReact(reactSeenBy('@testing-library/react'), reactSeenBy('react-native-web'))
