/**
 * ONE REACT, CHECKED BEFORE THE FIRST RENDER (POD-405).
 *
 * `vitest.config.ts` points transformed app and workspace imports at apps/mobile's
 * React. The externalized renderer, react-dom, and react-native-web must resolve that
 * same module instance. If one of them sees another copy, the first hook reads a
 * dispatcher that its renderer never installed:
 *
 *   TypeError: Cannot read properties of null (reading 'useContext')
 *
 * That message names the component and hook even though the dependency graph is at
 * fault. This preflight names every disagreeing owner before the first render.
 */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)

/** Where `pkg`'s own `require('react')` lands, as a real path. */
const reactSeenBy = (pkg: string): string =>
  realpathSync(require.resolve('react', { paths: [dirname(require.resolve(pkg))] }))

/** Where transformed mobile source is required to land. */
const mobileReact = realpathSync(require.resolve('react'))

/**
 * Ask every externalized consumer from its own package directory. Resolving React
 * only from this setup file would answer for the app, not for each package's peer
 * graph.
 */
export const assertOneReact = (
  app: string,
  harness: string,
  renderer: string,
  components: string,
): void => {
  if (app === harness && harness === renderer && renderer === components) return
  throw new Error(
    'Two copies of React in this checkout — the mobile unit lane cannot render.\n' +
      `  mobile app resolves:            ${app}\n` +
      `  @testing-library/react resolves: ${harness}\n` +
      `  react-dom resolves:              ${renderer}\n` +
      `  react-native-web resolves:       ${components}\n` +
      'Repair this checkout with `bun run deps:repair`. bunfig.toml and the mobile\n' +
      'Vitest aliases own the isolated package graph; do not patch the component.\n' +
      'See apps/mobile/test/one-react.ts.',
  )
}

assertOneReact(
  mobileReact,
  reactSeenBy('@testing-library/react'),
  reactSeenBy('react-dom'),
  reactSeenBy('react-native-web'),
)
